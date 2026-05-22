import { randomUUID } from "crypto";
import { homedir } from "os";
import { join, resolve } from "path";
import type {
  AgentAdapter,
  AgentResult,
  AgentLogEvent,
  TaskContext,
  FeedbackItem,
  ExternalChangeId,
  AdapterContainerSpec,
  PromptStore,
  ReviewWorkspaceInput,
} from "../interfaces.js";
import { makeExternalChangeId } from "../interfaces.js";
import { getLogger } from "../logger.js";
import { DEFAULT_COPILOT_MODEL } from "../copilotModel.js";
import { decryptToken } from "../utils/encryption.js";
import { getConfig } from "../config.js";
import { agentLogBus, pushToTaskBuffer } from "./agentEventBus.js";

// Re-export for backward compatibility — callers that import from copilotAdapter continue to work.
export { agentLogBus, getTaskEventBuffer, clearTaskEventBuffer } from "./agentEventBus.js";

const log = getLogger("copilot-adapter");

export interface CopilotAdapterConfig {
  model: string;
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

const DEFAULT_CONFIG: CopilotAdapterConfig = {
  model: DEFAULT_COPILOT_MODEL,
  maxRepositoryContextBytes: 120_000,
  maxCommitsPerCycle: 10,
};

/**
 * Build the user prompt written to `/ve-home/user-prompt.txt` for a code-generation cycle.
 */
export function buildCodegenUserPrompt(
  context: TaskContext,
  instructionsPromptContent: string
): string {
  const lines: string[] = [
    `## Task: ${context.ticketTitle}`,
    "",
    "### Description",
    context.ticketDescription,
    "",
  ];

  if (context.acceptanceCriteria.length > 0 && context.acceptanceCriteria.some((c) => c.trim())) {
    lines.push("### Acceptance Criteria");
    for (const c of context.acceptanceCriteria.filter(Boolean)) {
      lines.push(`- ${c}`);
    }
    lines.push("");
  }

  if (context.constraints.length > 0 && context.constraints.some((c) => c.trim())) {
    lines.push("### Constraints");
    for (const c of context.constraints.filter(Boolean)) {
      lines.push(`- ${c}`);
    }
    lines.push("");
  }

  const priorFeedback: FeedbackItem[] = context.priorFeedback ?? [];
  if (priorFeedback.length > 0) {
    lines.push("### Feedback from previous cycle (must be addressed)");
    for (const item of priorFeedback) {
      const loc = item.filePath
        ? ` [${item.filePath}${item.line != null ? `:${item.line}` : ""}]`
        : "";
      lines.push(`- [${item.source}]${loc}: ${item.content}`);
    }
    lines.push("");
  }

  lines.push("### Instructions");
  lines.push(instructionsPromptContent);
  lines.push(`This is cycle number ${context.cycleNumber}.`);
  if (context.ticketUrl) lines.push(`Ticket URL: ${context.ticketUrl}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Runs code-generation via a Docker agent container (Dockerfile.agent / agent-worker/index.js).
 * The host owns clone, commit, and push; the container is isolated to an agent-only network.
 * Agent commits must include `COMMIT_MSG: <type>(<scope>): <subject>` for conventional-commit extraction.
 */
export class CopilotAdapter implements AgentAdapter {
  readonly name = "copilot";

  private readonly config: CopilotAdapterConfig;
  private dockerInvoker?: DockerInvoker;
  private promptStore?: PromptStore;

  constructor(config: Partial<CopilotAdapterConfig> = {}) {
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

  /** Resolve auth, build prompts, run the agent container, and return the parsed result. */
  async execute(context: TaskContext): Promise<AgentResult> {
    log.info(
      { taskId: context.taskId, cycle: context.cycleNumber },
      "copilot adapter: starting execution"
    );

    const githubToken = await this.getGitHubOAuthToken(context);
    const changeId = context.agentSession.existingChangeId ?? this.generateChangeId();

    await this.buildContainerSpecWithPrompts(context, { GITHUB_TOKEN: githubToken });

    const result = await this.runAgentContainer(context, githubToken, changeId);

    if (result.status === "success") {
      log.info(
        { taskId: context.taskId, files: result.modifiedFiles?.length ?? 0 },
        "copilot adapter: files written"
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
    // Security: only task-specific vars are passed here; agent-worker/index.js further
    // filters to a minimal whitelist — DB credentials and API tokens are never exposed.

    const copilotModel = context.agentSession.copilotModel ?? this.config.model;

    const env: Record<string, string> = {
      ...authEnv,
      COPILOT_MODEL: copilotModel,
      ...(session.copilotReasoningEffort !== undefined
        ? { COPILOT_REASONING_EFFORT: session.copilotReasoningEffort }
        : {}),
      GIT_AUTHOR_NAME: session.gitAuthorName,
      GIT_AUTHOR_EMAIL: session.gitAuthorEmail,
      GIT_COMMITTER_NAME: session.gitAuthorName,
      GIT_COMMITTER_EMAIL: session.gitAuthorEmail,
      TASK_ID: context.taskId,
      MAX_CONTEXT_BYTES: String(this.config.maxRepositoryContextBytes),
      MAX_COMMITS_PER_CYCLE: String(this.config.maxCommitsPerCycle ?? 10),
      // Per-repo Change-Ids for multi-repo retry cycles. The agent can embed these
      // in commit messages so Gerrit recognises them as new patchsets on existing changes.
      PER_REPO_CHANGE_IDS_JSON: session.perRepoChangeIds
        ? JSON.stringify(session.perRepoChangeIds)
        : "",
    };

    const additionalDockerArgs = [
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      // On SELinux hosts (e.g. Fedora/RHEL) Docker applies the svirt_lxc_net_t
      // confinement which denies mprotect(PROT_READ) during glibc RELRO for the
      // Copilot CLI native binary (copilot-linux-x64). label=disable turns off
      // SELinux confinement for this container only.
      "--security-opt",
      "label=disable",
      "--tmpfs",
      // noexec is intentionally omitted: the Copilot CLI dlopen's pty.node into
      // /ve-home (a real bind-mount), not /tmp. /tmp is only ephemeral scratch space
      // that never needs mmap(PROT_EXEC). Under SELinux, noexec on tmpfs also blocks
      // mmap(PROT_EXEC), which is why /ve-home uses a bind-mount with the :Z label.
      "/tmp:rw,nosuid,size=256m",
    ];

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
      command: ["node", "/agent-worker/index.js"],
      networkMode: this.config.dockerNetwork ?? "virtual-engineer_ve-agent-net",
      additionalDockerArgs,
    };
  }

  /** Builds a container spec for review mode (REVIEW_MODE=1). Reads prompt from /ve-home/user-prompt.txt. */
  buildReviewContainerSpec(
    input: ReviewWorkspaceInput,
    authEnv: Record<string, string> = {}
  ): AdapterContainerSpec {
    const env: Record<string, string> = {
      ...authEnv,
      GITHUB_TOKEN: input.agentToken,
      COPILOT_MODEL: input.model ?? this.config.model,
      ...(input.reasoningEffort !== undefined
        ? { COPILOT_REASONING_EFFORT: input.reasoningEffort }
        : {}),
      REVIEW_MODE: "1",
      // Prompt file is mounted at /ve-home to avoid conflicting with the
      // --tmpfs /tmp mount (bind mounts under a tmpfs can be shadowed).
      USER_PROMPT_FILE: "/ve-home/user-prompt.txt",
      SYSTEM_PROMPT: input.systemPrompt,
    };

    const additionalDockerArgs = [
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      // On SELinux hosts (e.g. Fedora/RHEL) Docker applies the svirt_lxc_net_t
      // confinement which denies mprotect(PROT_READ) during glibc RELRO for the
      // Copilot CLI native binary (copilot-linux-x64). label=disable turns off
      // SELinux confinement for this container only. apparmor/seccomp are not
      // needed here — the docker-default profiles already allow mprotect.
      "--security-opt",
      "label=disable",
      "--tmpfs",
      "/tmp:rw,nosuid,size=256m",
    ];

    return {
      image: input.containerImage ?? "virtual-engineer-workspace:latest",
      env,
      command: ["node", "/agent-worker/index.js"],
      networkMode: this.config.dockerNetwork ?? "virtual-engineer_ve-agent-net",
      additionalDockerArgs,
    };
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

    const systemPromptId = context.systemPromptId === undefined ? "system" : context.systemPromptId;
    const instructionsPromptId = context.instructionsPromptId === undefined
      ? "instructions"
      : context.instructionsPromptId;
    const promptIds = [...new Set([
      systemPromptId,
      instructionsPromptId,
    ].filter((id): id is string => typeof id === "string" && id.length > 0))];
    const prompts = await Promise.all(promptIds.map((id) => promptStore.getPrompt(id)));
    const promptsById = new Map<string, Awaited<ReturnType<PromptStore["getPrompt"]>>>(
      promptIds.map((id, index) => [id, prompts[index] ?? null])
    );
    const systemPrompt = typeof systemPromptId === "string" ? promptsById.get(systemPromptId) ?? null : null;
    const instructionsPrompt = typeof instructionsPromptId === "string"
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

  /** Retrieve the GitHub OAuth token, preferring the encrypted session token from agent config. */
  private async getGitHubOAuthToken(context: TaskContext): Promise<string> {
    // Prefer the encrypted session token from agent modelConfig (OAuth flow).
    const encrypted = context.agentSession.encryptedSessionToken;
    if (encrypted) {
      const config = getConfig();
      const secret = config.adminAuthSecret;
      if (!secret) {
        throw new Error("ADMIN_AUTH_SECRET is required to decrypt the Copilot session token");
      }
      return decryptToken(encrypted, secret);
    }
    // Legacy fallback: direct GitHub token on the session.
    if (context.agentSession.githubToken) {
      return context.agentSession.githubToken;
    }
    throw new Error("No Copilot session token or GitHub token available. Connect via OAuth in the admin dashboard.");
  }

  // ── container runner ──────────────────────────────────────────────────────

  /** Spawn the agent container and return its parsed AgentResult. Worker writes a JSON line to stdout. */
  private async runAgentContainer(
    context: TaskContext,
    githubToken: string,
    changeId: ExternalChangeId
  ): Promise<AgentResult> {
    const stderrState: StderrParseState = {
      buffer: "",
      plainLogLines: [],
      agentEvents: [],
    };
    const invocation = await this.invokeAgentContainer(context, githubToken, {
      onStderrChunk: (chunk) => {
        this.consumeStderrChunk(context, stderrState, chunk);
      },
    });
    this.flushStderrBuffer(context, stderrState);

    const result = await this.parseAgentResult(
      context,
      invocation.stdout,
      invocation.stderr,
      stderrState
    );

    // Agent-created commits (multi-commit protocol): skip host commit processing.
    if (result.commits && result.commits.length > 0) {
      log.info(
        { taskId: context.taskId, commitCount: result.commits.length },
        "agent returned pre-validated commits — skipping host commit message processing"
      );
      // Still inject a fallback gerritChangeId for orchestrator compat.
      if (!result.externalChangeId && result.status === "success") {
        result.externalChangeId = changeId;
      }
      return result;
    }

    // Inject the host-generated changeId so the orchestrator's Change-Id validation passes.
    if (!result.externalChangeId && result.status === "success") {
      result.externalChangeId = changeId;
    }
    return result;
  }

  /** Delegate Docker invocation to the registered dockerInvoker, passing auth env. */
  private async invokeAgentContainer(
    context: TaskContext,
    githubToken: string,
    callbacks?: DockerInvocationCallbacks
  ): Promise<DockerInvocationResult> {
    if (!this.dockerInvoker) {
      throw new Error("CopilotAdapter requires a docker invoker before execute() can run");
    }

    return this.dockerInvoker(context, { GITHUB_TOKEN: githubToken }, callbacks);
  }

  /** Parse JSON result from agent stdout and merge with collected stderr log lines and events. */
  private parseAgentResult(
    context: TaskContext,
    stdout: string,
    stderr: string,
    stderrState?: StderrParseState
  ): Promise<AgentResult> | AgentResult {
    const parseState = stderrState ?? {
      buffer: "",
      plainLogLines: [],
      agentEvents: [],
    };
    if (!stderrState) {
      this.consumeStderrChunk(context, parseState, stderr);
      this.flushStderrBuffer(context, parseState);
    }

    const plainLogs = parseState.plainLogLines.join("\n");
    const combinedOutput = `${stdout}\n${stderr}`;

    if (!stdout.trim()) {
      if (this.isNativePtyLoadFailure(combinedOutput)) {
        return {
          status: "failed",
          modifiedFiles: [],
          summary: "Copilot CLI native modules cannot load in this unprivileged Docker container",
          agentLogs: `${plainLogs}\nRecommendation: run the Copilot CLI outside the container and connect via cliUrl, or move SDK execution to the host instead of granting elevated Docker privileges.`,
          agentEvents: parseState.agentEvents,
          metadata: {
            adapter: "copilot",
            error: stderr.slice(0, 300),
            nativePtyLoadFailure: true,
          },
        };
      }

      return {
        status: "failed",
        modifiedFiles: [],
        summary: "Agent container crashed before producing output",
        agentLogs: plainLogs,
        agentEvents: parseState.agentEvents,
        metadata: { adapter: "copilot", error: stderr.slice(0, 300) },
      };
    }

    if (plainLogs) {
      log.debug(
        { taskId: context.taskId, stderr: plainLogs.slice(0, 800) },
        "agent container stderr"
      );
    }

    // The worker always writes a single JSON line as the last line of stdout
    const lines = stdout.trim().split("\n");
    const lastLine = lines[lines.length - 1] ?? "";
    try {
      const parsed = JSON.parse(lastLine) as AgentResult;
      const mergedLogs = [parsed.agentLogs, plainLogs].filter(Boolean).join("\n");
      return { ...parsed, agentLogs: mergedLogs, agentEvents: parseState.agentEvents };
    } catch {
      log.error(
        { taskId: context.taskId, stdout: stdout.slice(0, 500) },
        "failed to parse agent container output as JSON"
      );
      return {
        status: "failed",
        modifiedFiles: [],
        summary: this.isNativePtyLoadFailure(combinedOutput)
          ? "Copilot CLI native modules cannot load in this unprivileged Docker container"
          : "Failed to parse agent container output",
        agentLogs: this.isNativePtyLoadFailure(combinedOutput)
          ? `${stdout}\n${plainLogs}\nRecommendation: run the Copilot CLI outside the container and connect via cliUrl, or move SDK execution to the host instead of granting elevated Docker privileges.`
          : stdout,
        agentEvents: parseState.agentEvents,
        metadata: this.isNativePtyLoadFailure(combinedOutput)
          ? { adapter: "copilot", parseError: true, nativePtyLoadFailure: true }
          : { adapter: "copilot", parseError: true },
      };
    }
  }

  /** Detect whether container output indicates a native pty.node load failure. */
  private isNativePtyLoadFailure(output: string): boolean {
    return output.includes("cannot apply additional memory protection after relocation")
      || output.includes("ERR_DLOPEN_FAILED")
      || output.includes("Failed to load native module: pty.node");
  }

  /** Accumulate a stderr chunk into the line buffer and flush complete lines for processing. */
  private consumeStderrChunk(
    context: TaskContext,
    state: StderrParseState,
    chunk: string
  ): void {
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
  private processStderrLine(
    context: TaskContext,
    state: StderrParseState,
    line: string
  ): void {
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
        this.logLiveAgentEvent(context, event);
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
      "copilot adapter: live stderr"
    );
  }

  /** Log a structured agent event at debug level for high-frequency types, info for others. */
  private logLiveAgentEvent(context: TaskContext, event: AgentLogEvent): void {
    if (event.type === "assistant.streaming_delta" || event.type === "session.usage_info") {
      log.debug(
        { taskId: context.taskId, cycle: context.cycleNumber, type: event.type },
        "copilot adapter: live event"
      );
      return;
    }

    log.info(
      { taskId: context.taskId, cycle: context.cycleNumber, type: event.type },
      "copilot adapter: live event"
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
