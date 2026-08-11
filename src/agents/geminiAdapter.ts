import { randomUUID } from "crypto";
import type {
  AgentAdapter,
  ConfigurableAdapter,
  AgentResult,
  TaskContext,
  ExternalChangeId,
  AdapterContainerSpec,
  AgentEgressSpec,
  PromptStore,
  ReviewWorkspaceInput,
  WorkspaceRunner,
} from "../interfaces.js";
import { makeExternalChangeId } from "../interfaces.js";
import { getLogger } from "../logger.js";
import { buildCodegenUserPrompt } from "./copilotAdapter.js";
import {
  buildCodegenContainerSpec,
  buildReviewContainerSpec as buildSharedReviewContainerSpec,
  systemPromptEnv,
} from "./containerSpecBuilders.js";
import { createStderrPipeline } from "./agentStderrPipeline.js";
import type { StderrParseState } from "./agentStderrPipeline.js";
import { assertPromptRole } from "../utils/promptRole.js";

/**
 * Network egress the Gemini CLI needs under the OpenShell deny-by-default
 * runtime. `generativelanguage.googleapis.com` serves both api_key and
 * vertex_ai (Express Mode) model calls; `aiplatform.googleapis.com` is added
 * for non-Express Vertex AI project/location routing. `oauth2.googleapis.com`
 * may be needed for Application Default Credentials refresh in some Vertex AI
 * configurations. This list is a best-effort default — verify against a live
 * run once real credentials are available (see .github/copilot-instructions.md
 * "Further Considerations"), since the CLI may also contact update-check or
 * telemetry hosts. The Gemini CLI runs as its own binary plus the Node-based
 * MCP submission server, so both `gemini` and `node` are permitted binaries.
 */
const GEMINI_EGRESS: AgentEgressSpec = {
  hosts: ["generativelanguage.googleapis.com", "aiplatform.googleapis.com", "oauth2.googleapis.com"],
  binaries: ["/usr/local/bin/node", "/usr/local/bin/gemini"],
};

const log = getLogger("gemini-adapter");

/**
 * Resolve the auth env for the Gemini CLI from a plaintext API key + the
 * configured auth mode. `vertex_ai` (Express Mode) reuses the same key value
 * but targets `GOOGLE_API_KEY` and sets `GOOGLE_GENAI_USE_VERTEXAI=true`.
 */
function resolveGeminiAuthEnv(
  apiKey: string | undefined,
  authMode: string | undefined,
  googleCloudProject: string | undefined,
  googleCloudLocation: string | undefined
): Record<string, string> {
  const key = apiKey?.trim();
  if (!key) return {};
  if (authMode === "vertex_ai") {
    return {
      GOOGLE_API_KEY: key,
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      ...(googleCloudProject ? { GOOGLE_CLOUD_PROJECT: googleCloudProject } : {}),
      ...(googleCloudLocation ? { GOOGLE_CLOUD_LOCATION: googleCloudLocation } : {}),
    };
  }
  return { GEMINI_API_KEY: key };
}

export interface GeminiAdapterConfig {
  /**
   * Optional model override. When omitted, the adapter injects no
   * `GEMINI_MODEL` and the Gemini CLI selects its own default (the `auto`
   * alias) — the default is owned by the CLI, not hardcoded here.
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

const DEFAULT_CONFIG: GeminiAdapterConfig = {
  maxRepositoryContextBytes: 120_000,
  maxCommitsPerCycle: 10,
};

/**
 * Runs code-generation / review via an OpenShell agent sandbox using the
 * Gemini CLI (`agent-worker/src/index.ts` dispatches to the Gemini runner
 * when `AGENT_PROVIDER=gemini`). Gemini CLI is a standalone CLI (not an
 * embeddable SDK), so the worker drives it as a subprocess — see
 * `agent-worker/src/providers/gemini.ts`. The host owns clone, commit, and
 * push.
 *
 * Review mode always authenticates as a plain Gemini API key (the `agentToken`
 * resolved for the review integration); Vertex AI-mode review is not yet
 * supported (see .github/copilot-instructions.md "Further Considerations").
 */
export class GeminiAdapter implements AgentAdapter, ConfigurableAdapter {
  readonly name = "gemini";

