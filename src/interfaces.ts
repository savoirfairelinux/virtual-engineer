/** Core domain types and interface contracts. */

// ─── Shared value types ───────────────────────────────────────────────────────

export type TaskId = string & { readonly __brand: "TaskId" };
export type TicketId = string & { readonly __brand: "TicketId" };
export type ExternalChangeId = string & { readonly __brand: "ExternalChangeId" };
export type AgentId = string & { readonly __brand: "AgentId" };
export type ProjectId = string & { readonly __brand: "ProjectId" };

/** Cast a plain string to the branded `TaskId` type. */
export function makeTaskId(s: string): TaskId {
  return s as TaskId;
}
/** Cast a plain string to the branded `TicketId` type. */
export function makeTicketId(s: string): TicketId {
  return s as TicketId;
}
/** Cast a plain string to the branded `ExternalChangeId` type. */
export function makeExternalChangeId(s: string): ExternalChangeId {
  return s as ExternalChangeId;
}
/** Cast a plain string to the branded `AgentId` type. */
export function makeAgentId(s: string): AgentId {
  return s as AgentId;
}
/** Cast a plain string to the branded `ProjectId` type. */
export function makeProjectId(s: string): ProjectId {
  return s as ProjectId;
}

// ─── Phase 2: Agents / Projects / Concurrency types ───────────────────────────

export type AgentType = "coding" | "review";
export type ProjectType = "coding" | "review";
export type PushTargetRole = "primary" | "submodule" | "dependency" | "related";

