/** SQLite-backed state store using better-sqlite3 and Drizzle ORM. WAL mode and foreign keys enabled at startup. */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdir } from "fs/promises";
import { dirname } from "path";
import type {
  AgentRecord,
  ProjectRecord,
  ResolvedAgentConfig,
  StateStore,
  Task,
} from "../interfaces.js";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AgentStoreApi } from "./stores/agentStore.js";
import { createAgentStore } from "./stores/agentStore.js";
import type { IntegrationStoreApi } from "./stores/integrationStore.js";
import { createIntegrationStore } from "./stores/integrationStore.js";
import type { ProjectStoreApi } from "./stores/projectStore.js";
import { createProjectStore } from "./stores/projectStore.js";
import type { PromptStoreApi } from "./stores/promptStore.js";
import { createPromptStore } from "./stores/promptStore.js";
import type { TaskStoreApi } from "./stores/taskStore.js";
import { createTaskStore } from "./stores/taskStore.js";
import * as schema from "./schema.js";

type ComposedStoreApi =
  & TaskStoreApi
  & IntegrationStoreApi
  & ProjectStoreApi
  & PromptStoreApi
  & AgentStoreApi;

/** Facade class that composes domain-scoped store modules over one shared SQLite connection. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class SqliteStateStore {
  private readonly db: BetterSQLite3Database<typeof schema>;
  private readonly dbDir: string;
  private readonly taskStore: TaskStoreApi;
  private readonly integrationStore: IntegrationStoreApi;
  private readonly projectStore: ProjectStoreApi;
  private readonly promptStore: PromptStoreApi;
  private readonly agentStore: AgentStoreApi;

  constructor(private readonly raw: Database.Database) {
    this.dbDir = dirname(this.raw.name);
    this.db = drizzle(this.raw, { schema });
    this.applyMigrations();

    this.taskStore = createTaskStore({ db: this.db, raw: this.raw });
    this.integrationStore = createIntegrationStore({ db: this.db });
    this.projectStore = createProjectStore({ db: this.db, raw: this.raw });
    this.promptStore = createPromptStore({ db: this.db, dbDir: this.dbDir });
    this.agentStore = createAgentStore({ db: this.db });

    Object.assign(
      this,
      this.taskStore,
      this.integrationStore,
      this.projectStore,
      this.promptStore,
      this.agentStore
    );
  }

  /** Create and initialise a store at `dbPath`. Creates the parent directory, runs migrations, and seeds built-in prompts. */
  static async create(dbPath: string): Promise<SqliteStateStore> {
    const dir = dirname(dbPath);
    await mkdir(dir, { recursive: true });
    const raw = new Database(dbPath);
    raw.pragma("journal_mode = WAL");
    raw.pragma("foreign_keys = ON");
    const store = new SqliteStateStore(raw);
    await store.seedBuiltInPrompts();
    return store;
  }

  /** Apply the baseline DDL and all incremental ALTER TABLE migrations in one synchronous pass. */
  private applyMigrations(): void {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id         TEXT    PRIMARY KEY,
        ticket_id       TEXT    NOT NULL,
        ticket_source_label TEXT NOT NULL DEFAULT 'redmine',
        ticket_title    TEXT    NOT NULL DEFAULT '',
        ticket_description TEXT NOT NULL DEFAULT '',
        state           TEXT    NOT NULL DEFAULT 'DETECTED',
        gerrit_change_id TEXT,
        current_patchset INTEGER NOT NULL DEFAULT 0,
        cycle_count     INTEGER NOT NULL DEFAULT 0,
        failure_reason  TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS state_transitions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id     TEXT    NOT NULL REFERENCES tasks(task_id),
        from_state  TEXT    NOT NULL,
        to_state    TEXT    NOT NULL,
        metadata    TEXT    NOT NULL DEFAULT '{}',
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_cycles (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id           TEXT    NOT NULL REFERENCES tasks(task_id),
        cycle_number      INTEGER NOT NULL,
        agent_result      TEXT    NOT NULL,
        validation_result TEXT,
        created_at        INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_comments (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id             TEXT    NOT NULL REFERENCES tasks(task_id),
        gerrit_comment_id   TEXT    NOT NULL,
        created_at          INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS posted_review_comments (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id             TEXT    NOT NULL REFERENCES tasks(task_id),
        change_id           TEXT    NOT NULL,
        comment_hash        TEXT    NOT NULL,
        file                TEXT    NOT NULL,
        line                INTEGER NOT NULL DEFAULT 0,
        message             TEXT    NOT NULL DEFAULT '',
        severity            TEXT    NOT NULL DEFAULT '',
        provider_thread_id  TEXT,
        resolved            INTEGER NOT NULL DEFAULT 0,
        created_at          INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_posted_review_comments_task_id ON posted_review_comments(task_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_posted_review_comments_task_hash
        ON posted_review_comments(task_id, comment_hash);

      CREATE TABLE IF NOT EXISTS review_thread_replies (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id               TEXT    NOT NULL REFERENCES tasks(task_id),
        change_id             TEXT    NOT NULL,
        thread_id             TEXT    NOT NULL,
        handled_comment_hash  TEXT    NOT NULL,
        reply_message         TEXT    NOT NULL DEFAULT '',
        created_at            INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_review_thread_replies_task_id ON review_thread_replies(task_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_review_thread_replies_task_thread_hash
        ON review_thread_replies(task_id, thread_id, handled_comment_hash);

      CREATE INDEX IF NOT EXISTS idx_tasks_ticket_id ON tasks(ticket_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_ticket_id ON tasks(ticket_id)
        WHERE state NOT IN ('DONE', 'FAILED', 'ABANDONED', 'REVIEW_DONE', 'REVIEW_FAILED');
      CREATE INDEX IF NOT EXISTS idx_state_transitions_task_id ON state_transitions(task_id);
      CREATE INDEX IF NOT EXISTS idx_agent_cycles_task_id ON agent_cycles(task_id);
      CREATE INDEX IF NOT EXISTS idx_processed_comments_task_id ON processed_comments(task_id);

      CREATE TABLE IF NOT EXISTS integrations (
        id          TEXT    PRIMARY KEY,
        type        TEXT    NOT NULL,
        name        TEXT    NOT NULL,
        config_json TEXT    NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS gitlab_oauth_apps (
        base_url   TEXT    PRIMARY KEY,
        client_id  TEXT    NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_apps (
        provider   TEXT    NOT NULL,
        base_url   TEXT    NOT NULL,
        client_id  TEXT    NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, base_url)
      );
      INSERT OR IGNORE INTO oauth_apps (provider, base_url, client_id, created_at, updated_at)
        SELECT 'gitlab', base_url, client_id, created_at, updated_at FROM gitlab_oauth_apps;

      CREATE TABLE IF NOT EXISTS prompts (
        id          TEXT    PRIMARY KEY,
        label       TEXT    NOT NULL,
        content     TEXT    NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS change_per_repository (
        id          TEXT    PRIMARY KEY,
        task_id     TEXT    NOT NULL REFERENCES tasks(task_id),
        repo_key    TEXT    NOT NULL,
        change_id   TEXT    NOT NULL,
        review_url  TEXT,
        status      TEXT    NOT NULL DEFAULT 'OPEN',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_change_per_repo_task_id ON change_per_repository(task_id);
      CREATE INDEX IF NOT EXISTS idx_change_per_repo_task_repo ON change_per_repository(task_id, repo_key);

      -- ─── Agents / Projects / Concurrency ────────────────────────────────────
      CREATE TABLE IF NOT EXISTS agents (
        id                     TEXT    PRIMARY KEY,
        name                   TEXT    NOT NULL,
        type                   TEXT    NOT NULL,
        model_config_json      TEXT    NOT NULL DEFAULT '{}',
        system_prompt_id       TEXT    REFERENCES prompts(id),
        instructions_prompt_id TEXT    REFERENCES prompts(id),
        max_concurrent         INTEGER NOT NULL DEFAULT 1,
        enabled                INTEGER NOT NULL DEFAULT 0,
        created_at             INTEGER NOT NULL,
        updated_at             INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
      CREATE INDEX IF NOT EXISTS idx_agents_enabled ON agents(enabled);

      CREATE TABLE IF NOT EXISTS projects (
        id                  TEXT    PRIMARY KEY,
        name                TEXT    NOT NULL,
        type                TEXT    NOT NULL,
        agent_id            TEXT    NOT NULL REFERENCES agents(id),
        agent_override_json TEXT,
        post_clone_script   TEXT    NOT NULL DEFAULT '',
        enabled             INTEGER NOT NULL DEFAULT 0,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
      CREATE INDEX IF NOT EXISTS idx_projects_enabled ON projects(enabled);

      CREATE TABLE IF NOT EXISTS project_ticket_source (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id         TEXT    NOT NULL REFERENCES projects(id),
        integration_id     TEXT    NOT NULL REFERENCES integrations(id),
        ticket_project_key TEXT    NOT NULL,
        created_at         INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_project_ticket_source_global
        ON project_ticket_source(integration_id, ticket_project_key);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_project_ticket_source_project
        ON project_ticket_source(project_id);
      CREATE INDEX IF NOT EXISTS idx_pts_project_id
        ON project_ticket_source(project_id);

      CREATE TABLE IF NOT EXISTS project_push_targets (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id     TEXT    NOT NULL REFERENCES projects(id),
        integration_id TEXT    NOT NULL REFERENCES integrations(id),
        repo_key       TEXT    NOT NULL,
        clone_url      TEXT    NOT NULL,
        target_branch  TEXT    NOT NULL,
        role           TEXT    NOT NULL,
        commit_order   INTEGER NOT NULL,
        local_path     TEXT    NOT NULL,
        ssh_key_path   TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_ppt_project_repo
        ON project_push_targets(project_id, repo_key);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_ppt_project_order
        ON project_push_targets(project_id, commit_order);
      CREATE INDEX IF NOT EXISTS idx_ppt_project_id
        ON project_push_targets(project_id);

      CREATE TABLE IF NOT EXISTS project_review_integration (
        project_id     TEXT    PRIMARY KEY REFERENCES projects(id),
        integration_id TEXT    NOT NULL REFERENCES integrations(id)
      );

      CREATE TABLE IF NOT EXISTS project_review_repos (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id     TEXT    NOT NULL REFERENCES projects(id),
        repo_key       TEXT    NOT NULL,
        UNIQUE(project_id, repo_key)
      );
      CREATE INDEX IF NOT EXISTS idx_prr_project_id
        ON project_review_repos(project_id);

      CREATE TABLE IF NOT EXISTS app_concurrency (
        id             TEXT    PRIMARY KEY CHECK (id = 'global'),
        max_concurrent INTEGER,
        updated_at     INTEGER NOT NULL
      );
    `);

    this.ensureColumn("tasks", "ticket_source_label", "TEXT NOT NULL DEFAULT 'redmine'");
    this.ensureColumn("tasks", "ticket_title", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("tasks", "ticket_description", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("tasks", "ticket_url", "TEXT");
    this.ensureColumn("tasks", "review_url", "TEXT");
    this.ensureColumn("tasks", "task_type", "TEXT NOT NULL DEFAULT 'code-gen'");
    this.ensureColumn("tasks", "reviewed_patchset", "INTEGER");
    this.ensureColumn("change_per_repository", "integration_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("change_per_repository", "review_system", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("change_per_repository", "commit_index", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("change_per_repository", "subject_hash", "TEXT");
    this.ensureColumn("agent_cycles", "agent_events", "TEXT");
    this.ensureColumn("agent_cycles", "cost_ai_credits", "REAL");
    this.ensureColumn("agent_cycles", "cost_usd", "REAL");
    this.ensureColumn("agent_cycles", "premium_requests", "REAL");
    this.ensureColumn("agent_cycles", "cost_input_tokens", "INTEGER");
    this.ensureColumn("agent_cycles", "cost_output_tokens", "INTEGER");
    this.ensureColumn("agent_cycles", "cost_cached_tokens", "INTEGER");
    this.ensureColumn("agent_cycles", "cost_cache_write_tokens", "INTEGER");
    this.ensureColumn("agent_cycles", "cost_model_id", "TEXT");
    this.ensureColumn("integrations", "discovered_resources_json", "TEXT");
    this.ensureColumn("integrations", "discovered_at", "INTEGER");
    this.ensureColumn("tasks", "project_id", "TEXT");
    this.ensureColumn("tasks", "display_id", "TEXT");
    this.ensureColumn("tasks", "ticket_source_integration_id", "TEXT");
    this.ensureColumn("tasks", "ticket_source_project_key", "TEXT");
    this.ensureColumn("tasks", "push_ref", "TEXT");
    this.ensureColumn("agents", "integration_id", "TEXT REFERENCES integrations(id) ON DELETE SET NULL");
    this.ensureColumn("agents", "feedback_instructions_prompt_id", "TEXT REFERENCES prompts(id) ON DELETE SET NULL");
    this.ensureColumn("prompts", "prompt_type", "TEXT NOT NULL DEFAULT 'user'");

    this.raw.exec(`
      UPDATE prompts SET prompt_type = 'system'
        WHERE id IN (
          'system_generic_code','instructions_generic_code',
          'system_gerrit_code','system_gitlab_code',
          'system_gerrit_review','system_gitlab_review','system_github_review',
          'instructions_gerrit_code','instructions_gitlab_code',
          'instructions_feedback_code',
          'user_gerrit_review','user_gitlab_review','user_github_review'
        );
    `);

    this.raw.exec(`
      DELETE FROM prompts WHERE id IN ('system', 'instructions');
    `);

    this.raw.exec(`
      DROP INDEX IF EXISTS idx_tasks_active_ticket_id;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_ticket_id ON tasks(ticket_id)
        WHERE state NOT IN ('DONE', 'FAILED', 'ABANDONED', 'REVIEW_DONE', 'REVIEW_FAILED');
    `);
  }

  /**
   * SQL Identifier Escaping:
   * - All table and column names are quoted with backticks to prevent SQL injection
   * - Backticks are doubled (`` ) when they appear in identifiers per SQLite escaping rules
   * - This prevents attackers from injecting SQL syntax through parameter names
   * - Example: tableName="tasks`--" becomes `tasks``--` which is treated as literal identifier
   *
   * @param tableName  Name of the table to alter (backtick-escaped internally).
   * @param columnName Name of the column to add (backtick-escaped internally).
   * @param definition Raw SQL column definition — MUST be a hardcoded literal.
   *                   Never pass user-controlled input here; this string is
   *                   inserted verbatim into an ALTER TABLE statement.
   */
  private ensureColumn(tableName: string, columnName: string, definition: string): void {
    const quotedTable = `\`${tableName.replaceAll("`", "``")}\``;
    const columns = this.raw.prepare(`PRAGMA table_info(${quotedTable})`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === columnName)) {
      return;
    }

    const quotedColumn = `\`${columnName.replaceAll("`", "``")}\``;
    this.raw.exec(`ALTER TABLE ${quotedTable} ADD COLUMN ${quotedColumn} ${definition}`);
  }

  /** Close the underlying SQLite database connection. */
  close(): void {
    this.raw.close();
  }

  /** Convenience helper: fetch the ProjectRecord bound to a task via its projectId. */
  async getProjectForTask(task: Task): Promise<ProjectRecord | null> {
    if (!task.projectId) return null;
    return this.projectStore.getProjectById(task.projectId);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface SqliteStateStore extends StateStore, ComposedStoreApi {}

/**
 * Partial-merge of a project's `agentOverrideJson` over an agent's
 * `modelConfigJson`. Override semantics:
 * - keys *present* in the override (and not `null`) replace the agent value;
 * - absent keys or `null` values fall back to the agent.
 *
 * Prompts: project override `systemPromptId` / `instructionsPromptId` win when
 * non-null; otherwise the agent's prompt is used.
 *
 * You cannot use the override to clear a field that the agent has set.
 */
export function resolveAgentConfig(agent: AgentRecord, project: ProjectRecord): ResolvedAgentConfig {
  const agentCfg = parseConfigJson(agent.modelConfigJson);
  const overrideCfg = project.agentOverrideJson ? parseConfigJson(project.agentOverrideJson) : {};

  const merged: Record<string, unknown> = { ...agentCfg };
  for (const [key, value] of Object.entries(overrideCfg)) {
    if (value === null || value === undefined) continue;
    merged[key] = value;
  }

  const overridePrompts = overrideCfg as { systemPromptId?: unknown; instructionsPromptId?: unknown; feedbackInstructionsPromptId?: unknown };
  const sysOverride = typeof overridePrompts.systemPromptId === "string" ? overridePrompts.systemPromptId : null;
  const insOverride = typeof overridePrompts.instructionsPromptId === "string" ? overridePrompts.instructionsPromptId : null;
  const fbOverride = typeof overridePrompts.feedbackInstructionsPromptId === "string" ? overridePrompts.feedbackInstructionsPromptId : null;

  const known = new Set(["model", "apiKey", "sessionToken", "systemPromptId", "instructionsPromptId", "feedbackInstructionsPromptId"]);
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (!known.has(key)) extra[key] = value;
  }

  return {
    model: typeof merged["model"] === "string" ? (merged["model"] as string) : undefined,
    apiKey: typeof merged["apiKey"] === "string" ? (merged["apiKey"] as string) : undefined,
    encryptedSessionToken: typeof merged["sessionToken"] === "string"
      ? (merged["sessionToken"] as string)
      : undefined,
    systemPromptId: sysOverride ?? agent.systemPromptId ?? "system_generic_code",
    instructionsPromptId: insOverride ?? agent.instructionsPromptId ?? "instructions_generic_code",
    feedbackInstructionsPromptId: fbOverride ?? agent.feedbackInstructionsPromptId ?? null,
    extra,
  };
}

/** Safely parse a JSON string into a plain object; returns `{}` on invalid input. */
function parseConfigJson(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