  private readonly config: GeminiAdapterConfig;
  private dockerInvoker?: DockerInvoker;
  private promptStore?: PromptStore;

  constructor(config: Partial<GeminiAdapterConfig> = {}) {
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
      "gemini adapter: starting execution"
    );

    const authEnv = this.resolveAuthEnv(context);
    const changeId = context.agentSession.existingChangeId ?? this.generateChangeId();

    const result = await this.runAgentContainer(context, authEnv, changeId);

    if (result.status === "success") {
      log.info(
        { taskId: context.taskId, files: result.modifiedFiles?.length ?? 0 },
        "gemini adapter: files written"
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
    const geminiModel = session.copilotModel ?? this.config.model;

    const providerEnv: Record<string, string> = {
      ...authEnv,
      AGENT_PROVIDER: "gemini",
      ...(geminiModel ? { GEMINI_MODEL: geminiModel } : {}),
    };

    return buildCodegenContainerSpec(context, {
      providerEnv,
      maxRepositoryContextBytes: this.config.maxRepositoryContextBytes,
      maxCommitsPerCycle: this.config.maxCommitsPerCycle,
      promptsDir: this.config.promptsDir,
      egress: GEMINI_EGRESS,
    });
  }

  /** Builds a container spec for review mode (REVIEW_MODE=1). Reads the prompt from the file the runner uploads into the sandbox. */
  buildReviewContainerSpec(
    input: ReviewWorkspaceInput,
    authEnv: Record<string, string> = {}
  ): AdapterContainerSpec {
    const reviewModel = input.model ?? this.config.model;
    const providerEnv: Record<string, string> = {
      ...this.reviewAuthEnv(input.agentToken, authEnv),
      AGENT_PROVIDER: "gemini",
      ...(reviewModel ? { GEMINI_MODEL: reviewModel } : {}),
    };

    return buildSharedReviewContainerSpec(input, {
      providerEnv,
      egress: GEMINI_EGRESS,
    });
  }

  /**
   * Resolve the auth env for a review container. An explicit `authEnv`
   * (GEMINI_API_KEY / GOOGLE_API_KEY) wins; otherwise the review `agentToken`
   * is used directly as a Gemini Developer API key.
   */
  private reviewAuthEnv(
    agentToken: string,
    authEnv: Record<string, string>
  ): Record<string, string> {
    if (authEnv["GEMINI_API_KEY"] || authEnv["GOOGLE_API_KEY"]) {
      return authEnv;
    }
    const token = agentToken.trim();
    if (!token) {
      return authEnv;
    }
    return { GEMINI_API_KEY: token };
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
   * Resolve the Gemini auth environment from the generic `githubToken` field
   * (reused across providers as "the plaintext credential") plus the
   * Gemini-specific `geminiAuthMode`/`geminiGoogleCloudProject`/
   * `geminiGoogleCloudLocation` session fields forwarded from the integration
   * config.
   */
  private resolveAuthEnv(context: TaskContext): Record<string, string> {
    const session = context.agentSession;
    const env = resolveGeminiAuthEnv(
      session.githubToken,
      session.geminiAuthMode,
      session.geminiGoogleCloudProject,
      session.geminiGoogleCloudLocation
    );
    if (Object.keys(env).length === 0) {
      throw new Error(
        "No Gemini credentials available. Configure a Gemini API key in the admin dashboard."
      );
    }
    return env;
  }

  // ── container runner ──────────────────────────────────────────────────────

  /** Spawn the agent container and return its parsed AgentResult. Worker writes a JSON line to stdout. */
  private async runAgentContainer(
    context: TaskContext,
    authEnv: Record<string, string>,
    changeId: ExternalChangeId
  ): Promise<AgentResult> {
    const stderrPipeline = createStderrPipeline(context, { adapterName: "gemini", log });
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
        "gemini adapter: agent returned pre-validated commits"
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
        adapter: "gemini",
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
      throw new Error("GeminiAdapter requires a docker invoker before execute() can run");
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
        metadata: { adapter: "gemini" },
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
        "gemini adapter: failed to parse agent container output as JSON"
      );
      return {
        status: "failed",
        modifiedFiles: [],
        summary: "Failed to parse agent container output",
        agentLogs: stdout,
        agentEvents: parseState.agentEvents,
        metadata: { adapter: "gemini", parseError: true },
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