export interface AgentRecord {
  id: AgentId;
  name: string;
  type: AgentType;
  /** JSON-serialised model config: { model?, apiKey?, ... } */
  modelConfigJson: string;
  /** FK to the integrations table (AI adapter). Null when unlinked. */
  integrationId: string | null;
  systemPromptId: string | null;
  instructionsPromptId: string | null;
  /** Optional override used on retry (feedback) cycles. Falls back to instructionsPromptId when null. */
  feedbackInstructionsPromptId: string | null;
  maxConcurrent: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectRecord {
  id: ProjectId;
  name: string;
  type: ProjectType;
  agentId: AgentId;
  /** JSON partial-merge override applied on top of the agent's modelConfigJson + prompts. NULL = no override. */
  agentOverrideJson: string | null;
  /** Bash script run on the host after cloning. Empty string means "no script". */
  postCloneScript: string;
  /** When true, the agent container loads team-defined skills from `<repo>/.github/skills` (coding projects only). */
  skillDiscoveryEnabled: boolean;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectTicketSourceRecord {
  id: number;
  projectId: ProjectId;
  integrationId: string;
  /** Project key in the ticket system (e.g. "PLATFORM", "my-org/sdk"). */
  ticketProjectKey: string;
  createdAt: Date;
}

/**
 * A project's choice to use an integration for a specific domain capability,
 * with per-binding configuration (e.g. `{ ticketProjectKey }` for
 * `issue_tracking`, `{ repoKeys }` for `code_review`).
 */
export interface ProjectIntegrationBindingRecord {
  id: string;
  projectId: ProjectId;
  integrationId: string;
  capability: DomainCapability;
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectPushTargetRecord {
  id: number;
  projectId: ProjectId;
  integrationId: string;
  /** Unique key within the project (e.g. "superproject", "core-lib"). */
  repoKey: string;
  cloneUrl: string;
  targetBranch: string;
  role: PushTargetRole;
  /** 1..N for deterministic multi-repo commit order. */
  commitOrder: number;
  /** Workspace-relative path (e.g. ".", "libs/core"). */
  localPath: string;
  sshKeyPath: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Review-project configuration: integration + covered repos. */
export interface ProjectReviewConfig {
  integrationId: string;
  /** Inclusion list — all repos selected at project-creation time. */
  repos: string[];
}

/** A single PR/MR that VE has been requested to review. */
export interface ReviewAssignmentDiscovery {
  /** Provider-specific change ID, e.g. `"owner/repo#42"` for GitHub. */
  changeId: string;
  /** Repository key, e.g. `"owner/repo"`. */
  project: string;
  subject?: string | undefined;
}

/**
 * Optional capability exposed by review connectors that support polling for
 * open PRs / MRs where VE has been assigned as a reviewer.
 *
 * The polling loop checks for this interface on the unbound integration
 * connector at each tick and fires a review trigger for every discovered
 * assignment that does not yet have an active review task.
 */
export interface ReviewDiscoveryConnector {
  getOpenReviewAssignments(repos: string[]): Promise<ReviewAssignmentDiscovery[]>;
}

/** Optional VE project-owned binding data used to specialize integration connectors at runtime. */
export interface IntegrationBindingContext {
  /** Ticket-system project selector owned by the VE project configuration. */
  ticketProjectKey?: string | undefined;
  /** Repository key owned by the VE project configuration. */
  repoKey?: string | undefined;
  /** Target branch for PR/MR creation, taken from the project push-target config. */
  targetBranch?: string | undefined;
}

/** Resolved agent config after merging project override on top of agent defaults. */
export interface ResolvedAgentConfig {
  model: string | undefined;
  apiKey: string | undefined;
  /** Encrypted Copilot session token from OAuth device flow. */
  encryptedSessionToken: string | undefined;
  systemPromptId: string | null;
  instructionsPromptId: string | null;
  /** Optional override used on retry (feedback) cycles. Falls back to instructionsPromptId when null. */
  feedbackInstructionsPromptId: string | null;
  /** Any other model-related fields preserved from agent + override (override wins). */
  extra: Record<string, unknown>;
}

// ─── Task state machine ───────────────────────────────────────────────────────

/** States belonging to the ticket-driven code-generation workflow. */
export const CODE_GEN_STATES = [
  "DETECTED",
  "CONTEXT_BUILDING",
  "AGENT_RUNNING",
  "IN_REVIEW",
  "FEEDBACK_PROCESSING",
  "RETRY_CYCLE",
  "MERGED",
  "CLOSING",
  "DONE",
  "FAILED",
  "ABANDONED",
] as const;

/** States belonging to the VE-as-reviewer code-review workflow. */
export const CODE_REVIEW_STATES = [
  "REVIEW_PENDING",
  "REVIEW_RUNNING",
  "REVIEW_COMMENTING",
  "REVIEW_WATCHING",
  "REVIEW_DONE",
  "REVIEW_FAILED",
] as const;

export type CodeGenState = (typeof CODE_GEN_STATES)[number];
export type CodeReviewState = (typeof CODE_REVIEW_STATES)[number];

/** Union of all task states across both workflows. */
export const TASK_STATES = [...CODE_GEN_STATES, ...CODE_REVIEW_STATES] as const;

export type TaskState = CodeGenState | CodeReviewState;

/** "code-gen" = ticket-driven flow; "code-review" = VE acts as reviewer. */
export type TaskType = "code-gen" | "code-review";

/** Terminal states for the code-generation workflow. */
export const CODE_GEN_TERMINAL_STATES: ReadonlySet<CodeGenState> = new Set<CodeGenState>([
  "DONE",
  "FAILED",
  "ABANDONED",
]);

/** Terminal states for the code-review workflow. */
export const CODE_REVIEW_TERMINAL_STATES: ReadonlySet<CodeReviewState> = new Set<CodeReviewState>([
  "REVIEW_DONE",
  "REVIEW_FAILED",
]);

/** Terminal states across both workflows — no further transitions allowed. */
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  ...CODE_GEN_TERMINAL_STATES,
  ...CODE_REVIEW_TERMINAL_STATES,
]);

// ─── Agent interfaces ─────────────────────────────────────────────────────────

export interface FeedbackItem {
  source: "gerrit_review" | "github_review" | "test_failure" | "lint_failure" | "ci_failure";
  content: string;
  filePath?: string | undefined;
  line?: number | undefined;
  _gerritCommentId?: string | undefined; // For gerrit_review source — used to resolve Gerrit comments
}

/** Describes one repository entry in a multi-repo workspace layout. */
export interface RepositoryMapEntry {
  repoKey: string;
  localPath: string;
}

/** Multi-repo workspace layout passed to the agent container via REPOSITORY_MAP_JSON. */
export interface RepositoryMap {
  superproject: RepositoryMapEntry;
  submodules: RepositoryMapEntry[];
}

export interface AgentSession {
  /** Container image used for the ephemeral Git/GH agent session */
  agentContainerImage: string;
  /** Repository clone URL the agent must use inside the ephemeral container */
  repoCloneUrl: string;

  // ── Review-system push config ───────────────────────────────────────────────
  /** Ref to push to. For Gerrit: refs/for/<branch>. For GitLab: the feature branch name. */
  pushRef: string;
  /** Existing external change ID to reuse (Gerrit: reuses the patchset; GitLab: reuses the MR branch). */
  existingChangeId?: ExternalChangeId | undefined;
  /**
   * Per-repo change IDs for retry cycles.
   * When value is a string, it is the Change-Id for commitIndex 0 (legacy/single-commit).
   * When value is a Record<string, string>, keys are string commit indices ("0", "1", …)
   * mapped to their respective Change-Ids.
   */
  perRepoChangeIds?: Record<string, string | Record<string, string>> | undefined;

  /** Git identity configured inside the agent session */
  gitAuthorName: string;
  gitAuthorEmail: string;
  /** GitHub token used for Copilot */
  githubToken?: string | undefined;
  /** Encrypted Copilot session token from OAuth device flow. */
  encryptedSessionToken?: string | undefined;
  /** Optional per-task Copilot model override resolved from agent/project config. */
  copilotModel?: string | undefined;
  /** Optional reasoning effort level for models that support it (e.g. "low" | "medium" | "high" | "xhigh"). */
  copilotReasoningEffort?: string | undefined;
  /** Multi-repo workspace layout — when set, agent-worker uses it to group files/commits by repo. */
  repositoryMap?: RepositoryMap | undefined;
  /** When true, the agent loads team-defined skills from `<repo>/.github/skills`. Sourced from the project's setting. */
  skillDiscoveryEnabled?: boolean | undefined;
}

export interface TaskContext {
  taskId: TaskId;
  ticketTitle: string;
  ticketDescription: string;
  acceptanceCriteria: string[];
  baseBranch: string;
  /** Absolute path to the ephemeral workspace directory */
  workspacePath: string;
  /** Named volume for the workspace (repo files) */
  volumeName: string;
  /** Named volume for the agent HOME directory */
  homeVolumeName: string;
  /** Constraints e.g. "do not add new dependencies" */
  constraints: string[];
  priorFeedback: FeedbackItem[];
  cycleNumber: number;
  /**
   * True if a prior patchset was successfully checked out into the workspace
   * volume before this cycle started. When true the agent should amend/extend
   * existing commits rather than start from scratch.
   */
  hasPriorPatchset?: boolean;
  /** Commit message the agent must use for direct Gerrit submission */
  commitMessage: string;
  /** Optional link back to the originating ticket for traceability */
  ticketUrl?: string | undefined;
  /** Optional prompt ids resolved from the linked agent/project. */
  systemPromptId?: string | null | undefined;
  instructionsPromptId?: string | null | undefined;
  /** Connection/session material the agent uses directly */
  agentSession: AgentSession;
}

export interface AgentLogEvent {
  type: string;
  timestamp: string;   // ISO 8601
  data: unknown;
  taskId: string;
  cycleNumber: number;
}

export type AgentResultStatus = "success" | "no_change" | "failed";

/** A single commit created by the agent inside the container. */
export interface CommitDescriptor {
  /** Repository key this commit belongs to (e.g., "superproject", "core-lib") */
  repoKey: string;
  /** Full commit SHA */
  sha: string;
  /** First line of the commit message (Conventional Commits subject) */
  subject: string;
  /** Remainder of the commit message body (after blank line) */
  body: string;
  /** Gerrit Change-Id from the commit footer, if present */
  changeId: string;
  /** Relative file paths touched by this commit */
  files: string[];
}

export interface AgentResult {
  status: AgentResultStatus;
  /** List of relative paths that were modified (single-repo: string[], multi-repo: Record<repoKey, string[]>) */
  modifiedFiles: string[] | Record<string, string[]>;
  /** Commits created by the agent. When non-empty, host skips its own commit step. */
  commits?: CommitDescriptor[] | undefined;
  /** Human-readable summary of changes (LLM prose output, audit trail) */
  summary: string;
  /** Raw agent output for audit trail */
  agentLogs: string;
  /** Structured agent log events captured from the agent worker */
  agentEvents?: AgentLogEvent[] | undefined;
  /** Gerrit Change-Id used by the agent when it pushed the change */
  externalChangeId?: ExternalChangeId | undefined;
  /** Commit SHA produced by the agent for the submitted patchset */
  commitSha?: string | undefined;
  metadata: Record<string, unknown>;
}

export interface AdapterContainerSpec {
  /** Container image used to run the adapter workload */
  image: string;
  /** Environment variables to inject into the container */
  env: Record<string, string>;
  /** Command executed in the container */
  command: string[];
  /** Optional network override for the container */
  networkMode?: string | undefined;
  /** Optional extra docker args such as mounts or security options */
  additionalDockerArgs?: string[] | undefined;
  /** Written to home volume as `user-prompt.txt`; sets `USER_PROMPT_FILE` in container env. */
  userPromptContent?: string | undefined;
}

/** AI engine adapter interface. Host owns clone, commit, and push. */
export interface AgentAdapter {
  readonly name: string;
  buildContainerSpec(context: TaskContext, authEnv?: Record<string, string>): AdapterContainerSpec;
  execute(context: TaskContext): Promise<AgentResult>;
}

/**
 * Optional interface for adapters that need post-construction wiring.
 * Implementing `configure` moves adapter-specific setup out of the bootstrap
 * and into the adapter itself; `index.ts` only needs to duck-check for it.
 */
export interface ConfigurableAdapter extends AgentAdapter {
  configure(deps: { store: PromptStore; runner: WorkspaceRunner }): void;
}

// ─── Workspace interfaces ─────────────────────────────────────────────────────

export interface WorkspaceHandle {
  taskId: TaskId;
  containerId: string;
  /** Named volume for the workspace (repo files) */
  volumeName: string;
  /** Named volume for the agent HOME directory (Copilot CLI native modules) */
  homeVolumeName: string;
  /** In-container path (always /workspace for named-volume mode) */
  hostWorkspacePath: string;
  /** Docker image used for helper containers (clone, push, scripts) */
  containerImage: string;
}

export type ValidationStatus = "passed" | "failed" | "skipped";

export interface ValidationResult {
  status: ValidationStatus;
  testOutput: string;
  lintOutput: string;
  durationMs: number;
}

export interface CloneResult {
  success: boolean;
  localPath: string;
  error?: string;
}

/** Input for running the review agent container. Workspace must be pre-cloned and patched. */
export interface ReviewWorkspaceInput {
  /** Change-Id (opaque string, e.g. "Iabc123..." for Gerrit, PR node id for GitHub) */
  changeId: ExternalChangeId;
  /** Provider-specific numeric change identifier (e.g. Gerrit change number, PR number) */
  revisionNumber: number;
  /** Provider-specific patchset/revision version number (e.g. Gerrit patchset, GitHub review round) */
  patchset: number;
  /** Repository name as understood by the review provider (e.g. Gerrit project, GitHub repo) */
  repositoryName: string;
  /** The user prompt (diff + instructions) to send to the agent */
  prompt: string;
  /** System prompt passed as SYSTEM_PROMPT env var to the review container */
  systemPrompt: string;
  /** Authentication token for the agent integration (e.g. GitHub token for Copilot) */
  agentToken: string;
  /** Model override for the agent */
  model?: string | undefined;
  /** Reasoning effort override for the agent (e.g. "low" | "medium" | "high" | "xhigh") */
  reasoningEffort?: string | undefined;
  /** Container image (defaults to agentContainerImage from codegen config) */
  containerImage?: string | undefined;
  /** When true, the agent container loads team-defined skills from <repo>/.github/skills. */
  skillDiscoveryEnabled?: boolean | undefined;
}

/** Options for checking out a prior patchset/revision onto a cloned workspace. */
export interface PatchsetCheckoutOptions {
  /** VCS base URL (used to build the remote fetch URL) */
  vcsBaseUrl: string;
  /** Provider-specific numeric change identifier (e.g. Gerrit change number, PR number) */
  revisionNumber: number;
  /** Patchset/revision number to check out */
  patchset: number;
  /** Optional SSH key path; uses default git credential chain if absent */
  sshKeyPath?: string | undefined;
  /** Path to a known_hosts file. When set, SSH uses strict host key verification. */
  sshKnownHostsPath?: string | undefined;
  /** Gerrit SSH host (for SSH fetch; falls back to HTTP if absent) */
  sshHost?: string | undefined;
  /** Gerrit SSH port (default 29418) */
  sshPort?: number | undefined;
  /** Gerrit SSH user */
  sshUser?: string | undefined;
}

export interface WorkspaceRunner {
  /** Create a fresh ephemeral workspace directory/container for the agent */
  createWorkspace(taskId: TaskId): Promise<WorkspaceHandle>;
  /** Clone repository into the workspace — runs inside a helper container */
  cloneRepo(
    handle: WorkspaceHandle,
    repoUrl: string,
    branch: string,
    sshKeyPath?: string,
    sshKnownHostsPath?: string
  ): Promise<CloneResult>;
  /**
   * Clone every push target sorted by `commitOrder`, then run `postCloneScript`.
   * Per-target failures are logged but non-fatal; only root clone failure is hard.
   */
  prepareProjectWorkspace?(
    handle: WorkspaceHandle,
    pushTargets: ProjectPushTargetRecord[],
    postCloneScript?: string,
    sshKnownHostsPath?: string
  ): Promise<CloneResult>;
  /** Fetch and checkout a prior patchset ref as detached HEAD. */
  applyPriorPatchset?(
    handle: WorkspaceHandle,
    opts: PatchsetCheckoutOptions
  ): Promise<void>;
  /** Fetch a prior patchset ref and cherry-pick it on top of the current HEAD. */
  cherryPickPriorPatchset?(
    handle: WorkspaceHandle,
    opts: PatchsetCheckoutOptions
  ): Promise<void>;
  /** Run the review agent container against the cloned+patched workspace. */
  runReviewInDocker?(
    handle: WorkspaceHandle,
    input: ReviewWorkspaceInput,
    callbacks?: { onStderrChunk?: ((chunk: string) => void) | undefined } | undefined
  ): Promise<{ rawOutput: string }>;
  /** Spawn the adapter container and return raw stdout/stderr. Used by ConfigurableAdapter.configure. */
  runAgentInDocker?(
    adapter: AgentAdapter,
    context: TaskContext,
    authEnv?: Record<string, string>,
    callbacks?: { onStdoutChunk?: ((chunk: string) => void) | undefined; onStderrChunk?: ((chunk: string) => void) | undefined } | undefined
  ): Promise<{ stdout: string; stderr: string }>;
  /** Run agent adapter inside the ephemeral execution context. */
  runAgent(handle: WorkspaceHandle, context: TaskContext, adapter?: AgentAdapter): Promise<AgentResult>;
  /** Run a git command in the workspace volume; returns stdout or throws. */
  execGitInVolume?(
    handle: WorkspaceHandle,
    args: string[],
    subPath?: string
  ): Promise<string>;
  /** Destroy workspace/container — always call in finally block */
  destroyWorkspace(handle: WorkspaceHandle): Promise<void>;
}

// ─── Review system interfaces (system-agnostic) ─────────────────────────────

export type ReviewChangeStatus = "OPEN" | "MERGED" | "ABANDONED";

export interface ReviewChangeRef {
  changeId: ExternalChangeId;
  changeNumber: number;
  patchsetNumber: number;
  url: string;
}

export interface ReviewComment {
  id: string;
  author: string;
  message: string;
  filePath?: string | undefined;
  line?: number | undefined;
  unresolved: boolean;
  patchset: number;
  updatedAt: Date;
}

/** System-agnostic interface for interacting with a code review system. */
export interface ReviewConnector {
  /**
   * Optional: fetch failed CI check runs (e.g. GitHub Actions) for a change and return them
   * as ReviewComment objects for deduplication and agent feedback. Implementations should
   * return comments with `id` prefixed `"ci-run-{runId}"` for stable deduplication.
   */
  getCICheckFailures?(changeId: ExternalChangeId): Promise<ReviewComment[]>;
  /** Resolve a change reference from a known Change-Id or MR IID */
  getChange(changeId: ExternalChangeId): Promise<ReviewChangeRef>;

  getChangeStatus(changeId: ExternalChangeId): Promise<ReviewChangeStatus>;

  getUnresolvedComments(
    changeId: ExternalChangeId,
    sincePatchset?: number
  ): Promise<ReviewComment[]>;

  addChangeComment(changeId: ExternalChangeId, message: string): Promise<void>;

  /** Resolve comment threads that have been addressed */
  resolveComments(changeId: ExternalChangeId, comments: ReviewComment[]): Promise<void>;
}

/**
 * Union of all runtime plugin instance types stored in `PluginManager`.
 * Excludes `ReviewProvider` (created per-cycle) and `VcsConnector` (managed by `VcsFactory`).
 */
export type PluginInstance = TicketConnector | ReviewConnector | AgentAdapter;

// ─── Code Review (Reviewer-side) interfaces ───────────────────────────────────

/**
 * Severity from the review agent. Typed as `string` (not a strict union) because LLM output may use novel casing.
 * `computeVote` normalises: `'error'` → -1; `'warning'` → -1; `'suggestion'` → no vote change.
 */
export type ReviewSeverity = string;

/** A single inline comment to post on a specific file/line of a change. */
export interface InlineReviewComment {
  /** Path of the file relative to the repository root */
  file: string;
  /** 1-based line number in the patchset (target line). 0 means file-level comment. */
  line: number;
  /** Comment body */
  message: string;
  /** Severity used to compute the overall vote */
  severity: ReviewSeverity;
}

/** Status of a single file in a change diff. */
export type ReviewFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface ReviewDiffFile {
  /** Path of the file in the new revision (or old path for deletes) */
  path: string;
  /** Status of this file in the change */
  status: ReviewFileStatus;
  /** Unified diff hunk text for this file (may be empty for binary files) */
  patch: string;
}

export interface ReviewChangeDiff {
  changeId: ExternalChangeId;
  patchset: number;
  files: ReviewDiffFile[];
}

export interface ReviewChangeDetails {
  changeId: ExternalChangeId;
  changeNumber: number;
  subject: string;
  description: string;
  ownerAccountId: string;
  currentPatchset: number;
  status: ReviewChangeStatus;
  project: string;
  targetBranch: string;
  url: string;
}

/** Structured result returned by the review agent. */
export interface ReviewAgentResult {
  comments: InlineReviewComment[];
  /** High-level summary posted alongside the inline comments */
  summary: string;
  /** Suggested vote score: -1, 0, or +1. */
  score: -1 | 0 | 1;
  /** Replies to existing human discussion threads (empty when none). */
  replies: ThreadReply[];
}

/** A single comment inside a discussion thread on a change. */
export interface ReviewDiscussionComment {
  /** Display name or username of the comment author. */
  author: string;
  /** Comment body. */
  message: string;
  /** True when authored by VE itself (the reviewing account). */
  isOwn: boolean;
}

/**
 * A human discussion thread on a change, surfaced to the review agent so it can
 * reply. Integration-agnostic: `threadId` is whatever opaque token the provider
 * needs to post a reply (Gerrit comment id, GitLab discussion id, GitHub review
 * thread node id).
 */
export interface ReviewDiscussionThread {
  /** Opaque provider token used to post a reply to this thread. */
  threadId: string;
  /** File path the thread is anchored to, or null for change-level discussion. */
  file: string | null;
  /** 1-based line number, or null when not line-anchored. */
  line: number | null;
  /** Whether the thread is marked resolved on the provider. */
  resolved: boolean;
  /** Ordered comments in the thread (oldest first). */
  comments: ReviewDiscussionComment[];
}

/** A reply the agent wants to post to an existing discussion thread. */
export interface ThreadReply {
  /** The `threadId` of the thread being replied to. */
  threadId: string;
  /** Reply body. */
  message: string;
}

/** A persisted record of an inline review comment VE has already posted on a change. */
export interface PostedReviewComment {
  id: number;
  taskId: TaskId;
  changeId: ExternalChangeId;
  /** Stable content hash (see review/commentHash.ts). */
  commentHash: string;
  file: string;
  line: number;
  message: string;
  severity: string;
  /** Provider-side thread/comment id captured for later resolution. */
  providerThreadId: string | null;
  resolved: boolean;
  createdAt: Date;
}

/** Input shape for recording a freshly-posted review comment. */
export interface PostedReviewCommentInput {
  commentHash: string;
  file: string;
  line: number;
  message: string;
  severity: string;
  providerThreadId?: string | null | undefined;
}

/** Input shape for recording a reply VE posted to a human discussion thread. */
export interface ThreadReplyRecordInput {
  /** Opaque provider thread token the reply was posted to. */
  threadId: string;
  /** Dedup hash of thread id + answered human message (see computeThreadReplyHash). */
  handledCommentHash: string;
  /** The reply body VE posted. */
  replyMessage: string;
}

/**
 * System-agnostic interface for VE acting as a code reviewer.
 * Counterpart to ReviewConnector (used when VE is the change author).
 */
export interface ReviewProvider {
  /** Stable label identifying the underlying system (e.g. "gerrit"). */
  readonly kind: string;

  /** Fetch full details for one change (current patchset, owner, status). */
  getChangeDetails(changeId: ExternalChangeId): Promise<ReviewChangeDetails>;

  /** Fetch the diff for a specific patchset (defaults to current). */
  getChangeDiff(changeId: ExternalChangeId, patchset?: number): Promise<ReviewChangeDiff>;

  /**
   * Post inline comments and a summary on the given revision.
   *
   * `allowedFiles`, when provided, restricts the comments actually submitted to
   * files present in the patchset diff. Comments referencing files outside this
   * set are dropped and logged. This guards against the underlying API (e.g.
   * Gerrit `review --json`) rejecting the whole batch on a single unknown path.
   */
  postReviewComments(
    changeId: ExternalChangeId,
    revision: number,
    comments: InlineReviewComment[],
    summary: string,
    allowedFiles?: ReadonlySet<string>
  ): Promise<void>;

  /**
   * Post inline comments + vote atomically (optional; reviewOrchestrator falls back
   * to separate postReviewComments + vote calls when absent).
   *
   * `allowedFiles` semantics are the same as on `postReviewComments`. If all
   * comments are filtered out, the vote and summary are still submitted.
   */
  postReviewWithComments?(
    changeId: ExternalChangeId,
    revision: number,
    comments: InlineReviewComment[],
    summary: string,
    score: -1 | 1,
    allowedFiles?: ReadonlySet<string>
  ): Promise<void>;

  /** Cast a Code-Review-style vote (-1, 0, or +1). */
  vote(
    changeId: ExternalChangeId,
    revision: number,
    score: number,
    message?: string
  ): Promise<void>;

  /**
   * Returns true if VE is an active reviewer on an OPEN change (self-review guard included).
   * Optional — omitting falls back to unconditional review creation.
   */
  isReviewer?(changeId: ExternalChangeId): Promise<boolean>;

  /**
   * Fetch open discussion threads on the change so the review agent can reply.
   * Optional — providers that do not support thread fetching omit it, and the
   * orchestrator simply skips the reply flow.
   */
  getDiscussionThreads?(changeId: ExternalChangeId): Promise<ReviewDiscussionThread[]>;

  /**
   * Post a reply to an existing discussion thread identified by `threadId`.
   * Optional — paired with `getDiscussionThreads`.
   */
  postThreadReply?(
    changeId: ExternalChangeId,
    revision: number,
    threadId: string,
    message: string
  ): Promise<void>;
}

// ─── Ticket interfaces ─────────────────────────────────────────────────────────

export interface Ticket {
  id: TicketId;
  subject: string;
  description: string;
  status: string;
  assigneeId: number;
  projectId: number;
  customFields: Record<string, string>;
  /** Web URL to the ticket (populated by connectors that know the URL, e.g. GitLab) */
  webUrl?: string;
}

export interface AssignedTicketQueryOptions {
  /** Project key (Redmine identifier or GitLab project path) to filter assigned tickets. */
  projectKey?: string | undefined;
}

export interface TicketConnector {
  /** Poll for tickets assigned to the virtual-engineer user */
  getAssignedTickets(opts?: AssignedTicketQueryOptions): Promise<Ticket[]>;
  getTicket(ticketId: TicketId): Promise<Ticket>;
  addNote(ticketId: TicketId, note: string, isPrivate?: boolean): Promise<void>;
  transitionStatus(ticketId: TicketId, targetStatusId: number): Promise<void>;
  /** Transition to the "in progress" workflow state (semantics owned by the connector). */
  transitionToInProgress(ticketId: TicketId): Promise<void>;
  /** Transition to the "in review" workflow state (semantics owned by the connector). */
  transitionToInReview(ticketId: TicketId): Promise<void>;
  closeTicket(ticketId: TicketId, closingNote: string): Promise<void>;
  /** Return the source label for this connector (e.g., 'redmine', 'gitlab') */
  getSourceLabel(): string;
}

// ─── HTTP connector base error ───────────────────────────────────────────────

/** Shared base for HTTP-based connector failures (ticket and review systems). */
export class ApiHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly url: string,
    public readonly body: string
  ) {
    super(`API error ${statusCode} on ${url}: ${body}`);
    this.name = "ApiHttpError";
  }
}

