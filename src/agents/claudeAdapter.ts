import { randomUUID } from "crypto";
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
import { decryptToken } from "../utils/encryption.js";
import { getConfig } from "../config.js";
import { agentLogBus, pushToTaskBuffer } from "./agentEventBus.js";
import { buildCodegenUserPrompt } from "./copilotAdapter.js";
import {
  buildCodegenContainerSpec,
  buildReviewContainerSpec as buildSharedReviewContainerSpec,
} from "./containerSpecBuilders.js";

const log = getLogger("claude-adapter");

export interface ClaudeAdapterConfig {
  /**
   * Optional model override. When omitted, the adapter injects no `CLAUDE_MODEL`
   * and the Claude CLI selects its own default model — the default is owned by
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

const DEFAULT_CONFIG: ClaudeAdapterConfig = {
  maxRepositoryContextBytes: 120_000,
  maxCommitsPerCycle: 10,
};

/**
 * Runs code-generation / review via a Docker agent container using the Anthropic
 * Claude Code Agent SDK (`agent-worker/src/index.ts` dispatches to the Claude
 * runner when `AGENT_PROVIDER=claude`). The host owns clone, commit, and push.
 */
export class ClaudeAdapter implements AgentAdapter, ConfigurableAdapter {
  readonly name = "claude";

  private readonly config: ClaudeAdapterConfig;
  private dockerInvoker?: DockerInvoker;
  private promptStore?: PromptStore;

  constructor(config: Partial<ClaudeAdapterConfig> = {}) {
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
      "claude adapter: starting execution"
    );

    const authEnv = this.resolveAuthEnv(context);
    const changeId = context.agentSession.existingChangeId ?? this.generateChangeId();

    // buildContainerSpecWithPrompts is called inside runAgentContainer → invokeAgentContainer
    // → dockerInvoker → workspaceRunner.runAgentInDocker, so no separate call needed here.
    const result = await this.runAgentContainer(context, authEnv, changeId);

    if (result.status === "success") {
      log.info(
        { taskId: context.taskId, files: result.modifiedFiles?.length ?? 0 },
        "claude adapter: files written"
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
    const claudeModel = session.copilotModel ?? this.config.model;

    const providerEnv: Record<string, string> = {
      ...authEnv,
      AGENT_PROVIDER: "claude",
      // The agent container runs as root; Claude Code refuses bypassPermissions
      // (--dangerously-skip-permissions) as root unless IS_SANDBOX=1 signals a
      // sandboxed environment. Our container is a hardened, network-isolated sandbox.
      IS_SANDBOX: "1",
      ...(claudeModel ? { CLAUDE_MODEL: claudeModel } : {}),
    };

    return buildCodegenContainerSpec(context, {
      providerEnv,
      maxRepositoryContextBytes: this.config.maxRepositoryContextBytes,
      maxCommitsPerCycle: this.config.maxCommitsPerCycle,
      promptsDir: this.config.promptsDir,
      dockerNetwork: this.config.dockerNetwork,
    });
  }

  /** Builds a container spec for review mode (REVIEW_MODE=1). Reads prompt from /ve-home/user-prompt.txt. */
  buildReviewContainerSpec(
    input: ReviewWorkspaceInput,
    authEnv: Record<string, string> = {}
  ): AdapterContainerSpec {
    const reviewModel = input.model ?? this.config.model;
    const providerEnv: Record<string, string> = {
      ...this.reviewAuthEnv(input.agentToken, authEnv),
      AGENT_PROVIDER: "claude",
      // Allow bypassPermissions as root inside the hardened sandbox container.
      IS_SANDBOX: "1",
      ...(reviewModel ? { CLAUDE_MODEL: reviewModel } : {}),
    };

    return buildSharedReviewContainerSpec(input, {
      providerEnv,
      dockerNetwork: this.config.dockerNetwork,
    });
  }

  /**
   * Resolve the auth env for a review container. An explicit `authEnv`
   * (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN) wins; otherwise the review
   * `agentToken` is classified by its Anthropic prefix — subscription OAuth
   * tokens are `sk-ant-oat…`, API keys are `sk-ant-api…`.
   */
  private reviewAuthEnv(
    agentToken: string,
    authEnv: Record<string, string>
  ): Record<string, string> {
    if (authEnv["ANTHROPIC_API_KEY"] || authEnv["CLAUDE_CODE_OAUTH_TOKEN"]) {
      return authEnv;
    }
    const token = agentToken.trim();
    if (!token) {
      return authEnv;
    }
    return token.startsWith("sk-ant-oat")
      ? { CLAUDE_CODE_OAUTH_TOKEN: token }
      : { ANTHROPIC_API_KEY: token };
  }

  /** Extend buildContainerSpec with resolved system and instructions prompt content. */
  async buildContainerSpecWithPrompts(
    context: TaskContext,
    authEnv: Record<string, string> = {}
  ): Promise<AdapterContainerSpec> {
    const spec = this.buildContainerSpec(context, authEnv);
    const promptStore = this.promptStore;

    if (!promptStore) {
      return spec;
    }

    const systemPromptId =
      context.systemPromptId === undefined ? "system_generic_code" : context.systemPromptId;
    const instructionsPromptId =
      context.instructionsPromptId === undefined
        ? "instructions_generic_code"
        : context.instructionsPromptId;
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

    if (systemPrompt) {
      spec.env["SYSTEM_PROMPT"] = systemPrompt.content;
    }

    if (instructionsPrompt) {
      spec.userPromptContent = buildCodegenUserPrompt(context, instructionsPrompt.content);
    }

    return spec;
  }

  // ── authentication ────────────────────────────────────────────────────────

  /**
   * Resolve the Claude auth environment.
   *
   * Subscription (OAuth) integrations carry an encrypted token that maps to
   * `CLAUDE_CODE_OAUTH_TOKEN`; API-key integrations carry a plaintext key
   * (via `githubToken`, the generic agent-config auth field) that maps to
   * `ANTHROPIC_API_KEY`.
   */
  private resolveAuthEnv(context: TaskContext): Record<string, string> {
    const encrypted = context.agentSession.encryptedSessionToken;
    if (encrypted) {
      return { CLAUDE_CODE_OAUTH_TOKEN: decryptToken(encrypted, getConfig().adminAuthSecret) };
    }
    if (context.agentSession.githubToken) {
      return { ANTHROPIC_API_KEY: context.agentSession.githubToken.trim() };
    }
    throw new Error(
      "No Claude credentials available. Configure an Anthropic API key or connect a Claude subscription in the admin dashboard."
    );
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

    // Agent-created commits (multi-commit protocol): skip host commit processing.
    if (result.commits && result.commits.length > 0) {
      log.info(
        { taskId: context.taskId, commitCount: result.commits.length },
        "claude adapter: agent returned pre-validated commits"
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
        adapter: "claude",
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
      throw new Error("ClaudeAdapter requires a docker invoker before execute() can run");
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
        metadata: { adapter: "claude" },
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
        "claude adapter: failed to parse agent container output as JSON"
      );
      return {
        status: "failed",
        modifiedFiles: [],
        summary: "Failed to parse agent container output",
        agentLogs: stdout,
        agentEvents: parseState.agentEvents,
        metadata: { adapter: "claude", parseError: true },
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
      "claude adapter: live stderr"
    );
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** Generate a unique Gerrit-compatible Change-Id string from a random UUID. */
  private generateChangeId(): ExternalChangeId {
    const uuid = randomUUID().replace(/-/g, "");
    return makeExternalChangeId(`I${uuid}${uuid.slice(0, 8)}`);
  }

}
