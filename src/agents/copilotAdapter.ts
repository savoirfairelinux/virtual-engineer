import { randomUUID } from "crypto";
import { homedir } from "os";
import { join, resolve } from "path";
import type {
  AgentAdapter,
  ConfigurableAdapter,
  AgentResult,
  AgentLogEvent,
  TaskContext,
  FeedbackItem,
  ExternalChangeId,
  AdapterContainerSpec,
  PromptStore,
  ReviewWorkspaceInput,
  WorkspaceRunner,
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

  const repoMap = context.agentSession.repositoryMap;
  if (!repoMap || repoMap.submodules.length === 0) {
    // Single-repository workspace: explicit commit reminder.
    lines.push("### CRITICAL: Commit Requirement");
    lines.push("After making all your changes you **MUST** commit them using `bash`. Every commit needs BOTH a Conventional-Commits subject AND a body (2–4 sentences explaining what changed and why):");
    lines.push("```");
    lines.push("git -C /workspace add -A");
    lines.push("git -C /workspace commit -m 'type(scope): short imperative subject' \\");
    lines.push("                          -m 'Body: explain WHAT changed and WHY in 2-4 sentences. Reference the ticket goal.'");
    lines.push("```");
    lines.push("The commit message **must** follow Conventional Commits format (`type(scope): subject`). Replace `type` with one of: `feat`, `fix`, `refactor`, `test`, `chore`, `docs`, `perf`, `ci`, `build`.");
    lines.push("A subject-only commit is treated as missing — the body is mandatory.");
    lines.push("If validation tools (lint, typecheck) are not available in the workspace, **skip them** and commit anyway.");
    lines.push("Do NOT end your session without committing — uncommitted file changes are discarded.");
    lines.push("");
  } else {
    lines.push("### CRITICAL: Multi-Repository One-Shot Requirement");
    lines.push("**You MUST implement ALL changes in ALL repositories before writing your final response.**");
    lines.push("Do NOT stop after one repo. Do NOT say \"let me know\" or \"Next:\". This session ends when you respond — there is no next turn.");
    lines.push("");
    lines.push("### Workspace Layout (multi-repository)");
    lines.push("This workspace contains multiple repositories cloned side-by-side:");
    lines.push(`- **${repoMap.superproject.repoKey}** (root): \`/workspace/\` — use \`glob\`, \`grep\`, \`view\`, \`edit\` normally`);
    for (const sub of repoMap.submodules) {
      lines.push(`- **${sub.repoKey}**: \`/workspace/${sub.localPath}/\` — use \`bash\` for discovery, \`edit\`/\`create\` for changes`);
    }
    lines.push("");
    lines.push("For the root repository, use the standard tools (`glob`, `grep`, `view`, `edit`) as usual.");
    lines.push("For sub-repositories, `glob`/`grep`/`view` cannot reach them. Use `bash` only for discovery:");
    lines.push(`- \`find /workspace/${repoMap.submodules[0]!.localPath}/ -name '*.cpp' | head -30\``);
    lines.push(`- \`grep -rn 'pattern' /workspace/${repoMap.submodules[0]!.localPath}/src/\``);
    lines.push("Use `edit` or `create` with the full path to modify files in any repository.");
    lines.push("");
    lines.push("**Committing**: You MUST `git add -A && git commit` **separately in each repository you modify**. Every commit needs BOTH a Conventional-Commits subject AND a body (2–4 sentences explaining what changed and why) — a subject-only commit is treated as missing.");
    lines.push("Use `bash` for commits in sub-repositories:");
    for (const sub of repoMap.submodules) {
      lines.push(`- \`cd /workspace/${sub.localPath} && git add -A && git commit -m 'feat(scope): subject' -m 'Body explaining what changed and why.'\``);
    }
    lines.push("For the root repository, commit from `/workspace/`.");
    lines.push("");
    lines.push("**Focus on implementation, not exploration.** Limit exploration to what you need, then edit and commit.");
    lines.push("");
  }

  lines.push("### Instructions");
  lines.push(instructionsPromptContent);
  lines.push("");
  if (context.cycleNumber > 1) {
    lines.push(`This is cycle number ${context.cycleNumber}. The repository has been checked out at your previous patchset — your prior work is already in the workspace. Address the review feedback above by amending existing commits or adding new commits as needed. Do NOT start from scratch.`);
  } else {
    lines.push(`This is cycle number ${context.cycleNumber}. The workspace is a FRESH CLONE of the repository — it contains NO previous changes, no prior work. You must implement the full task from scratch.`);
  }
  if (context.ticketUrl) lines.push(`Ticket URL: ${context.ticketUrl}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Runs code-generation via a Docker agent container (Dockerfile.agent / agent-worker/dist/index.js).
 * The host owns clone, commit, and push; the container is isolated to an agent-only network.
 * Agent commits must include `COMMIT_MSG: <type>(<scope>): <subject>` for conventional-commit extraction.
 */
export class CopilotAdapter implements AgentAdapter, ConfigurableAdapter {
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

  /**
   * Wire the adapter to its runtime dependencies.
   * Implements ConfigurableAdapter so the bootstrap needs no knowledge of
   * CopilotAdapter internals — it just checks for `configure` and calls it.
   */
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
    // Security: only task-specific vars are passed here; agent-worker/dist/index.js further
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
      ...(session.repositoryMap !== undefined
        ? { REPOSITORY_MAP_JSON: JSON.stringify(session.repositoryMap) }
        : {}),
      ...(session.existingChangeId !== undefined
        ? { ROOT_CHANGE_ID: session.existingChangeId }
        : {}),
      ...(session.perRepoChangeIds !== undefined
        ? { PER_REPO_CHANGE_IDS_JSON: JSON.stringify(session.perRepoChangeIds) }
        : {}),
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
      command: ["node", "/agent-worker/dist/index.js"],
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

    const systemPromptId = context.systemPromptId === undefined ? "system_generic_code" : context.systemPromptId;
    const instructionsPromptId = context.instructionsPromptId === undefined
      ? "instructions_generic_code"
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
    const encrypted = context.agentSession.encryptedSessionToken;
    if (encrypted) {
      return decryptToken(encrypted, getConfig().adminAuthSecret);
    }
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
