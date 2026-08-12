import { randomUUID } from "crypto";
import type {
  AgentAdapter,
  ConfigurableAdapter,
  AgentResult,
  TaskContext,
  ExternalChangeId,
  AdapterContainerSpec,
  PromptStore,
  ReviewWorkspaceInput,
  WorkspaceRunner,
} from "../interfaces.js";
import { makeExternalChangeId } from "../interfaces.js";
import { getLogger } from "../logger.js";
import { assertPromptRole } from "../utils/promptRole.js";
import { buildCodegenUserPrompt } from "./copilotAdapter.js";
import { opencodeEgress } from "./backendEgress.js";
import {
  buildCodegenContainerSpec,
  buildReviewContainerSpec as buildSharedReviewContainerSpec,
  systemPromptEnv,
  egressOption,
} from "./containerSpecBuilders.js";
import { createStderrPipeline } from "./agentStderrPipeline.js";
import type { StderrParseState } from "./agentStderrPipeline.js";

const log = getLogger("opencode-adapter");

/**
 * Map OpenCode `providerOptions` onto the `OPENCODE_*` env vars the CLI reads.
 *  - `variant` — model variant / reasoning-effort passed via `opencode run --variant`.
 */
function opencodeOptionEnv(options: Record<string, unknown> | undefined): Record<string, string> {
  if (!options) return {};
  const variant = options["variant"];
  return typeof variant === "string" && variant.trim() ? { OPENCODE_VARIANT: variant.trim() } : {};
}

export interface OpenCodeAdapterConfig {
  /**
   * Optional model override. When omitted, the adapter injects no
   * `OPENCODE_MODEL` and the OpenCode CLI selects its own default model — the
   * default is owned by the CLI, not hardcoded here.
   */
  model?: string | undefined;
  maxRepositoryContextBytes: number;
  maxCommitsPerCycle: number;
  promptsDir?: string | undefined;
}

interface DockerInvocationResult {
  stdout: string;
  stderr: string;
}

interface DockerInvocationCallbacks {
  onStdoutChunk?: ((chunk: string) => void) | undefined;
  onStderrChunk?: ((chunk: string) => void) | undefined;
}

type DockerInvoker = (
  context: TaskContext,
  authEnv?: Record<string, string>,
  callbacks?: DockerInvocationCallbacks
) => Promise<DockerInvocationResult>;

const DEFAULT_CONFIG: OpenCodeAdapterConfig = {
  maxRepositoryContextBytes: 120_000,
  maxCommitsPerCycle: 10,
};

/** OpenCode LLM provider selector values (mirrors the descriptor zod enum; same set as Goose's). */
export type OpenCodeProvider =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "ollama"
  | "deepseek"
  | "groq"
  | "gemini"
  | "azure_openai"
  | "bedrock"
  | "perplexity"
  | "mistral"
  | "xai"
  | "cerebras"
  | "openai_compat";

const DEFAULT_OLLAMA_BASE = "http://127.0.0.1:11434";

/**
 * Runs code-generation / review via an OpenShell agent sandbox using the
 * OpenCode CLI (https://opencode.ai) (`agent-worker/src/index.ts` dispatches to
 * the OpenCode runner when `AGENT_PROVIDER=opencode`). Like Goose, OpenCode
 * wraps any LLM provider; the host injects the selected provider's auth env
 * vars. The host owns clone, commit, and push.
 */
export class OpenCodeAdapter implements AgentAdapter, ConfigurableAdapter {
  readonly name = "opencode";

  private readonly config: OpenCodeAdapterConfig;
  private dockerInvoker?: DockerInvoker;
  private promptStore?: PromptStore;

