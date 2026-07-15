/** Drizzle ORM table definitions for the Virtual Engineer SQLite database. All timestamps are seconds since epoch (`mode: "timestamp"`). */
import { sqliteTable, text, integer, real, index, unique, check, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { TaskState, ProviderId, TaskType, AgentType, ProjectType, PushTargetRole, DomainCapability, UserRole, PrincipalType } from "../interfaces.js";

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
  /** GitHub-computed cost in AI credits (1 credit = $0.01); null when unpriced. */
  costAiCredits: real("cost_ai_credits"),
  /**
   * Cost in USD: GitHub-computed (authoritative) when nano-AIU is present,
   * otherwise estimated from the premium-request multiplier. Null only when no
   * cost signal is available.
   */
  costUsd: real("cost_usd"),
  /** Summed premium-request multiplier across the cycle's distinct requests; null when unavailable. */
  premiumRequests: real("premium_requests"),
  /** Summed input tokens across the cycle's distinct requests. */
  costInputTokens: integer("cost_input_tokens"),
  /** Summed output tokens across the cycle's distinct requests. */
  costOutputTokens: integer("cost_output_tokens"),
  /** Summed cache-read tokens across the cycle's distinct requests. */
  costCachedTokens: integer("cost_cached_tokens"),
  /** Summed cache-write tokens across the cycle's distinct requests. */
  costCacheWriteTokens: integer("cost_cache_write_tokens"),
  /** Model id resolved from the usage events. */
  costModelId: text("cost_model_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  idxAgentCyclesTaskId: index("idx_agent_cycles_task_id").on(table.taskId),
  idxAgentCyclesCreatedAt: index("idx_agent_cycles_created_at").on(table.createdAt),
}));

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

/**
 * Records every reply VE has posted to a human discussion thread on a change,
 * keyed by a stable hash of the thread id and the human message being answered
 * (see review/commentHash.ts `computeThreadReplyHash`). Used to deduplicate
 * replies across re-reviews so VE answers each human message at most once.
 * Integration-agnostic: populated by the ReviewOrchestrator regardless of the
 * review backend.
 */
export const reviewThreadReplies = sqliteTable(
  "review_thread_replies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.taskId),
    /** External change identifier (Gerrit change id, GitHub `owner/repo#n`, GitLab `project#iid`). */
    changeId: text("change_id").notNull(),
    /** Opaque provider thread token the reply was posted to. */
    threadId: text("thread_id").notNull(),
    /** Hash of thread id + the human message answered (see computeThreadReplyHash). */
    handledCommentHash: text("handled_comment_hash").notNull(),
    /** The reply body VE posted — kept for audit/debugging. */
    replyMessage: text("reply_message").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    idxReviewThreadRepliesTaskId: index("idx_review_thread_replies_task_id").on(table.taskId),
    uqReviewThreadRepliesTaskThreadHash: unique("uq_review_thread_replies_task_thread_hash").on(
      table.taskId,
      table.threadId,
      table.handledCommentHash
    ),
  })
);