// ─── Ticket connector error types ────────────────────────────────────────────

/** Base error for ticket-connector HTTP failures. */
export class TicketApiError extends ApiHttpError {
  constructor(
    statusCode: number,
    url: string,
    body: string
  ) {
    super(statusCode, url, body);
    this.message = `Ticket API error ${statusCode} on ${url}: ${body}`;
    this.name = "TicketApiError";
  }
}

/** Raised when a ticket resource returns HTTP 404. */
export class TicketNotFoundError extends TicketApiError {
  constructor(statusCode: number, url: string, body: string) {
    super(statusCode, url, body);
    this.name = "TicketNotFoundError";
  }
}

// ─── Review connector error types ────────────────────────────────────────────

/** Base error for review-connector HTTP failures. */
export class ReviewApiError extends ApiHttpError {
  constructor(
    statusCode: number,
    url: string,
    body: string
  ) {
    super(statusCode, url, body);
    this.message = `Review API error ${statusCode} on ${url}: ${body}`;
    this.name = "ReviewApiError";
  }
}

/** Raised when a review resource returns HTTP 404. */
export class ReviewNotFoundError extends ReviewApiError {
  constructor(statusCode: number, url: string, body: string) {
    super(statusCode, url, body);
    this.name = "ReviewNotFoundError";
  }
}

