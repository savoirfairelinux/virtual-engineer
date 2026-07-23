import { randomUUID } from "crypto";
import { homedir } from "os";
import { join, resolve } from "path";
import type {
  AgentAdapter,
  ConfigurableAdapter,
  AgentResult,
  AgentLogEvent,
  TaskContext,
  ExternalChangeId,
  AdapterContainerSpec,
  PromptStore,
  ReviewWorkspaceInput,
  WorkspaceRunner,
} from "../interfaces.js";
import { makeExternalChangeId } from "../interfaces.js";
import { getLogger } from "../logger.js";
import { agentLogBus, pushToTaskBuffer } from "./agentEventBus.js";
import { buildCodegenUserPrompt } from "./copilotAdapter.js";

const log = getLogger("aider-adapter");

export interface AiderAdapterConfig {
  /**
   * Optional model override. When omitted, the adapter injects no `AIDER_MODEL`
   * and the Aider CLI selects its own default model — the default is owned by
   * the CLI, not hardcoded here.
   */
  model?: string | undefined;
  maxRepositoryContextBytes: number;
  maxCommitsPerCycle: number;
  promptsDir?: string | undefined;
  /** Docker network for agent/review containers. Defaults to `virtual-engineer_ve-agent-net`. */
  dockerNetwork?: string | undefined;
}

interface DockerInvocationResult {
  stdout: string;
  stderr: string;
}

interface DockerInvocationCallbacks {
  onStdoutChunk?: ((chunk: string) => void) | undefined;
  onStderrChunk?: ((chunk: string) => void) | undefined;
}

interface StderrParseState {
  buffer: string;
  plainLogLines: string[];
  agentEvents: AgentLogEvent[];
}

type DockerInvoker = (
  context: TaskContext,
  authEnv?: Record<string, string>,
  callbacks?: DockerInvocationCallbacks
) => Promise<DockerInvocationResult>;

const DEFAULT_CONFIG: AiderAdapterConfig = {
  maxRepositoryContextBytes: 120_000,
  maxCommitsPerCycle: 10,
};

const SECURITY_DOCKER_ARGS = [
  "--read-only",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges:true",
  "--security-opt",
  "label=disable",
  "--tmpfs",
  "/tmp:rw,nosuid,size=256m",
];

/** Aider LLM backend selector values (mirrors the descriptor zod enum). */
export type AiderBackend = "openai" | "anthropic" | "ollama" | "openrouter" | "deepseek" | "openai_compat";

const DEFAULT_OLLAMA_BASE = "http://127.0.0.1:11434";

/**
 * Runs code-generation / review via a Docker agent container using the Aider
 * CLI (`agent-worker/src/index.ts` dispatches to the Aider runner when
 * `AGENT_PROVIDER=aider`). Aider wraps any litellm backend; the host injects
 * the backend's auth env vars. The host owns clone, commit, and push.
 */
export class AiderAdapter implements AgentAdapter, ConfigurableAdapter {
  readonly name = "aider";

  private readonly config: AiderAdapterConfig;
  private dockerInvoker?: DockerInvoker;
  private promptStore?: PromptStore;

  constructor(config: Partial<AiderAdapterConfig> = {}) {
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
      "aider adapter: starting execution"
    );

    const authEnv = this.resolveAuthEnv(context);
    const changeId = context.agentSession.existingChangeId ?? this.generateChangeId();

    const result = await this.runAgentContainer(context, authEnv, changeId);