export const integrations = sqliteTable("integrations", {
  id: text("id").primaryKey(),
  provider: text("provider").$type<ProviderId>().notNull(),
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
    /** When 1, the agent container loads team-defined skills from `<repo>/.github/skills` (coding and review projects). */
    skillDiscoveryEnabled: integer("skill_discovery_enabled").notNull().default(0),
    /** Optional literal Gerrit topic that overrides the ticket-derived topic (buildGerritTopic) for all pushes from this project. NULL = use the ticket-derived topic. */
    gerritTopicOverride: text("gerrit_topic_override"),
    /** When 1, agent commit messages use the full ticket URL in the footer instead of the short "#id" form. */
    useFullTicketUrlInCommits: integer("use_full_ticket_url_in_commits").notNull().default(0),
    /** When 1, VE posts a note on the source ticket with the review URL(s) once the first cycle opens a review. Default off — most teams already surface this via standard VCS/ticket integrations. */
    postReviewLinkToTicket: integer("post_review_link_to_ticket").notNull().default(0),
    /** When 1, CI build-failure notifications (e.g. Jenkins "Build Failed") count as actionable review feedback and trigger a retry cycle. Default off — some teams don't want VE auto-retrying on broken CI. Coding projects only. */
    reactToCiFailures: integer("react_to_ci_failures").notNull().default(0),
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
 * A project's binding of an integration to a domain capability. Replaces the
 * former `project_ticket_source` / `project_review_integration` /
 * `project_review_repos` tables. One row per `(project_id, capability)`.
 * `config_json` carries capability-specific config (e.g. `{ ticketProjectKey }`
 * for `issue_tracking`, `{ repos: [...] }` for `code_review`).
 */
export const projectIntegrationBindings = sqliteTable(
  "project_integration_bindings",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    integrationId: text("integration_id").notNull().references(() => integrations.id),
    capability: text("capability").$type<DomainCapability>().notNull(),
    configJson: text("config_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    uqPibProjectCapability: unique("uq_pib_project_capability").on(table.projectId, table.capability),
    idxPibProjectId: index("idx_pib_project_id").on(table.projectId),
    idxPibCapability: index("idx_pib_capability").on(table.capability),
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

// (review-project bindings now live in project_integration_bindings above)

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

/**
 * Singleton table holding editable workflow settings that override the env/config
 * defaults at runtime. `id` is constrained to the literal `'global'`. Each column is
 * nullable — NULL means "fall back to the `config.ts` default".
 */
export const appSettings = sqliteTable(
  "app_settings",
  {
    id: text("id").primaryKey(),
    pollingIntervalMs: integer("polling_interval_ms"),
    maxAgentCycles: integer("max_agent_cycles"),
    maxRetryAttempts: integer("max_retry_attempts"),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    chkSingleton: check("chk_app_settings_singleton", sql`${table.id} = 'global'`),
  })
);

// ─── Users / Sessions / Audit (admin accounts) ───────────────────────────────

/**
 * Admin dashboard user accounts. Route access is enforced by PBAC permissions,
 * not by `role`; `role` only selects the default policy bundle at user creation
 * and marks the `admin` superuser (which bypasses the permission gate).
 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").$type<UserRole>().notNull(),
  enabled: integer("enabled").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/**
 * DB-backed opaque admin sessions. `token_hash` is a hash of the raw bearer
 * token (the raw token is never stored). Sliding expiry via `touchSession`.
 */
export const userSessions = sqliteTable(
  "user_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tokenHash: text("token_hash").notNull().unique(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    idxUserSessionsUserId: index("idx_user_sessions_user_id").on(table.userId),
  })
);

/**
 * Append-only audit trail of admin mutations. `actor_user_id` is NULL for
 * non-user actors (e.g. bootstrap); `details_json` carries masked context.
 */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    actorUserId: text("actor_user_id"),
    actorName: text("actor_name").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    detailsJson: text("details_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    idxAuditLogCreatedAt: index("idx_audit_log_created_at").on(table.createdAt),
    // Support listAuditEntries filters without full-table scans as the log grows.
    idxAuditLogActionCreatedAt: index("idx_audit_log_action_created_at").on(table.action, table.createdAt),
    idxAuditLogActorCreatedAt: index("idx_audit_log_actor_created_at").on(table.actorName, table.createdAt),
  })
);

// ─── PBAC: groups / policies / rules / bindings ───────────────────────────────

/** A named collection of users. Policies bound to a group apply to every member. */
export const groups = sqliteTable("groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/** Membership join between users and groups. */
export const groupMembers = sqliteTable(
  "group_members",
  {
    groupId: text("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.groupId, table.userId] }),
    idxGroupMembersUserId: index("idx_group_members_user_id").on(table.userId),
  })
);

/** A named, reusable set of grant rules. `builtin` policies are seeded and protected. */
export const policies = sqliteTable("policies", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  builtin: integer("builtin").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/**
 * A single grant inside a policy (grant-only; no deny rules). `resource_id` NULL
 * grants the permission on all resources of the permission's type; a concrete id
 * scopes the grant to that resource.
 */
export const policyRules = sqliteTable(
  "policy_rules",
  {
    id: text("id").primaryKey(),
    policyId: text("policy_id").notNull().references(() => policies.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    resourceId: text("resource_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    idxPolicyRulesPolicyId: index("idx_policy_rules_policy_id").on(table.policyId),
    idxPolicyRulesPermission: index("idx_policy_rules_permission").on(table.permission),
  })
);

/** Attaches a policy to a principal (a user or a group). */
export const policyBindings = sqliteTable(
  "policy_bindings",
  {
    id: text("id").primaryKey(),
    policyId: text("policy_id").notNull().references(() => policies.id, { onDelete: "cascade" }),
    principalType: text("principal_type").$type<PrincipalType>().notNull(),
    principalId: text("principal_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    uqBinding: unique("uq_policy_bindings").on(table.policyId, table.principalType, table.principalId),
    idxPolicyBindingsPrincipal: index("idx_policy_bindings_principal").on(table.principalType, table.principalId),
  })
);
