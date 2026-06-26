/** Drizzle ORM table definitions for the Virtual Engineer SQLite database. All timestamps are seconds since epoch (`mode: "timestamp"`). */
import { sqliteTable, text, integer, index, unique, check, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { TaskState, IntegrationType, TaskType, AgentType, ProjectType, PushTargetRole } from "../interfaces.js";

export const tasks = sqliteTable("tasks", {
  taskId: text("task_id").primaryKey(),
  ticketId: text("ticket_id").notNull(),
  ticketSourceLabel: text("ticket_source_label").notNull().default("redmine"),
  ticketTitle: text("ticket_title").notNull().default(""),
  ticketDescription: text("ticket_description").notNull().default(""),
  state: text("state").$type<TaskState>().notNull().default("DETECTED"),
  /**
   * Discriminator for the task lifecycle.
   * - "code-gen": legacy ticket-driven code generation flow
   * - "code-review": VE acts as a reviewer on a change in an external review system
   */
  taskType: text("task_type").$type<TaskType>().notNull().default("code-gen"),
  gerritChangeId: text("gerrit_change_id"),
  currentPatchset: integer("current_patchset").notNull().default(0),
  /**
   * For code-review tasks: the patchset number that was last reviewed by VE.
   * Used to detect newly-uploaded patchsets and trigger re-reviews.
   */
  reviewedPatchset: integer("reviewed_patchset"),
  cycleCount: integer("cycle_count").notNull().default(0),
  failureReason: text("failure_reason"),
  ticketUrl: text("ticket_url"),
  reviewUrl: text("review_url"),
  /** Project ID — binds the task to a Project record. */
  projectId: text("project_id"),
  /**
   * Integration ID of the ticket source that produced this task (snapshot
   * taken at creation time, or backfilled before owning project deletion).
   * Used to re-attach orphaned tasks when a new project takes over the same
   * (integrationId, ticketProjectKey) ticket source.
   */
  ticketSourceIntegrationId: text("ticket_source_integration_id"),
  /** Ticket project key (provider-side identifier) of the originating ticket source. */
  ticketSourceProjectKey: text("ticket_source_project_key"),
  /** Human-readable identifier for the UI (e.g. ticket number, Gerrit change number). */
  displayId: text("display_id"),
  /** Persisted feature branch ref used for the first push; reused on subsequent pushes for idempotence and backward-compat with branches created under the legacy naming scheme. */
  pushRef: text("push_ref"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const stateTransitions = sqliteTable("state_transitions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.taskId),
  fromState: text("from_state").$type<TaskState>().notNull(),
  toState: text("to_state").$type<TaskState>().notNull(),
  // JSON-serialised metadata
  metadata: text("metadata").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const agentCycles = sqliteTable("agent_cycles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.taskId),
  cycleNumber: integer("cycle_number").notNull(),
  // JSON-serialised AgentResult
  agentResult: text("agent_result").notNull(),
  // JSON-serialised ValidationResult | null
  validationResult: text("validation_result"),
  // JSON-serialised AgentLogEvent[]
  agentEvents: text("agent_events"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const processedComments = sqliteTable("processed_comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.taskId),
  gerritCommentId: text("gerrit_comment_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

/**
 * Records every inline review comment VE has already posted on a change, keyed
 * by a stable content hash. Used to deduplicate comments across re-reviews
 * (new patchsets) so the same issue is never posted twice. Integration-agnostic:
 * populated by the ReviewOrchestrator regardless of the review backend.
 */
export const postedReviewComments = sqliteTable(
  "posted_review_comments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.taskId),
    /** External change identifier (Gerrit change id, GitHub `owner/repo#n`, GitLab `project#iid`). */
    changeId: text("change_id").notNull(),
    /** Stable hash of file + normalized message (see review/commentHash.ts). */
    commentHash: text("comment_hash").notNull(),
    file: text("file").notNull(),
    line: integer("line").notNull().default(0),
    /** Original comment body — kept so prior comments can be injected into re-review prompts. */
    message: text("message").notNull().default(""),
    severity: text("severity").notNull().default(""),
    /** Provider-side thread/comment id, captured for later resolution. NULL when unknown. */
    providerThreadId: text("provider_thread_id"),
    /** 1 once VE has resolved this thread (issue addressed in a later patchset). */
    resolved: integer("resolved").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    idxPostedReviewCommentsTaskId: index("idx_posted_review_comments_task_id").on(table.taskId),
    uqPostedReviewCommentsTaskHash: unique("uq_posted_review_comments_task_hash").on(
      table.taskId,
      table.commentHash
    ),
  })
);

export const integrations = sqliteTable("integrations", {
  id: text("id").primaryKey(),
  type: text("type").$type<IntegrationType>().notNull(),
  name: text("name").notNull(),
  configJson: text("config_json").notNull(),
  enabled: integer("enabled").notNull().default(1),
  /** JSON snapshot of resources discovered on this integration. NULL = never discovered. */
  discoveredResourcesJson: text("discovered_resources_json"),
  /** When the discovery snapshot was last refreshed. NULL = never. */
  discoveredAt: integer("discovered_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const gitLabOAuthApps = sqliteTable("gitlab_oauth_apps", {
  baseUrl: text("base_url").primaryKey(),
  clientId: text("client_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const oauthApps = sqliteTable("oauth_apps", {
  provider: text("provider").notNull(),
  baseUrl: text("base_url").notNull(),
  clientId: text("client_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.provider, table.baseUrl] }),
}));

export const prompts = sqliteTable("prompts", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  content: text("content").notNull(),
  /**
   * "system" = format/integration-specific contract prompt, immutable via UI.
   * "user"   = task-customisation prompt, editable by admins.
   */
  promptType: text("prompt_type").$type<"system" | "user">().notNull().default("user"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/**
 * Per-repository change tracking. Tracks Gerrit Change-Ids or GitLab MR IDs per
 * repository for multi-repo tasks with independent review/merge tracking.
 */
export const changePerRepository = sqliteTable(
  "change_per_repository",
  {
    id: text("id").primaryKey(),
    /** Foreign key to tasks */
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.taskId),
    /** Repository key (links to repositories.repoKey) */
    repoKey: text("repo_key").notNull(),
    /** Gerrit Change-Id or GitLab merge request identifier */
    changeId: text("change_id").notNull(),
    /** Review URL pointing to Gerrit change or GitLab MR */
    reviewUrl: text("review_url"),
    /** Change status: "OPEN", "MERGED", "ABANDONED" (for Gerrit) or "opened", "merged", "closed" (for GitLab) */
    status: text("status").notNull().default("OPEN"),
    /** Integration ID of the VCS connector used for this repo */
    integrationId: text("integration_id").notNull().default(""),
    /** Review system type: "gerrit" or "gitlab" */
    reviewSystem: text("review_system").notNull().default(""),
    /** Position in the commit chain (0 = legacy single-commit, 1..N for multi-commit) */
    commitIndex: integer("commit_index").notNull().default(0),
    /** SHA-1 hash of the normalized commit subject — used for deterministic Change-Id mapping on retries */
    subjectHash: text("subject_hash"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    idxChangePerRepoTaskId: index("idx_change_per_repo_task_id").on(table.taskId),
    idxChangePerRepoTaskRepo: index("idx_change_per_repo_task_repo").on(table.taskId, table.repoKey),
  })
);

// ─── Agents / Projects / Concurrency ─────────────────────────────────────────

/**
 * Reusable agent definitions (library). One agent can back many projects.
 * `modelConfigJson` carries the model + credentials; prompts are referenced by FK.
 */
export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").$type<AgentType>().notNull(),
    modelConfigJson: text("model_config_json").notNull().default("{}"),
    integrationId: text("integration_id").references(() => integrations.id),
    systemPromptId: text("system_prompt_id").references(() => prompts.id),
    instructionsPromptId: text("instructions_prompt_id").references(() => prompts.id),
    /** Optional instructions prompt used on retry (feedback) cycles. Falls back to instructionsPromptId when null. */
    feedbackInstructionsPromptId: text("feedback_instructions_prompt_id").references(() => prompts.id),
    maxConcurrent: integer("max_concurrent").notNull().default(1),
    enabled: integer("enabled").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    idxAgentsName: index("idx_agents_name").on(table.name),
    idxAgentsEnabled: index("idx_agents_enabled").on(table.enabled),
  })
);

/**
 * Projects bind a ticket source and push targets to an Agent.
 * Type: `"coding"` (ticket-driven) or `"review"` (VE acts as reviewer).
 */
export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").$type<ProjectType>().notNull(),
    agentId: text("agent_id").notNull().references(() => agents.id),
    /** Partial-merge override over the agent's modelConfigJson + prompts. NULL = no override. */
    agentOverrideJson: text("agent_override_json"),
    /** Bash script run on the host after cloning. Empty string means "no script". */
    postCloneScript: text("post_clone_script").notNull().default(""),
    enabled: integer("enabled").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    idxProjectsName: index("idx_projects_name").on(table.name),
    idxProjectsEnabled: index("idx_projects_enabled").on(table.enabled),
  })
);

/**
 * Coding-project ticket source. A coding project has exactly one ticket source.
 * Globally unique on `(integration_id, ticket_project_key)` so two projects
 * cannot fight over the same ticket source.
 */
export const projectTicketSource = sqliteTable(
  "project_ticket_source",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id").notNull().references(() => projects.id),
    integrationId: text("integration_id").notNull().references(() => integrations.id),
    ticketProjectKey: text("ticket_project_key").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    uqProjectTicketSourceGlobal: unique("uq_project_ticket_source_global").on(
      table.integrationId,
      table.ticketProjectKey
    ),
    uqProjectTicketSourceProject: unique("uq_project_ticket_source_project").on(table.projectId),
    idxPtsProjectId: index("idx_pts_project_id").on(table.projectId),
  })
);

/**
 * Coding-project push targets (1..N repos). Pushes are emitted in `commitOrder`.
 * `(project_id, repo_key)` and `(project_id, commit_order)` are both unique.
 */
export const projectPushTargets = sqliteTable(
  "project_push_targets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id").notNull().references(() => projects.id),
    integrationId: text("integration_id").notNull().references(() => integrations.id),
    repoKey: text("repo_key").notNull(),
    cloneUrl: text("clone_url").notNull(),
    targetBranch: text("target_branch").notNull(),
    role: text("role").$type<PushTargetRole>().notNull(),
    commitOrder: integer("commit_order").notNull(),
    localPath: text("local_path").notNull(),
    sshKeyPath: text("ssh_key_path"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    uqPptProjectRepo: unique("uq_ppt_project_repo").on(table.projectId, table.repoKey),
    uqPptProjectOrder: unique("uq_ppt_project_order").on(table.projectId, table.commitOrder),
    idxPptProjectId: index("idx_ppt_project_id").on(table.projectId),
  })
);

