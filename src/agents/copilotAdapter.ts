import { randomUUID } from "crypto";
import type {
  AgentAdapter,
  ConfigurableAdapter,
  AgentResult,
  AgentLogEvent,
  TaskContext,
  FeedbackItem,
  ExternalChangeId,
  AdapterContainerSpec,
  AgentEgressSpec,
  PromptStore,
  ReviewWorkspaceInput,
  WorkspaceRunner,
} from "../interfaces.js";
import { makeExternalChangeId } from "../interfaces.js";
import { getLogger } from "../logger.js";
import { DEFAULT_COPILOT_MODEL } from "../copilotModel.js";
import { decryptRequiredManagedCredential } from "../utils/encryption.js";
import { assertPromptRole } from "../utils/promptRole.js";
import { getConfig } from "../config.js";
import {
  extractToolAuthorization,
  toolListEnv,
} from "./toolAuthorization.js";
import {
  buildCodegenContainerSpec,
  buildReviewContainerSpec as buildSharedReviewContainerSpec,
  systemPromptEnv,
} from "./containerSpecBuilders.js";
import { createStderrPipeline } from "./agentStderrPipeline.js";
import type { StderrParseState } from "./agentStderrPipeline.js";

// Re-export for backward compatibility — callers that import from copilotAdapter continue to work.
export { agentLogBus, getTaskEventBuffer, clearTaskEventBuffer } from "./agentEventBus.js";

const log = getLogger("copilot-adapter");

/**
 * Network egress the Copilot CLI needs under the OpenShell deny-by-default
 * runtime. `api.githubcopilot.com` serves completions (POST → needs `full`
 * access); `api.github.com` serves token/auth. The calls are made by the native
 * Copilot CLI binary (`copilot-linux-x64/copilot`, spawned by the npm loader),
 * not by `node`, so both are listed as permitted binaries.
 */
const COPILOT_EGRESS: AgentEgressSpec = {
  hosts: [
    "api.githubcopilot.com",
    "api.github.com",
    "api.business.githubcopilot.com",
    "origin-tracker.business.githubcopilot.com",
    "proxy.business.githubcopilot.com",
    "telemetry.business.githubcopilot.com",
  ],
  binaries: [
    "/app/agent-worker/node_modules/@github/copilot-linux-x64/copilot",
  ],
};