    if (result.status === "success") {
      log.info(
        { taskId: context.taskId, files: result.modifiedFiles?.length ?? 0 },
        "aider adapter: files written"
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
    const aiderModel = session.copilotModel ?? this.config.model;

    // Resolve auth from the session when no explicit authEnv is supplied (e.g.
    // when called directly in tests or by the workspace runner before auth
    // resolution). In the normal execute() path, authEnv is already populated.
    const resolvedAuthEnv =
      Object.keys(authEnv).length > 0 ? authEnv : this.resolveAuthEnv(context);

    const env: Record<string, string> = {
      ...resolvedAuthEnv,
      AGENT_PROVIDER: "aider",
      ...(aiderModel ? { AIDER_MODEL: aiderModel } : {}),
      GIT_AUTHOR_NAME: session.gitAuthorName,
      GIT_AUTHOR_EMAIL: session.gitAuthorEmail,
      GIT_COMMITTER_NAME: session.gitAuthorName,
      GIT_COMMITTER_EMAIL: session.gitAuthorEmail,
      TASK_ID: context.taskId,
      MAX_CONTEXT_BYTES: String(this.config.maxRepositoryContextBytes),
      MAX_COMMITS_PER_CYCLE: String(this.config.maxCommitsPerCycle ?? 10),
      ...(session.repositoryMap !== undefined
        ? { REPOSITORY_MAP_JSON: JSON.stringify(session.repositoryMap) }
        : {}),
      ...(session.existingChangeId !== undefined
        ? { ROOT_CHANGE_ID: session.existingChangeId }
        : {}),
      ...(session.perRepoChangeIds !== undefined
        ? { PER_REPO_CHANGE_IDS_JSON: JSON.stringify(session.perRepoChangeIds) }
        : {}),
      ...(session.skillDiscoveryEnabled ? { SKILL_DISCOVERY: "1" } : {}),
      ...(session.skillDiscoveryEnabled && session.localSkillsPath !== undefined
        ? { LOCAL_SKILLS_PATH: session.localSkillsPath }
        : {}),
      ...(session.ticketFooterLine ? { TICKET_FOOTER_LINE: session.ticketFooterLine } : {}),
    };

    const additionalDockerArgs = [...SECURITY_DOCKER_ARGS];

    const resolvedPromptsDir = this.config.promptsDir
      ? this.resolvePath(this.config.promptsDir)
      : null;
    if (resolvedPromptsDir) {
      additionalDockerArgs.push("-v", `${resolvedPromptsDir}:/ve-prompts:ro,Z`);
      env["PROMPTS_DIR"] = "/ve-prompts";
    }

    return {
      image: session.agentContainerImage,
      env,
      command: ["node", "/agent-worker/dist/index.js"],
      networkMode: this.config.dockerNetwork ?? "virtual-engineer_ve-agent-net",
      additionalDockerArgs,
    };
  }

  /** Builds a container spec for review mode (REVIEW_MODE=1). Reads prompt from /ve-home/user-prompt.txt. */
  buildReviewContainerSpec(
    input: ReviewWorkspaceInput,
    authEnv: Record<string, string> = {}
  ): AdapterContainerSpec {
    const reviewModel = input.model ?? this.config.model;
    const env: Record<string, string> = {
      ...this.reviewAuthEnv(input, authEnv),
      AGENT_PROVIDER: "aider",
      ...(reviewModel ? { AIDER_MODEL: reviewModel } : {}),
      REVIEW_MODE: "1",
      USER_PROMPT_FILE: "/ve-home/user-prompt.txt",
      SYSTEM_PROMPT: input.systemPrompt,
      ...(input.skillDiscoveryEnabled ? { SKILL_DISCOVERY: "1" } : {}),
      ...(input.skillDiscoveryEnabled && input.localSkillsPath !== undefined
        ? { LOCAL_SKILLS_PATH: input.localSkillsPath }
        : {}),
    };

    return {
      image: input.containerImage ?? "virtual-engineer-workspace:latest",
      env,
      command: ["node", "/agent-worker/dist/index.js"],
      networkMode: this.config.dockerNetwork ?? "virtual-engineer_ve-agent-net",
      additionalDockerArgs: [...SECURITY_DOCKER_ARGS],
    };
  }

  /**
   * Resolve the auth env for a review container. An explicit `authEnv` (already
   * mapped to the backend's env var) wins; otherwise the review `agentToken` is
   * mapped per the `aiderBackend` selector on the input.
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
      authEnv["OLLAMA_API_BASE"] ||
      authEnv["OPENAI_API_BASE"]
    ) {
      return authEnv;
    }
    const token = input.agentToken.trim();
    if (!token) {
      return authEnv;
    }
    const backend = (input.aiderBackend ?? "openai") as AiderBackend;
    return backendAuthEnv(backend, token, input.aiderApiBase ?? "");
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

    spec.env["SYSTEM_PROMPT"] = systemPrompt.content;
    spec.userPromptContent = buildCodegenUserPrompt(context, instructionsPrompt.content);

    return spec;
  }

  // ── authentication ────────────────────────────────────────────────────────

  /**
   * Resolve the Aider auth environment from the agent session. Aider wraps a
   * litellm backend; the backend selector + API key/base URL are forwarded by
   * the orchestrator from the integration config onto the session.
   */
  private resolveAuthEnv(context: TaskContext): Record<string, string> {
    const backend = (context.agentSession.aiderBackend ?? "openai") as AiderBackend;
    const apiKey = context.agentSession.aiderApiKey?.trim() ?? "";
    const apiBase = context.agentSession.aiderApiBase?.trim() ?? "";
    if (!apiKey && backend !== "ollama") {
      throw new Error(
        "No Aider credentials available. Configure an API key for the selected backend in the admin dashboard."
      );
    }
    return backendAuthEnv(backend, apiKey, apiBase);
  }

  // ── container runner ──────────────────────────────────────────────────────

  /** Spawn the agent container and return its parsed AgentResult. Worker writes a JSON line to stdout. */
  private async runAgentContainer(
    context: TaskContext,
    authEnv: Record<string, string>,
    changeId: ExternalChangeId
  ): Promise<AgentResult> {
    const stderrState: StderrParseState = {
      buffer: "",
      plainLogLines: [],
      agentEvents: [],
    };
    let invocation: DockerInvocationResult;
    try {
      invocation = await this.invokeAgentContainer(context, authEnv, {
        onStderrChunk: (chunk) => {
          this.consumeStderrChunk(context, stderrState, chunk);
        },
      });
    } catch (err) {
      this.flushStderrBuffer(context, stderrState);
      if (stderrState.agentEvents.length === 0 && stderrState.plainLogLines.length === 0) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      return this.setupFailureResult(message, stderrState);
    }
    this.flushStderrBuffer(context, stderrState);

    const result = this.parseAgentResult(context, invocation.stdout, stderrState);

    if (result.commits && result.commits.length > 0) {
      log.info(
        { taskId: context.taskId, commitCount: result.commits.length },
        "aider adapter: agent returned pre-validated commits"
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
        adapter: "aider",
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
      throw new Error("AiderAdapter requires a docker invoker before execute() can run");
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
        metadata: { adapter: "aider" },
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
        "aider adapter: failed to parse agent container output as JSON"
      );
      return {
        status: "failed",
        modifiedFiles: [],
        summary: "Failed to parse agent container output",
        agentLogs: stdout,
        agentEvents: parseState.agentEvents,
        metadata: { adapter: "aider", parseError: true },
      };
    }
  }

  /** Accumulate a stderr chunk into the line buffer and flush complete lines for processing. */
  private consumeStderrChunk(context: TaskContext, state: StderrParseState, chunk: string): void {
    state.buffer += chunk;
    const lines = state.buffer.split(/\r?\n/);
    state.buffer = lines.pop() ?? "";
    for (const line of lines) {
      this.processStderrLine(context, state, line);
    }
  }

  /** Flush any remaining buffered stderr content as a final line. */
  private flushStderrBuffer(context: TaskContext, state: StderrParseState): void {
    if (!state.buffer) {
      return;
    }
    this.processStderrLine(context, state, state.buffer);
    state.buffer = "";
  }

  /** Parse one stderr line as a VE event JSON or plain log, emitting to the live event bus. */
  private processStderrLine(context: TaskContext, state: StderrParseState, line: string): void {
    if (!line) {
      return;
    }

    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed["__ve_event"] === true) {
        const event: AgentLogEvent = {
          type: typeof parsed["type"] === "string" ? parsed["type"] : "unknown",
          timestamp: typeof parsed["ts"] === "string" ? parsed["ts"] : new Date().toISOString(),
          data: parsed["data"],
          taskId: context.taskId,
          cycleNumber: context.cycleNumber,
        };
        state.agentEvents.push(event);
        pushToTaskBuffer(event);
        agentLogBus.emit("event", event);
        return;
      }
    } catch {
      // plain stderr line
    }