// ─── State Store interfaces ───────────────────────────────────────────────────

export interface Task {
  taskId: TaskId;
  ticketId: TicketId;
  ticketSourceLabel: string;
  ticketTitle: string;
  ticketDescription: string;
  state: TaskState;
  /** Discriminator: "code-gen" (default) or "code-review". */
  taskType: TaskType;
  externalChangeId: ExternalChangeId | null;
  currentPatchset: number;
  /** For code-review tasks: last patchset reviewed by VE. NULL otherwise. */
  reviewedPatchset: number | null;
  cycleCount: number;
  createdAt: Date;
  updatedAt: Date;
  failureReason: string | null;
  ticketUrl: string | null;
  reviewUrl: string | null;
  /** Project ID (null for legacy tasks). */
  projectId?: ProjectId | null | undefined;
  /** Human-readable identifier for the UI (e.g. ticket number, Gerrit change number). */
  displayId: string | null;
  /** Persisted feature branch ref for the first push; null for legacy tasks (falls back to legacy naming on resume). */
  pushRef?: string | null;
}

/** Per-repository change tracking (Gerrit Change-Id or GitLab MR IID) for multi-repo tasks. */
export interface ChangePerRepository {
  id: string;
  taskId: TaskId;
  repoKey: string;
  changeId: string;
  reviewUrl: string | null;
  status: string;
  /** Integration ID of the VCS connector used for this repo */
  integrationId: string;
  /** Review system type: "gerrit" or "gitlab" */
  reviewSystem: string;
  /** Position in the commit chain (0 = legacy single-commit, 1..N for multi-commit) */
  commitIndex: number;
  /** SHA-1 hash of the normalized commit subject — for deterministic Change-Id mapping */
  subjectHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StateTransition {
  id: number;
  taskId: TaskId;
  fromState: TaskState;
  toState: TaskState;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface AgentCycle {
  id: number;
  taskId: TaskId;
  cycleNumber: number;
  result: AgentResult;
  validationResult: ValidationResult | null;
  createdAt: Date;
  /** GitHub-computed cost of this cycle, derived from Copilot `assistant.usage` events. */
  cost?: CycleCost;
}

/** Aggregated token usage across a single agent cycle. */
export interface CycleCostTokens {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
}

/**
 * Per-cycle execution cost derived from the Copilot SDK `assistant.usage`
 * events. The SDK reports cost per LLM request via `copilotUsage.totalNanoAiu`
 * (nano-AI-Units) and the `cost` model multiplier; `computeCycleCost`
 * deduplicates repeated emissions of a request and sums distinct requests.
 * 1 AI Unit = 1 AI credit = $0.01.
 */
export interface CycleCost {
  /** True when GitHub-computed cost (nano-AIU) was present in the usage events. */
  priced: boolean;
  /** Total cost in GitHub AI credits (1 credit = $0.01 USD). */
  aiCredits: number;
  /** Total cost in USD. */
  usd: number;
  /** Summed premium-request cost (model multiplier) across distinct requests; 0 when unavailable. */
  premiumRequests: number;
  /** Aggregated token usage across the cycle. */
  tokens: CycleCostTokens;
  /** Model id resolved from the usage events, or null. */
  modelId: string | null;
}

/** Per-project (or unassigned) slice of an aggregated cost summary. */
export interface CostSummaryProject {
  /** Project id, or null for cycles whose task has no project (orphaned/legacy). */
  projectId: string | null;
  /** Project name, or null when the project no longer exists or is unassigned. */
  projectName: string | null;
  /** Total USD across the project's agent cycles in the period. */
  usd: number;
  /** Total GitHub AI credits across the project's agent cycles in the period. */
  aiCredits: number;
  /** Total premium-request multiplier across the period. */
  premiumRequests: number;
  /** Number of agent cycles (runs) counted for the project in the period. */
  runCount: number;
}

/**
 * Aggregated execution cost across all agent cycles, broken down per project and
 * totalled instance-wide. Cycles without a recorded cost snapshot are recomputed
 * from their captured event log so historical runs are still accounted for.
 */
export interface CostSummary {
  /** Instance-wide total USD over the period. */
  totalUsd: number;
  /** Instance-wide total GitHub AI credits over the period. */
  totalAiCredits: number;
  /** Instance-wide total premium-request multiplier over the period. */
  totalPremiumRequests: number;
  /** Instance-wide total number of agent cycles (runs) over the period. */
  totalRuns: number;
  /** Per-project breakdown, sorted by descending USD. */
  perProject: CostSummaryProject[];
  /** Inclusive lower bound of the period in epoch seconds, or null for all-time. */
  sinceEpochSeconds: number | null;
}

/** Run-count and cost for a single model. */
export interface ModelUsageEntry {
  /** Model id, or null when the model could not be resolved from the cycle. */
  modelId: string | null;
  /** Number of agent cycles (runs) executed with this model in the period. */
  runCount: number;
  /** Total USD attributed to this model in the period. */
  usd: number;
}

/** Per-project model distribution slice. */
export interface ModelUsageProject {
  /** Project id, or null for cycles whose task has no project. */
  projectId: string | null;
  /** Project name, or null when unassigned / deleted. */
  projectName: string | null;
  /** Models used by the project, sorted by descending run count. */
  models: ModelUsageEntry[];
}

/**
 * Distribution of AI models across agent cycles, both globally and per project,
 * by run count and by cost. Cycles whose model was not recorded in a snapshot
 * are recomputed from their captured event log so historical runs are included.
 */
export interface ModelUsageSummary {
  /** Global model distribution, sorted by descending run count. */
  byModel: ModelUsageEntry[];
  /** Per-project model distribution. */
  perProject: ModelUsageProject[];
  /** Instance-wide total number of agent cycles (runs) over the period. */
  totalRuns: number;
  /** Instance-wide total USD over the period. */
  totalUsd: number;
  /** Inclusive lower bound of the period in epoch seconds, or null for all-time. */
  sinceEpochSeconds: number | null;
}

export interface Prompt {
  id: string;
  label: string;
  content: string;
  /** "system" = immutable format/integration-specific prompt; "user" = editable by admins. */
  promptType: "system" | "user";
  updatedAt: Date;
}

export interface PromptStore {
  getPrompts(): Promise<Prompt[]>;
  getPrompt(id: string): Promise<Prompt | null>;
  upsertPrompt(id: string, content: string): Promise<Prompt>;
  /** Create a prompt; id is derived from label. Rejects on duplicate (409) or bad label (400). */
  createPrompt(label: string, content: string): Promise<Prompt>;
  /** Delete a prompt. Rejects if not found (404) or if promptType === "system" (403). */
  deletePrompt(id: string): Promise<void>;
}

export interface StateStore {
  // Task management
  createTask(
    taskId: TaskId,
    ticketId: TicketId,
    ticketTitle?: string,
    ticketDescription?: string,
    ticketSourceLabel?: string,
    ticketUrl?: string,
    displayId?: string,
    ticketSource?: { integrationId: string; ticketProjectKey: string },
    projectId?: ProjectId
  ): Promise<Task>;

  /** Create a code-review task (taskType="code-review", initial state=REVIEW_PENDING). */
  createReviewTask(input: {
    taskId: TaskId;
    ticketId: TicketId;
    subject: string;
    description?: string;
    sourceLabel?: string;
    changeId: ExternalChangeId;
    patchset: number;
    reviewUrl?: string;
    displayId?: string;
    projectId?: ProjectId;
  }): Promise<Task>;

  /** Record the patchset just reviewed by VE (used by re-review polling). */
  setReviewedPatchset(taskId: TaskId, patchset: number): Promise<void>;
  getTask(taskId: TaskId): Promise<Task | null>;
  getTaskByTicketId(ticketId: TicketId, projectId?: ProjectId): Promise<Task | null>;

  /** Return the single active (non-terminal) task for a ticket, optionally scoped to a project. */
  getActiveTaskByTicketId(ticketId: TicketId, projectId?: ProjectId): Promise<Task | null>;
  getActiveTasks(): Promise<Task[]>;
  getAllTasks(): Promise<Task[]>;

  /** Count FAILED/ABANDONED tasks for a ticket; scoped by sourceLabel and/or project when provided. */
  getFailedAttemptCount(ticketId: TicketId, ticketSourceLabel?: string, projectId?: ProjectId): Promise<number>;

  /** Atomically transition to a new state. Idempotent if already in toState. */
  transition(
    taskId: TaskId,
    toState: TaskState,
    metadata?: Record<string, unknown>
  ): Promise<Task>;

  updateExternalChangeId(
    taskId: TaskId,
    changeId: ExternalChangeId,
    patchset: number,
    reviewUrl?: string
  ): Promise<void>;

  incrementCycle(taskId: TaskId): Promise<number>;

  setFailureReason(taskId: TaskId, reason: string): Promise<void>;

  /** Pause a task (writes a state_transitions row with action="pause"). */
  pauseTask(taskId: TaskId): Promise<Task>;

  /** Resume a paused task. */
  resumeTask(taskId: TaskId): Promise<Task>;

  /** Returns true if the latest state_transition has metadata.action === "pause". */
  isTaskPaused(taskId: TaskId): Promise<boolean>;

  /** Reset cycle count and transition a failed/abandoned task back to DETECTED. */
  retryTask(taskId: TaskId): Promise<Task>;

  /** Manually transition a task to ABANDONED. */
  abandonTask(taskId: TaskId): Promise<Task>;

  /** Permanently delete a task and its records. Only terminal-state tasks may be deleted. */
  deleteTask(taskId: TaskId): Promise<void>;

  /** Force-delete a task and all siblings sharing the same ticketId or gerritChangeId. */
  deleteTaskGroup(taskId: TaskId): Promise<void>;

  // Cycle audit trail
  saveAgentCycle(
    taskId: TaskId,
    cycleNumber: number,
    result: AgentResult,
    validationResult?: ValidationResult
  ): Promise<void>;

  /** Update per-repo commit messages on a saved cycle (after multi-repo push). */


  getAgentCycles(taskId: TaskId): Promise<AgentCycle[]>;
  getAgentCycleEvents(taskId: TaskId, cycleNumber: number): Promise<AgentLogEvent[]>;

  /** Aggregate agent-cycle execution cost per project and instance-wide. */
  getCostSummary(options?: { since?: Date }): Promise<CostSummary>;

  /** Aggregate AI-model usage distribution by run count and cost. */
  getModelUsageSummary(options?: { since?: Date }): Promise<ModelUsageSummary>;

  getStateTransitions(taskId: TaskId): Promise<StateTransition[]>;

  // Comment deduplication
  getProcessedCommentIds(taskId: TaskId): Promise<Set<string>>;
  markCommentProcessed(taskId: TaskId, gerritCommentId: string): Promise<void>;

  // Posted-review-comment deduplication (VE-as-reviewer side; integration-agnostic)
  /** Hashes of every inline comment VE has already posted on this review task. */
  getPostedReviewCommentHashes(taskId: TaskId): Promise<Set<string>>;
  /** Full records of comments VE has already posted (for prompt memory + resolution). */
  getPostedReviewComments(taskId: TaskId): Promise<PostedReviewComment[]>;
  /** Record freshly-posted comments. Duplicate hashes for the task are ignored. */
  markReviewCommentsPosted(
    taskId: TaskId,
    changeId: ExternalChangeId,
    comments: PostedReviewCommentInput[]
  ): Promise<void>;
  /** Mark a previously-posted comment thread as resolved. */
  markReviewCommentResolved(id: number): Promise<void>;

  // Thread-reply deduplication (VE-as-reviewer side; integration-agnostic)
  /** Handled-message hashes for every reply VE has already posted on this task. */
  getHandledThreadReplyHashes(taskId: TaskId): Promise<Set<string>>;
  /** Record freshly-posted thread replies. Duplicate hashes for the task are ignored. */
  markThreadReplyPosted(
    taskId: TaskId,
    changeId: ExternalChangeId,
    replies: ThreadReplyRecordInput[]
  ): Promise<void>;

  // Per-repository change tracking (multi-repo tasks)
  /** Upsert a per-repo change record (Gerrit Change-Id or GitLab MR IID). */
  saveChangePerRepository(
    taskId: TaskId,
    repoKey: string,
    changeId: string,
    reviewUrl: string | null,
    status: string,
    integrationId?: string,
    reviewSystem?: string,
    commitIndex?: number,
    subjectHash?: string | null
  ): Promise<void>;

  /** Get all per-repo change records for a task. */
  getChangesForTask(taskId: TaskId): Promise<ChangePerRepository[]>;

  /** Get all per-repo change records for a batch of tasks in one query. */
  getChangesForTasks(taskIds: TaskId[]): Promise<ChangePerRepository[]>;

  /** Resolve a task by gerritChangeId or change_per_repository.changeId. */
  findTaskByExternalChangeId(
    integrationId: string | null,
    externalChangeId: string
  ): Promise<Task | null>;

  /**
   * Find the most recent code-review task for a given change+project that has
   * already completed a review pass (reviewed_patchset IS NOT NULL). Used to
   * prevent duplicate reviews when an integration is deleted and recreated with
   * a new ID — the ticketId changes but the underlying change is the same.
   */
  findReviewedCodeReviewTask(changeId: string, projectId: ProjectId): Promise<Task | null>;

  /** Update status of a per-repo change record; changeId disambiguates multi-commit rows. */
  updateChangePerRepositoryStatus(
    taskId: TaskId,
    repoKey: string,
    status: string,
    changeId?: string
  ): Promise<void>;

  /**
   * Mark change_per_repository rows as ORPHANED when a retry push produces
   * fewer commits than the previous cycle (commitIndex > maxCommitIndex).
   * Returns the number of rows updated.
   */
  orphanExcessChanges(
    taskId: TaskId,
    repoKey: string,
    maxCommitIndex: number
  ): Promise<number>;

  /** Phase 4: link a task to a project (for project-mode iteration). */
  setTaskProjectId(taskId: TaskId, projectId: ProjectId): Promise<void>;

  /**
   * Re-attach orphaned tasks (project_id IS NULL) whose snapshotted ticket source
   * matches (integrationId, ticketProjectKey) to `projectId`. Returns the number
   * of tasks adopted.
   */
  adoptOrphanedTasksForProject(
    projectId: ProjectId,
    integrationId: string,
    ticketProjectKey: string
  ): number;

  /** Persist the feature branch ref chosen for a task's first push. Read on resume to keep the same branch across retries. */
  setTaskPushRef(taskId: TaskId, pushRef: string): Promise<void>;

  /** Look up a project by its ID. */
  getProjectById(id: ProjectId): Promise<ProjectRecord | null>;

  /** Look up ALL VE projects whose repo inclusion list contains this repoKey for the given integration. */
  findProjectsByReviewTarget(integrationId: string, repoKey: string): Promise<ProjectRecord[]>;

  /** List all push targets for a project, sorted by commitOrder. */
  listProjectPushTargets(projectId: ProjectId): Promise<ProjectPushTargetRecord[]>;

  /** List agent records, optionally filtered by type and/or enabled status. */
  listAgents(filter?: { type?: AgentType; enabled?: boolean }): Promise<AgentRecord[]>;
}

// ─── Resource discovery types ──────────────────────────────────────

/** A ticket project discovered on a ticketing integration. */
export interface DiscoveredTicketProject {
  /** Canonical ID used by the integration (e.g. Redmine project identifier, GitLab path_with_namespace). */
  key: string;
  /** Human-readable label. */
  name: string;
  url?: string;
}

/** A repository discovered on a code-hosting integration. */
export interface DiscoveredRepository {
  /** Canonical ID (Gerrit project name, GitLab path_with_namespace). */
  key: string;
  name: string;
  cloneUrlSsh?: string;
  cloneUrlHttp?: string;
  defaultBranch?: string;
  /** Optional; populated when cheaply available. */
  branches?: string[];
  webUrl?: string;
}

/** Snapshot of resources discovered for a single integration. */
export interface DiscoveredResources {
  ticketProjects?: DiscoveredTicketProject[];
  repositories?: DiscoveredRepository[];
  /** AI model list (used by agent integrations such as Copilot). */
  models?: Array<{ id: string; name: string }> | undefined;
  /** ISO timestamp when the snapshot was produced. */
  discoveredAt: string;
}

// ─── Plugin / Integration types ───────────────────────────────────────────────

/** Identifiers for the external systems Virtual Engineer can connect to. */
export const PROVIDER_IDS = ["github", "gitlab", "gerrit", "redmine", "copilot", "mock"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * Domain capabilities an integration can expose. A project binds an integration
 * for a specific capability via `project_integration_bindings`.
 */
export const DOMAIN_CAPABILITIES = ["issue_tracking", "code_review", "source_control", "agent_execution"] as const;
export type DomainCapability = (typeof DOMAIN_CAPABILITIES)[number];

export interface Integration {
  id: string;
  provider: ProviderId;
  name: string;
  configJson: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** JSON snapshot of resources discovered on this integration. NULL = never discovered. */
  discoveredResourcesJson?: string | null | undefined;
  /** When the discovery snapshot was last refreshed. NULL = never. */
  discoveredAt?: Date | null | undefined;
}

export interface OAuthApp {
  provider: string;
  baseUrl: string;
  clientId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface OAuthAppStore {
  listOAuthApps(provider?: string): Promise<OAuthApp[]>;
  getOAuthApp(provider: string, baseUrl: string): Promise<OAuthApp | null>;
  upsertOAuthApp(app: Omit<OAuthApp, "createdAt" | "updatedAt">): Promise<OAuthApp>;
  deleteOAuthApp(provider: string, baseUrl: string): Promise<void>;
}

export interface IntegrationStore {
  getIntegrations(): Promise<Integration[]>;
  getIntegration(id: string): Promise<Integration | null>;
  upsertIntegration(integration: Omit<Integration, "createdAt" | "updatedAt">): Promise<Integration>;
  deleteIntegration(id: string): Promise<void>;
  setIntegrationEnabled(id: string, enabled: boolean): Promise<Integration>;
  /** Count FK references across agents/projects tables; used to guard deletes with 409. */
  countIntegrationReferences(id: string): Promise<number>;
  /** persist a fresh resource-discovery snapshot for an integration. */
  setIntegrationDiscoveredResources?(id: string, json: string): Promise<void>;
  /** load the latest persisted snapshot (raw JSON + when). */
  getIntegrationDiscoveredResources?(id: string): Promise<{ json: string | null; at: Date | null }>;
  /** drop the persisted snapshot so a stale config no longer surfaces old resources. */
  clearIntegrationDiscoveredResources?(id: string): Promise<void>;
}