export interface CopilotAdapterConfig {
  model: string;
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

const DEFAULT_CONFIG: CopilotAdapterConfig = {
  model: DEFAULT_COPILOT_MODEL,
  maxRepositoryContextBytes: 120_000,
  maxCommitsPerCycle: 10,
};

/**
 * Build the user prompt the runner uploads into the sandbox for a code-generation cycle.
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
    lines.push("git add -A");
    lines.push("git commit -m 'type(scope): short imperative subject' \\");
    lines.push("           -m 'Body: explain WHAT changed and WHY in 2-4 sentences. Reference the ticket goal.'");
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
    lines.push("This workspace contains multiple repositories cloned side-by-side under your current working directory (the repository root):");
    lines.push(`- **${repoMap.superproject.repoKey}** (root): the current working directory — use \`glob\`, \`grep\`, \`view\`, \`edit\` normally`);
    for (const sub of repoMap.submodules) {
      lines.push(`- **${sub.repoKey}**: \`${sub.localPath}/\` (relative to the root) — use \`bash\` for discovery, \`edit\`/\`create\` for changes`);
    }
    lines.push("");
    lines.push("For the root repository, use the standard tools (`glob`, `grep`, `view`, `edit`) as usual.");
    lines.push("For sub-repositories, `glob`/`grep`/`view` cannot reach them. Use `bash` only for discovery:");
    lines.push(`- \`find ${repoMap.submodules[0]!.localPath}/ -name '*.cpp' | head -30\``);
    lines.push(`- \`grep -rn 'pattern' ${repoMap.submodules[0]!.localPath}/src/\``);
    lines.push("Use `edit` or `create` with the full path to modify files in any repository.");
    lines.push("");
    lines.push("**Committing**: You MUST `git add -A && git commit` **separately in each repository you modify**. Every commit needs BOTH a Conventional-Commits subject AND a body (2–4 sentences explaining what changed and why) — a subject-only commit is treated as missing.");
    lines.push("Use `bash` for commits in sub-repositories:");
    for (const sub of repoMap.submodules) {
      lines.push(`- \`cd ${sub.localPath} && git add -A && git commit -m 'feat(scope): subject' -m 'Body explaining what changed and why.'\``);
    }
    lines.push("For the root repository, commit from the repository root (your current working directory).");
    lines.push("");
    lines.push("**Focus on implementation, not exploration.** Limit exploration to what you need, then edit and commit.");
    lines.push("");
  }

  // Only origins VE cannot push to need patch guidance; internal and forked components are edited normally.
  const vendorComponents = (context.agentSession.vendorComponents ?? [])
    .filter((entry) => entry.origin === "patch_required" || entry.origin === "ambiguous");
  if (vendorComponents.length > 0) {
    lines.push("### Vendored / External Components");
    lines.push("These paths declare third-party sources that VE cannot push to. Do NOT edit the upstream source; add a patch through the mechanism the declaring file already uses (for example a `.bbappend` plus patch file, or the contrib rules).");
    for (const entry of vendorComponents) {
      const label = entry.origin === "ambiguous" ? "ambiguous — confirm before changing" : "patch required";
      // One manifest often declares many components, so name the component and keep the manifest as context.
      const subject = entry.localPath && entry.localPath !== entry.sourcePath
        ? `\`${entry.localPath}\` (declared in \`${entry.sourcePath}\`)`
        : `\`${entry.sourcePath}\``;
      lines.push(`- ${subject} (${label})`);
    }
    lines.push("");
  }

  lines.push("### Instructions");
  lines.push(instructionsPromptContent);
  lines.push("");
  if (context.hasPriorPatchset) {
    lines.push(`This is cycle number ${context.cycleNumber}. The repository has been checked out at your previous patchset — your prior work is already in the workspace. Address the review feedback above by amending existing commits or adding new commits as needed. Do NOT start from scratch.`);
  } else {
    lines.push(`This is cycle number ${context.cycleNumber}. The workspace is a FRESH CLONE of the repository — it contains NO previous changes, no prior work. You must implement the full task from scratch.`);
  }
  if (context.ticketUrl) lines.push(`Ticket URL: ${context.ticketUrl}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Runs code-generation via a Docker agent container (Dockerfile.agent / agent-worker/src/index.ts → dist/index.js).
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
    // Security: only task-specific vars are passed here; agent-worker/src/index.ts further
    // filters to a minimal whitelist — DB credentials and API tokens are never exposed.

    const copilotModel = context.agentSession.copilotModel ?? this.config.model;
    const reasoningEffort = session.providerOptions?.["reasoningEffort"];

    const providerEnv: Record<string, string> = {
      ...authEnv,
      COPILOT_MODEL: copilotModel,
      ...(typeof reasoningEffort === "string" && reasoningEffort.trim()
        ? { COPILOT_REASONING_EFFORT: reasoningEffort.trim() }
        : {}),
      ...toolListEnv("copilot", extractToolAuthorization(session.providerOptions)),
    };

    return buildCodegenContainerSpec(context, {
      providerEnv,
      maxRepositoryContextBytes: this.config.maxRepositoryContextBytes,
      maxCommitsPerCycle: this.config.maxCommitsPerCycle,
      promptsDir: this.config.promptsDir,
      egress: COPILOT_EGRESS,
    });
  }

  /** Builds a container spec for review mode (REVIEW_MODE=1). Reads the prompt from the file the runner uploads into the sandbox. */
  buildReviewContainerSpec(
    input: ReviewWorkspaceInput,
    authEnv: Record<string, string> = {}
  ): AdapterContainerSpec {
    const nativeReview = input.reviewStrategy === "copilot_native";
    const reasoningEffort = input.providerOptions?.["reasoningEffort"];
    const providerEnv: Record<string, string> = {
      ...authEnv,
      GITHUB_TOKEN: input.agentToken,
      ...(!nativeReview ? { COPILOT_MODEL: input.model ?? this.config.model } : {}),
      ...(!nativeReview && typeof reasoningEffort === "string" && reasoningEffort.trim()
        ? { COPILOT_REASONING_EFFORT: reasoningEffort.trim() }
        : {}),
      ...toolListEnv("copilot", extractToolAuthorization(input.providerOptions)),
      ...(input.reviewOutputSchema !== undefined
        ? { REVIEW_OUTPUT_SCHEMA: JSON.stringify(input.reviewOutputSchema) }
        : {}),
    };

    return buildSharedReviewContainerSpec(input, {
      providerEnv,
      egress: COPILOT_EGRESS,
    });
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

    if (!systemPrompt) throw new Error(`System prompt '${systemPromptId}' not found`);
    if (!instructionsPrompt) throw new Error(`Instructions prompt '${instructionsPromptId}' not found`);
    assertPromptRole(systemPrompt, "system");
    assertPromptRole(instructionsPrompt, "instructions");

    Object.assign(spec.env, systemPromptEnv(systemPrompt.content));
    spec.userPromptContent = buildCodegenUserPrompt(context, instructionsPrompt.content);

    return spec;
  }