    state.plainLogLines.push(line);
    const stderrEvent: AgentLogEvent = {
      type: "stderr.line",
      timestamp: new Date().toISOString(),
      data: { line },
      taskId: context.taskId,
      cycleNumber: context.cycleNumber,
    };
    pushToTaskBuffer(stderrEvent);
    agentLogBus.emit("event", stderrEvent);
    log.info(
      { taskId: context.taskId, cycle: context.cycleNumber, line },
      "aider adapter: live stderr"
    );
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** Generate a unique Gerrit-compatible Change-Id string from a random UUID. */
  private generateChangeId(): ExternalChangeId {
    const uuid = randomUUID().replace(/-/g, "");
    return makeExternalChangeId(`I${uuid}${uuid.slice(0, 8)}`);
  }

  /** Resolve a path string, expanding a leading `~/` to the current user's home directory. */
  private resolvePath(value: string): string {
    if (value.startsWith("~/")) return join(homedir(), value.slice(2));
    if (value === "~") return homedir();
    return resolve(value);
  }
}

/**
 * Map an Aider backend selector + credentials onto the litellm env vars the
 * Aider CLI reads. Ollama needs no key (only a base URL); the others need a key.
 */
function backendAuthEnv(
  backend: AiderBackend,
  apiKey: string,
  apiBase: string
): Record<string, string> {
  switch (backend) {
    case "openai":
      return { OPENAI_API_KEY: apiKey };
    case "anthropic":
      return { ANTHROPIC_API_KEY: apiKey };
    case "ollama":
      return { OLLAMA_API_BASE: apiBase || DEFAULT_OLLAMA_BASE };
    case "openrouter":
      return { OPENROUTER_API_KEY: apiKey };
    case "deepseek":
      return { DEEPSEEK_API_KEY: apiKey };
    case "openai_compat":
      if (!apiBase) {
        throw new Error(
          'Aider "openai_compat" backend requires an API base URL. Configure the base URL for the integration in the admin dashboard.'
        );
      }
      return { OPENAI_API_KEY: apiKey, OPENAI_API_BASE: apiBase };
    default: {
      // Exhaustiveness check — a new backend must be added here.
      const _exhaustive: never = backend;
      throw new Error(`Unsupported Aider backend: ${String(_exhaustive)}`);
    }
  }
}