  constructor(config: Partial<OpenCodeAdapterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Inject the Docker invocation function (used in production and tests). */
  setDockerInvoker(dockerInvoker: DockerInvoker): void {
    this.dockerInvoker = dockerInvoker;
  }

  /** Inject the prompt store used to resolve system and instructions prompts. */
  setPromptStore(promptStore: PromptStore): void {
    this.promptStore = promptStore;
  }

  /** Wire the adapter to its runtime dependencies (ConfigurableAdapter). */
  configure(deps: { store: PromptStore; runner: WorkspaceRunner }): void {
    this.setPromptStore(deps.store);
    if (deps.runner.runAgentInDocker !== undefined) {
      this.setDockerInvoker((context, authEnv, callbacks) =>
        deps.runner.runAgentInDocker!(this, context, authEnv, callbacks)
      );
    }
  }

  /** Resolve auth, build prompts, run the agent container, and return the parsed result. */
  async execute(context: TaskContext): Promise<AgentResult> {
    log.info(
      { taskId: context.taskId, cycle: context.cycleNumber },
      "opencode adapter: starting execution"
    );

    const authEnv = this.resolveAuthEnv(context);
    const changeId = context.agentSession.existingChangeId ?? this.generateChangeId();

    const result = await this.runAgentContainer(context, authEnv, changeId);

    if (result.status === "success") {
      log.info(
        { taskId: context.taskId, files: result.modifiedFiles?.length ?? 0 },
        "opencode adapter: files written"
      );
    }

    return result;
  }

  /** Build the container spec (image, env, args) for a code-generation cycle. */
  buildContainerSpec(
    context: TaskContext,
    authEnv: Record<string, string> = {}
  ): AdapterContainerSpec {
    const session = context.agentSession;
    const opencodeModel = session.copilotModel ?? this.config.model;

    // Resolve auth from the session when no explicit authEnv is supplied (e.g.
    // when called directly in tests or by the workspace runner before auth
    // resolution). In the normal execute() path, authEnv is already populated.
    const resolvedAuthEnv =
      Object.keys(authEnv).length > 0 ? authEnv : this.resolveAuthEnv(context);

    const providerEnv: Record<string, string> = {
      ...resolvedAuthEnv,
      AGENT_PROVIDER: "opencode",
      OPENCODE_PROVIDER: session.openCodeProvider ?? "anthropic",
      ...(opencodeModel ? { OPENCODE_MODEL: opencodeModel } : {}),
      ...opencodeOptionEnv(session.providerOptions),
    };

    return buildCodegenContainerSpec(context, {
      providerEnv,
      maxRepositoryContextBytes: this.config.maxRepositoryContextBytes,
      maxCommitsPerCycle: this.config.maxCommitsPerCycle,
      promptsDir: this.config.promptsDir,
      ...egressOption(opencodeEgress(
        session.openCodeProvider,
        session.openCodeApiBase,
        process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"],
      )),
    });
  }

  /** Builds a container spec for review mode (REVIEW_MODE=1). Reads the prompt from the file the runner uploads into the sandbox. */
  buildReviewContainerSpec(
    input: ReviewWorkspaceInput,
    authEnv: Record<string, string> = {}
  ): AdapterContainerSpec {
    const nativeReview = input.reviewStrategy === "opencode_native";
    const reviewModel = nativeReview ? undefined : input.model ?? this.config.model;
    const providerEnv: Record<string, string> = {
      ...this.reviewAuthEnv(input, authEnv),
      AGENT_PROVIDER: "opencode",
      OPENCODE_PROVIDER: input.openCodeProvider ?? "anthropic",
      ...(!nativeReview && reviewModel ? { OPENCODE_MODEL: reviewModel } : {}),
      ...(!nativeReview ? opencodeOptionEnv(input.providerOptions) : {}),
      ...(input.reviewOutputSchema !== undefined
        ? { REVIEW_OUTPUT_SCHEMA: JSON.stringify(input.reviewOutputSchema) }
        : {}),
    };

    return buildSharedReviewContainerSpec(input, {
      providerEnv,
      ...egressOption(opencodeEgress(
        input.openCodeProvider,
        input.openCodeApiBase,
        process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"],
      )),
    });
  }

  /**
   * Resolve the auth env for a review container. An explicit `authEnv` (already
   * mapped to the provider's env var) wins; otherwise the review `agentToken` is
   * mapped per the `openCodeProvider` selector on the input.
   */
  private reviewAuthEnv(
    input: ReviewWorkspaceInput,
    authEnv: Record<string, string>
  ): Record<string, string> {
    if (Object.keys(authEnv).length > 0) {
      return authEnv;
    }
    const provider = (input.openCodeProvider ?? "anthropic") as OpenCodeProvider;
    const token = input.agentToken.trim();
    if (!token && provider !== "ollama" && provider !== "bedrock") {
      return authEnv;
    }
    return opencodeProviderAuthEnv(provider, token, input.openCodeApiBase ?? "");
  }

  /** Extend buildContainerSpec with resolved system and instructions prompt content. */
  async buildContainerSpecWithPrompts(
    context: TaskContext,
    authEnv: Record<string, string> = {}
  ): Promise<AdapterContainerSpec> {
    const spec = this.buildContainerSpec(context, authEnv);
    const promptStore = this.promptStore;

    if (!promptStore) {
      throw new Error("Prompt store is required for agent execution");
    }

    const systemPromptId = context.systemPromptId;
    const instructionsPromptId = context.instructionsPromptId;
    if (!systemPromptId) throw new Error("System prompt is required for agent execution");
    if (!instructionsPromptId) throw new Error("Instructions prompt is required for agent execution");
    const promptIds = [
      ...new Set(
        [systemPromptId, instructionsPromptId].filter(
          (id): id is string => typeof id === "string" && id.length > 0
        )
      ),
    ];
    const prompts = await Promise.all(promptIds.map((id) => promptStore.getPrompt(id)));
    const promptsById = new Map<string, Awaited<ReturnType<PromptStore["getPrompt"]>>>(
      promptIds.map((id, index) => [id, prompts[index] ?? null])
    );
    const systemPrompt =
      typeof systemPromptId === "string" ? promptsById.get(systemPromptId) ?? null : null;
    const instructionsPrompt =
      typeof instructionsPromptId === "string"
        ? promptsById.get(instructionsPromptId) ?? null
        : null;

    if (!systemPrompt) throw new Error(`System prompt '${systemPromptId}' not found`);
    if (!instructionsPrompt) throw new Error(`Instructions prompt '${instructionsPromptId}' not found`);
    assertPromptRole(systemPrompt, "system");
    assertPromptRole(instructionsPrompt, "instructions");

    Object.assign(spec.env, systemPromptEnv(systemPrompt.content));
    spec.userPromptContent = buildCodegenUserPrompt(context, instructionsPrompt.content);

    return spec;
  }

  // ── authentication ────────────────────────────────────────────────────────

  /**
   * Resolve the OpenCode auth environment from the agent session. OpenCode
   * wraps an LLM provider; the provider selector + API key/base URL are
   * forwarded by the orchestrator from the integration config onto the session.
   */
  private resolveAuthEnv(context: TaskContext): Record<string, string> {
    const provider = (context.agentSession.openCodeProvider ?? "anthropic") as OpenCodeProvider;
    const apiKey = context.agentSession.openCodeApiKey?.trim() ?? "";
    const apiBase = context.agentSession.openCodeApiBase?.trim() ?? "";
    if (!apiKey && provider !== "ollama" && provider !== "bedrock") {
      throw new Error(
        "No OpenCode credentials available. Configure an API key for the selected provider in the admin dashboard."
      );
    }
    return opencodeProviderAuthEnv(provider, apiKey, apiBase);
  }

  // ── container runner ──────────────────────────────────────────────────────

  /** Spawn the agent container and return its parsed AgentResult. Worker writes a JSON line to stdout. */
  private async runAgentContainer(
    context: TaskContext,
    authEnv: Record<string, string>,
    changeId: ExternalChangeId
  ): Promise<AgentResult> {
    const stderrPipeline = createStderrPipeline(context, { adapterName: "opencode", log });
    let invocation: DockerInvocationResult;
    try {
      invocation = await this.invokeAgentContainer(context, authEnv, {
        onStderrChunk: (chunk) => {
          stderrPipeline.consumeChunk(chunk);
        },
      });
    } catch (err) {
      stderrPipeline.flush();
      if (stderrPipeline.state.agentEvents.length === 0 && stderrPipeline.state.plainLogLines.length === 0) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      return this.setupFailureResult(message, stderrPipeline.state);
    }
    stderrPipeline.flush();

    const result = this.parseAgentResult(context, invocation.stdout, stderrPipeline.state);

    if (result.commits && result.commits.length > 0) {
      log.info(
        { taskId: context.taskId, commitCount: result.commits.length },
        "opencode adapter: agent returned pre-validated commits"
      );
      if (!result.externalChangeId && result.status === "success") {
        result.externalChangeId = changeId;
      }
      return result;
    }

    if (!result.externalChangeId && result.status === "success") {
      result.externalChangeId = changeId;
    }
    return result;
  }

  private setupFailureResult(message: string, stderrState: StderrParseState): AgentResult {
    const plainLogs = stderrState.plainLogLines.join("\n");
    return {
      status: "failed",
      modifiedFiles: [],
      summary: "Agent setup failed before container output",
      agentLogs: [plainLogs, message].filter(Boolean).join("\n"),
      agentEvents: stderrState.agentEvents,
      metadata: {
        adapter: "opencode",
        setupError: true,
        error: message.slice(0, 300),
      },
    };
  }

  /** Delegate Docker invocation to the registered dockerInvoker, passing auth env. */
  private async invokeAgentContainer(
    context: TaskContext,
    authEnv: Record<string, string>,
    callbacks?: DockerInvocationCallbacks
  ): Promise<DockerInvocationResult> {
    if (!this.dockerInvoker) {
      throw new Error("OpenCodeAdapter requires a docker invoker before execute() can run");
    }
    return this.dockerInvoker(context, authEnv, callbacks);
  }

  /** Parse the JSON AgentResult from stdout and merge collected stderr logs and events. */
  private parseAgentResult(
    context: TaskContext,
    stdout: string,
    parseState: StderrParseState
  ): AgentResult {
    const plainLogs = parseState.plainLogLines.join("\n");

    if (!stdout.trim()) {
      return {
        status: "failed",
        modifiedFiles: [],
        summary: "Agent container crashed before producing output",
        agentLogs: plainLogs,
        agentEvents: parseState.agentEvents,
        metadata: { adapter: "opencode" },
      };
    }

    const lines = stdout.trim().split("\n");
    const lastLine = lines[lines.length - 1] ?? "";
    try {
      const parsed = JSON.parse(lastLine) as AgentResult;
      const mergedLogs = [parsed.agentLogs, plainLogs].filter(Boolean).join("\n");
      return { ...parsed, agentLogs: mergedLogs, agentEvents: parseState.agentEvents };
    } catch {
      log.error(
        { taskId: context.taskId, stdout: stdout.slice(0, 500) },
        "opencode adapter: failed to parse agent container output as JSON"
      );
      return {
        status: "failed",
        modifiedFiles: [],
        summary: "Failed to parse agent container output",
        agentLogs: stdout,
        agentEvents: parseState.agentEvents,
        metadata: { adapter: "opencode", parseError: true },
      };
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** Generate a unique Gerrit-compatible Change-Id string from a random UUID. */
  private generateChangeId(): ExternalChangeId {
    const uuid = randomUUID().replace(/-/g, "");
    return makeExternalChangeId(`I${uuid}${uuid.slice(0, 8)}`);
  }
}

/**
 * Map an OpenCode provider selector + credentials onto the env vars the
 * OpenCode CLI reads (same AI-SDK-style provider env vars as Goose reads for
 * litellm; verify the Gemini var name against a live OpenCode run before
 * relying on it in production — see .github/copilot-instructions.md
 * "Further Considerations"). Ollama needs no key (only a host); Bedrock uses
 * AWS env chains (no key forwarded by VE); the others need a key.
 */
export function opencodeProviderAuthEnv(
  provider: OpenCodeProvider,
  apiKey: string,
  apiBase: string
): Record<string, string> {
  switch (provider) {
    case "anthropic":
      return { ANTHROPIC_API_KEY: apiKey };
    case "openai":
      return { OPENAI_API_KEY: apiKey };
    case "openrouter":
      return { OPENROUTER_API_KEY: apiKey };
    case "ollama":
      return { OLLAMA_API_BASE: apiBase || DEFAULT_OLLAMA_BASE };
    case "deepseek":
      return { DEEPSEEK_API_KEY: apiKey };
    case "groq":
      return { GROQ_API_KEY: apiKey };
    case "gemini":
      return { GOOGLE_GENERATIVE_AI_API_KEY: apiKey };
    case "azure_openai":
      if (!apiBase) {
        throw new Error(
          'OpenCode "azure_openai" provider requires an Azure OpenAI endpoint. Configure the endpoint URL for the integration in the admin dashboard.'
        );
      }
      return { AZURE_OPENAI_API_KEY: apiKey, AZURE_RESOURCE_NAME: apiBase };
    case "bedrock":
      // Bedrock uses AWS credential chains (AWS_PROFILE / AWS_ACCESS_KEY_ID / …)
      // configured in the host environment. The container only receives env vars
      // explicitly listed in spec.env, so forward a minimal allowlist of AWS env
      // vars from the host process so OpenCode can authenticate with Bedrock.
      return forwardAwsEnv();
    case "perplexity":
      return { PERPLEXITY_API_KEY: apiKey };
    case "mistral":
      return { MISTRAL_API_KEY: apiKey };
    case "xai":
      return { XAI_API_KEY: apiKey };
    case "cerebras":
      return { CEREBRAS_API_KEY: apiKey };
    case "openai_compat":
      if (!apiBase) {
        throw new Error(
          'OpenCode "openai_compat" provider requires an API base URL. Configure the base URL for the integration in the admin dashboard.'
        );
      }
      return { OPENAI_API_KEY: apiKey, OPENAI_API_BASE: apiBase };
    default: {
      // Exhaustiveness check — a new provider must be added here.
      const _exhaustive: never = provider;
      throw new Error(`Unsupported OpenCode provider: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Minimal allowlist of AWS env vars forwarded into the agent container for the
 * Bedrock provider. The container only receives env vars explicitly listed in
 * `spec.env`, so these must be read from the host process and forwarded.
 */
const AWS_ENV_ALLOWLIST = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
] as const;

function forwardAwsEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of AWS_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined && value !== "") {
      env[key] = value;
    }
  }
  if (env["AWS_BEARER_TOKEN_BEDROCK"]) {
    return env;
  }
  if (env["AWS_ACCESS_KEY_ID"] && env["AWS_SECRET_ACCESS_KEY"]) {
    return env;
  }
  if (process.env["AWS_PROFILE"]) {
    throw new Error(
      "OpenCode Bedrock requires environment credentials; AWS_PROFILE files are not uploaded to the sandbox."
    );
  }
  if (env["AWS_ACCESS_KEY_ID"] || env["AWS_SECRET_ACCESS_KEY"] || env["AWS_SESSION_TOKEN"]) {
    throw new Error(
      "OpenCode Bedrock requires both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for access-key authentication."
    );
  }
  throw new Error(
    "OpenCode Bedrock requires AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or AWS_BEARER_TOKEN_BEDROCK in the host environment."
  );
}