  // ── authentication ────────────────────────────────────────────────────────

  /** Retrieve the GitHub OAuth token, preferring the encrypted session token from agent config. */
  private getGitHubOAuthToken(context: TaskContext): Promise<string> {
    // Not async: errors here must surface as a
    // rejected promise, not a synchronous throw, for await/`.catch()` callers.
    try {
      const encrypted = context.agentSession.encryptedSessionToken;
      if (encrypted) {
        return Promise.resolve(decryptRequiredManagedCredential(encrypted, getConfig().adminAuthSecret));
      }
      if (context.agentSession.githubToken) {
        return Promise.resolve(context.agentSession.githubToken);
      }
      throw new Error("No Copilot session token or GitHub token available. Connect via OAuth in the admin dashboard.");
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(typeof err === "string" ? err : JSON.stringify(err)));
    }
  }

  // ── container runner ──────────────────────────────────────────────────────

  /** Spawn the agent container and return its parsed AgentResult. Worker writes a JSON line to stdout. */
  private async runAgentContainer(
    context: TaskContext,
    githubToken: string,
    changeId: ExternalChangeId
  ): Promise<AgentResult> {
    const stderrPipeline = createStderrPipeline(context, {
      adapterName: "copilot",
      log,
      onEvent: (event) => this.logLiveAgentEvent(context, event),
    });
    let invocation: DockerInvocationResult;
    try {
      invocation = await this.invokeAgentContainer(context, githubToken, {
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

    const result = await this.parseAgentResult(
      context,
      invocation.stdout,
      invocation.stderr,
      stderrPipeline.state
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

  private setupFailureResult(message: string, stderrState: StderrParseState): AgentResult {
    const plainLogs = stderrState.plainLogLines.join("\n");
    return {
      status: "failed",
      modifiedFiles: [],
      summary: "Agent setup failed before container output",
      agentLogs: [plainLogs, message].filter(Boolean).join("\n"),
      agentEvents: stderrState.agentEvents,
      metadata: {
        adapter: "copilot",
        setupError: true,
        error: message.slice(0, 300),
      },
    };
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
    let parseState: StderrParseState;
    if (stderrState) {
      parseState = stderrState;
    } else {
      const fallbackPipeline = createStderrPipeline(context, {
        adapterName: "copilot",
        log,
        onEvent: (event) => this.logLiveAgentEvent(context, event),
      });
      fallbackPipeline.consumeChunk(stderr);
      fallbackPipeline.flush();
      parseState = fallbackPipeline.state;
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

}
