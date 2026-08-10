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
import {
  extractToolAuthorization,
  toolAuthorizationJsonEnv,
} from "./toolAuthorization.js";
import {
  buildCodegenContainerSpec,
  buildReviewContainerSpec as buildSharedReviewContainerSpec,
} from "./containerSpecBuilders.js";
import { gooseEgress } from "./backendEgress.js";
import { egressOption } from "./containerSpecBuilders.js";
import { createStderrPipeline } from "./agentStderrPipeline.js";
import type { StderrParseState } from "./agentStderrPipeline.js";

const log = getLogger("goose-adapter");

/**
 * Map Goose `providerOptions` onto the `GOOSE_*` env vars the Goose CLI reads.
 * Goose exposes its global settings as env vars (see goose config-files docs):
 *  - `GOOSE_MODE`            — tool execution behaviour (auto | approve | chat | smart_approve).
 *  - `GOOSE_MAX_TURNS`       — max turns without user input.
 *  - `GOOSE_MAX_TOKENS`      — max tokens per model response.
 *  - `GOOSE_TEMPERATURE`     — model response randomness (0.0–1.0).
 *  - `GOOSE_AUTO_COMPACT_THRESHOLD` — auto-compact threshold (0.0–1.0).
 */
function gooseOptionEnv(options: Record<string, unknown> | undefined): Record<string, string> {
  if (!options) return {};
  const positiveNumber = (key: string): number | undefined => {
    const value = options[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const gooseMode = options["gooseMode"];
  const gooseMaxTurns = positiveNumber("gooseMaxTurns");
  const gooseMaxTokens = positiveNumber("gooseMaxTokens");
  const gooseTemperature = options["gooseTemperature"];
  const gooseAutoCompactThreshold = options["gooseAutoCompactThreshold"];
  return {
    ...(gooseMode === "auto" || gooseMode === "approve" || gooseMode === "chat" || gooseMode === "smart_approve"
      ? { GOOSE_MODE: gooseMode }
      : {}),
    ...(gooseMaxTurns !== undefined ? { GOOSE_MAX_TURNS: String(gooseMaxTurns) } : {}),
    ...(gooseMaxTokens !== undefined ? { GOOSE_MAX_TOKENS: String(gooseMaxTokens) } : {}),
    ...(typeof gooseTemperature === "number" && Number.isFinite(gooseTemperature)
      ? { GOOSE_TEMPERATURE: String(gooseTemperature) }
      : {}),
    ...(typeof gooseAutoCompactThreshold === "number" && Number.isFinite(gooseAutoCompactThreshold)
      ? { GOOSE_AUTO_COMPACT_THRESHOLD: String(gooseAutoCompactThreshold) }
      : {}),
  };
}

export interface GooseAdapterConfig {
  /**
   * Optional model override. When omitted, the adapter injects no `GOOSE_MODEL`
   * and the Goose CLI selects its own default model — the default is owned by
   * the CLI, not hardcoded here.
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

const DEFAULT_CONFIG: GooseAdapterConfig = {
  maxRepositoryContextBytes: 120_000,
  maxCommitsPerCycle: 10,
};

/** Goose LLM provider selector values (mirrors the descriptor zod enum). */
export type GooseProvider =
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
 * Runs code-generation / review via a Docker agent container using the Goose
 * CLI (`agent-worker/src/index.ts` dispatches to the Goose runner when
 * `AGENT_PROVIDER=goose`). Goose wraps any LLM provider; the host injects the
 * provider's auth env vars. The host owns clone, commit, and push.
 */
export class GooseAdapter implements AgentAdapter, ConfigurableAdapter {
  readonly name = "goose";

  private readonly config: GooseAdapterConfig;
  private dockerInvoker?: DockerInvoker;
  private promptStore?: PromptStore;

  constructor(config: Partial<GooseAdapterConfig> = {}) {
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
      "goose adapter: starting execution"
    );

    const authEnv = this.resolveAuthEnv(context);
    const changeId = context.agentSession.existingChangeId ?? this.generateChangeId();

    const result = await this.runAgentContainer(context, authEnv, changeId);

    if (result.status === "success") {
      log.info(
        { taskId: context.taskId, files: result.modifiedFiles?.length ?? 0 },
        "goose adapter: files written"
      );
    }

    return result;
  }

  /** Build the Docker container spec (image, env, args) for a code-generation cycle. */
  buildContainerSpec(
    context: TaskContext,
    authEnv: Record<string, string> = {}
  ): AdapterContainerSpec {
    const session = context.agentSession;
    const gooseModel = session.copilotModel ?? this.config.model;

    // Resolve auth from the session when no explicit authEnv is supplied (e.g.
    // when called directly in tests or by the workspace runner before auth
    // resolution). In the normal execute() path, authEnv is already populated.
    const resolvedAuthEnv =
      Object.keys(authEnv).length > 0 ? authEnv : this.resolveAuthEnv(context);

    const providerEnv: Record<string, string> = {
      ...resolvedAuthEnv,
      AGENT_PROVIDER: "goose",
      ...(gooseModel ? { GOOSE_MODEL: gooseModel } : {}),
      ...gooseOptionEnv(session.providerOptions),
      ...toolAuthorizationJsonEnv(extractToolAuthorization(session.providerOptions)),
    };

    return buildCodegenContainerSpec(context, {
      providerEnv,
      maxRepositoryContextBytes: this.config.maxRepositoryContextBytes,
      maxCommitsPerCycle: this.config.maxCommitsPerCycle,
      promptsDir: this.config.promptsDir,
      ...egressOption(gooseEgress(session.gooseProvider, session.gooseApiBase)),
    });
  }

  /** Builds a container spec for review mode (REVIEW_MODE=1). Reads prompt from /ve-home/user-prompt.txt. */
  buildReviewContainerSpec(
    input: ReviewWorkspaceInput,
    authEnv: Record<string, string> = {}
  ): AdapterContainerSpec {
    const nativeReview = input.reviewStrategy === "goose_native";
    const reviewModel = nativeReview ? undefined : input.model ?? this.config.model;
    const providerEnv: Record<string, string> = {
      ...this.reviewAuthEnv(input, authEnv),
      AGENT_PROVIDER: "goose",
      ...(!nativeReview && reviewModel ? { GOOSE_MODEL: reviewModel } : {}),
      ...gooseOptionEnv(input.providerOptions),
      ...toolAuthorizationJsonEnv(extractToolAuthorization(input.providerOptions)),
      ...(input.reviewOutputSchema !== undefined
        ? { REVIEW_OUTPUT_SCHEMA: JSON.stringify(input.reviewOutputSchema) }
        : {}),
    };

    return buildSharedReviewContainerSpec(input, {
      providerEnv,
      ...egressOption(gooseEgress(input.gooseProvider, input.gooseApiBase)),
    });
  }

  /**
   * Resolve the auth env for a review container. An explicit `authEnv` (already
   * mapped to the provider's env var) wins; otherwise the review `agentToken` is
   * mapped per the `gooseProvider` selector on the input.
   */
  private reviewAuthEnv(
    input: ReviewWorkspaceInput,
    authEnv: Record<string, string>
  ): Record<string, string> {
    if (
      authEnv["OPENAI_API_KEY"] ||
      authEnv["ANTHROPIC_API_KEY"] ||
      authEnv["OPENROUTER_API_KEY"] ||
      authEnv["DEEPSEEK_API_KEY"] ||
      authEnv["GROQ_API_KEY"] ||
      authEnv["GOOGLE_API_KEY"] ||
      authEnv["OLLAMA_HOST"] ||
      authEnv["OPENAI_API_BASE"] ||
      authEnv["PERPLEXITY_API_KEY"] ||
      authEnv["MISTRAL_API_KEY"] ||
      authEnv["XAI_API_KEY"] ||
      authEnv["CEREBRAS_API_KEY"]
    ) {
      return authEnv;
    }
    const token = input.agentToken.trim();
    if (!token) {
      return authEnv;
    }
    const provider = (input.gooseProvider ?? "anthropic") as GooseProvider;
    return gooseProviderAuthEnv(provider, token, input.gooseApiBase ?? "");
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

    spec.env["SYSTEM_PROMPT"] = systemPrompt.content;
    spec.userPromptContent = buildCodegenUserPrompt(context, instructionsPrompt.content);

    return spec;
  }

  // ── authentication ────────────────────────────────────────────────────────

  /**
   * Resolve the Goose auth environment from the agent session. Goose wraps an
   * LLM provider; the provider selector + API key/base URL are forwarded by
   * the orchestrator from the integration config onto the session.
   */
  private resolveAuthEnv(context: TaskContext): Record<string, string> {
    const provider = (context.agentSession.gooseProvider ?? "anthropic") as GooseProvider;
    const apiKey = context.agentSession.gooseApiKey?.trim() ?? "";
    const apiBase = context.agentSession.gooseApiBase?.trim() ?? "";
    if (!apiKey && provider !== "ollama" && provider !== "bedrock") {
      throw new Error(
        "No Goose credentials available. Configure an API key for the selected provider in the admin dashboard."
      );
    }
    return gooseProviderAuthEnv(provider, apiKey, apiBase);
  }

  // ── container runner ──────────────────────────────────────────────────────

  /** Spawn the agent container and return its parsed AgentResult. Worker writes a JSON line to stdout. */
  private async runAgentContainer(
    context: TaskContext,
    authEnv: Record<string, string>,
    changeId: ExternalChangeId
  ): Promise<AgentResult> {
    const stderrPipeline = createStderrPipeline(context, { adapterName: "goose", log });
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
        "goose adapter: agent returned pre-validated commits"
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
        adapter: "goose",
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
      throw new Error("GooseAdapter requires a docker invoker before execute() can run");
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
        metadata: { adapter: "goose" },
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
        "goose adapter: failed to parse agent container output as JSON"
      );
      return {
        status: "failed",
        modifiedFiles: [],
        summary: "Failed to parse agent container output",
        agentLogs: stdout,
        agentEvents: parseState.agentEvents,
        metadata: { adapter: "goose", parseError: true },
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
 * Map a Goose provider selector + credentials onto the env vars the Goose CLI
 * reads. Goose reads provider API keys from the environment (never from
 * config.yaml). Ollama needs no key (only a host); Bedrock uses AWS env chains
 * (no key forwarded by VE); the others need a key.
 */
export function gooseProviderAuthEnv(
  provider: GooseProvider,
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
      return { OLLAMA_HOST: apiBase || DEFAULT_OLLAMA_BASE };
    case "deepseek":
      return { DEEPSEEK_API_KEY: apiKey };
    case "groq":
      return { GROQ_API_KEY: apiKey };
    case "gemini":
      return { GOOGLE_API_KEY: apiKey };
    case "azure_openai":
      if (!apiBase) {
        throw new Error(
          'Goose "azure_openai" provider requires an Azure OpenAI endpoint. Configure the endpoint URL for the integration in the admin dashboard.'
        );
      }
      return { AZURE_OPENAI_API_KEY: apiKey, AZURE_OPENAI_ENDPOINT: apiBase };
    case "bedrock":
      // Bedrock uses AWS credential chains (AWS_PROFILE / AWS_ACCESS_KEY_ID / …)
      // configured in the host environment. The container only receives env vars
      // explicitly listed in spec.env, so forward a minimal allowlist of AWS env
      // vars from the host process so Goose can authenticate with Bedrock.
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
          'Goose "openai_compat" provider requires an API base URL. Configure the base URL for the integration in the admin dashboard.'
        );
      }
      return { OPENAI_API_KEY: apiKey, OPENAI_API_BASE: apiBase };
    default: {
      // Exhaustiveness check — a new provider must be added here.
      const _exhaustive: never = provider;
      throw new Error(`Unsupported Goose provider: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Minimal allowlist of AWS env vars forwarded into the agent container for the
 * Bedrock provider. The container only receives env vars explicitly listed in
 * `spec.env`, so these must be read from the host process and forwarded. The
 * worker's `buildGooseEnv()` allowlist already permits these vars on the
 * subprocess side; this function ensures they reach the container at all.
 */
const AWS_ENV_ALLOWLIST = [
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
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
  return env;
}