/**
 * Review-project integration binding. One row per review project — links the
 * project to its VCS integration (Gerrit, GitLab MR, …).
 */
export const projectReviewIntegration = sqliteTable("project_review_integration", {
  projectId: text("project_id").primaryKey().references(() => projects.id),
  integrationId: text("integration_id").notNull().references(() => integrations.id),
});

/**
 * Inclusion list of repositories covered by a review project. Many rows per
 * project (one per repo). A repo can appear in multiple projects simultaneously.
 */
export const projectReviewRepos = sqliteTable(
  "project_review_repos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id").notNull().references(() => projects.id),
    repoKey: text("repo_key").notNull(),
  },
  (table) => ({
    uqProjectRepo: unique("uq_project_review_repo").on(table.projectId, table.repoKey),
    idxPrrProjectId: index("idx_prr_project_id").on(table.projectId),
  })
);

/**
 * Singleton table holding the global concurrency limit. `id` is constrained to
 * the literal `'global'`. `max_concurrent` NULL = unlimited.
 */
export const appConcurrency = sqliteTable(
  "app_concurrency",
  {
    id: text("id").primaryKey(),
    maxConcurrent: integer("max_concurrent"),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    chkSingleton: check("chk_app_concurrency_singleton", sql`${table.id} = 'global'`),
  })
);
