/** SQLite-backed state store using better-sqlite3 and Drizzle ORM. WAL mode and foreign keys enabled at startup. */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, and, notInArray, inArray } from "drizzle-orm";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import type {
  OAuthApp,
  OAuthAppStore,
  StateStore,
  Task,
  TaskId,
  TicketId,
  ExternalChangeId,
  TaskState,
  AgentResult,
  AgentLogEvent,
  ValidationResult,
  AgentCycle,
  StateTransition,
  Integration,
  IntegrationStore,
  IntegrationType,
  Prompt,
  PromptStore,
  ChangePerRepository,
  AgentId,
  ProjectId,
  AgentType,
  ProjectType,
  AgentRecord,
  ProjectRecord,
  ProjectTicketSourceRecord,
  ProjectPushTargetRecord,
  ProjectReviewConfig,
  ResolvedAgentConfig,
  PushTargetRole,
} from "../interfaces.js";
import { makeExternalChangeId, TERMINAL_STATES } from "../interfaces.js";
import { validateTransition } from "./stateMachine.js";
import {
  tasks,
  agentCycles,
  processedComments,
  stateTransitions,
  integrations,
  prompts,
  changePerRepository,
  agents,
  projects,
  projectTicketSource,
  projectPushTargets,
  projectReviewIntegration,
  appConcurrency,
  oauthApps,
} from "./schema.js";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { normalizeGitLabBaseUrl } from "../utils/gitlabAuth.js";

/** SQLite-backed implementation of `StateStore`, `IntegrationStore`, and `PromptStore`. Use the static `create()` factory. */
export class SqliteStateStore implements StateStore, IntegrationStore, PromptStore, OAuthAppStore {
  private readonly db: BetterSQLite3Database<typeof schema>;
  private readonly dbDir: string;

  constructor(private readonly raw: Database.Database) {
    this.dbDir = dirname(this.raw.name);
    this.db = drizzle(this.raw, { schema });
    this.applyMigrations();
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

    // Add columns introduced after the initial schema: discovered_resources, project bindings.
    this.ensureColumn("integrations", "discovered_resources_json", "TEXT");
    this.ensureColumn("integrations", "discovered_at", "INTEGER");
    this.ensureColumn("tasks", "project_id", "TEXT");
    this.ensureColumn("tasks", "display_id", "TEXT");
    this.ensureColumn("agents", "integration_id", "TEXT REFERENCES integrations(id) ON DELETE SET NULL");
    this.ensureColumn("prompts", "prompt_type", "TEXT NOT NULL DEFAULT 'user'");

    // Backfill: mark built-in prompts as 'system' so the protection logic
    // can rely on promptType instead of an in-memory ID set.
    this.raw.exec(`
      UPDATE prompts SET prompt_type = 'system'
        WHERE id IN (
          'system_generic_code','instructions_generic_code',
          'system_gerrit_code','system_gitlab_code',
          'system_gerrit_review','system_gitlab_review',
          'instructions_gerrit_code','instructions_gitlab_code',
          'user_gerrit_review','user_gitlab_review'
        );
    `);

    // Clean up orphaned prompt rows from the old id naming scheme.
    this.raw.exec(`
      DELETE FROM prompts WHERE id IN ('system', 'instructions');
    `);

    // Recreate the partial unique index to include REVIEW_DONE/REVIEW_FAILED as
    // terminal states. The IF NOT EXISTS guard in the initial DDL block won't
    // update an already-existing index definition, so we drop and recreate here.
    this.raw.exec(`
      DROP INDEX IF EXISTS idx_tasks_active_ticket_id;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_ticket_id ON tasks(ticket_id)
        WHERE state NOT IN ('DONE', 'FAILED', 'ABANDONED', 'REVIEW_DONE', 'REVIEW_FAILED');
    `);
  }

  /** Insert built-in system prompts on first boot; updates existing rows when the bundled content has changed. */
  private async seedBuiltInPrompts(): Promise<void> {
    const now = new Date();
    const defaults = await this.loadDefaultPrompts();

    for (const prompt of defaults) {
      const existing = await this.getPrompt(prompt.id);
      if (existing) {
        // Update only when the bundled/override content differs from the DB row.
        if (existing.content !== prompt.content) {
          await this.db
            .update(prompts)
            .set({ content: prompt.content, updatedAt: now })
            .where(eq(prompts.id, prompt.id));
        }
        continue;
      }

      await this.db.insert(prompts).values({
        id: prompt.id,
        label: prompt.label,
        content: prompt.content,
        promptType: prompt.promptType,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  /** Resolve the canonical content for each built-in prompt (override file → bundled file). */
  private async loadDefaultPrompts(): Promise<Array<{ id: string; label: string; promptType: "system" | "user"; content: string }>> {
    const entries: Array<{ id: string; label: string; promptType: "system" | "user"; file: string }> = [
      { id: "system_generic_code",      label: "System Prompt — Generic (code)",         promptType: "system", file: "../../prompts/system_generic_code.md" },
      { id: "instructions_generic_code", label: "Instructions Prompt — Generic (code)",   promptType: "system", file: "../../prompts/instructions_generic_code.md" },
      { id: "system_gerrit_code",      label: "System Prompt — Gerrit (code)",         promptType: "system", file: "../../prompts/system_gerrit_code.md" },
      { id: "system_gitlab_code",      label: "System Prompt — GitLab (code)",         promptType: "system", file: "../../prompts/system_gitlab_code.md" },
      { id: "instructions_gerrit_code", label: "Instructions Prompt — Gerrit (code)",  promptType: "system", file: "../../prompts/instructions_gerrit_code.md" },
      { id: "instructions_gitlab_code", label: "Instructions Prompt — GitLab (code)",   promptType: "system", file: "../../prompts/instructions_gitlab_code.md" },
      { id: "system_gerrit_review",    label: "System Prompt — Gerrit (review)",      promptType: "system", file: "../../prompts/system_gerrit_review.md" },
      { id: "system_gitlab_review",    label: "System Prompt — GitLab MR (review)",   promptType: "system", file: "../../prompts/system_gitlab_review.md" },
      { id: "user_gerrit_review",      label: "User Prompt — Gerrit (review)",        promptType: "system", file: "../../prompts/user_gerrit_review.md" },
      { id: "user_gitlab_review",      label: "User Prompt — GitLab MR (review)",     promptType: "system", file: "../../prompts/user_gitlab_review.md" },
    ];

    const results = await Promise.all(
      entries.map(async (entry) => {
        const override = await this.readPromptOverride(entry.id);
        const content = override ?? await this.readPromptFile(entry.file);
        return { id: entry.id, label: entry.label, promptType: entry.promptType, content };
      })
    );
    return results;
  }

  /**
   * Returns user-customized content written to the data directory by a previous
   * UI save, or null if no override exists. Used to restore customizations when
   * the database is wiped and re-seeded.
   */
  private async readPromptOverride(id: string): Promise<string | null> {
    try {
      return await readFile(join(this.dbDir, "prompts", `${id}.md`), "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Writes prompt content to the data directory alongside the database.
   * Survives database wipes — seeding picks it up on the next fresh boot.
   * Non-fatal: if the write fails (e.g. read-only mount) the DB update still wins.
   */
  private async writePromptOverride(id: string, content: string): Promise<void> {
    try {
      const dir = join(this.dbDir, "prompts");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${id}.md`), content, "utf8");
    } catch {
      // Non-fatal: DB is the primary persistence layer.
    }
  }

  /** Read a bundled prompt markdown file relative to this module; throws when the file is missing. */
  private async readPromptFile(relativePath: string): Promise<string> {
    const url = new URL(relativePath, import.meta.url);
    try {
      return await readFile(url, "utf8");
    } catch (err) {
      throw new Error(
        `Required prompt file not found: ${url.pathname} — ensure all files in prompts/ are present before starting the server. (${String(err)})`
      );
    }
  }

  /**
   * SQL Identifier Escaping:
   * - All table and column names are quoted with backticks to prevent SQL injection
   * - Backticks are doubled (`` ) when they appear in identifiers per SQLite escaping rules
   * - This prevents attackers from injecting SQL syntax through parameter names
   * - Example: tableName="tasks\`--" becomes `tasks\`\`--` which is treated as literal identifier
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

  /** Create a new DETECTED code-gen task; returns the existing active task when there is already one for this ticket. */
  async createTask(
    taskId: TaskId,
    ticketId: TicketId,
    ticketTitle = "",
    ticketDescription = "",
    ticketSourceLabel = "redmine",
    ticketUrl?: string,
    displayId?: string
  ): Promise<Task> {
    const now = new Date();
    try {
      await this.db.insert(tasks).values({
        taskId,
        ticketId,
        ticketSourceLabel,
        ticketTitle,
        ticketDescription,
        state: "DETECTED",
        gerritChangeId: null,
        currentPatchset: 0,
        cycleCount: 0,
        failureReason: null,
        ticketUrl: ticketUrl ?? null,
        displayId: displayId ?? null,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err: unknown) {
      // A concurrent call already created an active task for this ticket.
      // Return the existing active task instead of crashing.
      const existing = await this.getTaskByTicketId(ticketId);
      if (existing && !TERMINAL_STATES.has(existing.state)) {
        return existing;
      }
      throw err;
    }
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Failed to create task ${taskId}`);
    return task;
  }

  /** Fetch a single task by its primary key; returns null when not found. */
  async getTask(taskId: TaskId): Promise<Task | null> {
    const row = await this.db.query.tasks.findFirst({
      where: eq(tasks.taskId, taskId),
    });
    return row ? this.rowToTask(row) : null;
  }

  /** Fetch the most recently created task for a ticket ID; returns null when none exists. */
  async getTaskByTicketId(ticketId: TicketId): Promise<Task | null> {
    // Order by createdAt DESC to get the most recent task for this ticket.
    // Without ordering, findFirst() returns an arbitrary (often the oldest)
    // row, which causes the polling loop to see a stale FAILED task and spin
    // up duplicate concurrent tasks for the same ticket.
    const row = await this.db.query.tasks.findFirst({
      where: eq(tasks.ticketId, ticketId),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
    return row ? this.rowToTask(row) : null;
  }

  /** Return all tasks that are not in a terminal state. */
  async getActiveTasks(): Promise<Task[]> {
    const rows = await this.db.query.tasks.findMany({
      where: notInArray(tasks.state, [...TERMINAL_STATES]),
    });
    return rows.map((r) => this.rowToTask(r));
  }

  /** Return every task ordered by most-recently updated first. */
  async getAllTasks(): Promise<Task[]> {
    const rows = await this.db.query.tasks.findMany({
      orderBy: (t, { desc }) => [desc(t.updatedAt)],
    });
    return rows.map((r) => this.rowToTask(r));
  }

  /** Validate and execute a state transition, recording the event in `state_transitions`. */
  async transition(
    taskId: TaskId,
    toState: TaskState,
    metadata: Record<string, unknown> = {}
  ): Promise<Task> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const result = validateTransition(task.state, toState);
    if (result === "idempotent") return task;

    const now = new Date();

    // Review-polling transitions (IN_REVIEW ↔ FEEDBACK_PROCESSING) are
    // housekeeping and do not represent a meaningful coding action, so they
    // should not bump updatedAt.
    const isReviewPollingTransition =
      (task.state === "IN_REVIEW" && toState === "FEEDBACK_PROCESSING") ||
      (task.state === "FEEDBACK_PROCESSING" && toState === "IN_REVIEW");

    this.raw.transaction(() => {
      if (isReviewPollingTransition) {
        this.raw
          .prepare("UPDATE tasks SET state = ? WHERE task_id = ?")
          .run(toState, taskId);
      } else {
        this.raw
          .prepare("UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ?")
          .run(toState, Math.floor(now.getTime() / 1000), taskId);
      }

      this.raw
        .prepare(
          "INSERT INTO state_transitions (task_id, from_state, to_state, metadata, created_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(taskId, task.state, toState, JSON.stringify(metadata), Math.floor(now.getTime() / 1000));
    })();

    const updated = await this.getTask(taskId);
    if (!updated) throw new Error(`Task disappeared after transition: ${taskId}`);
    return updated;
  }

  /** Update the Gerrit Change-Id, patchset number, and optional review URL on a task. */
  async updateExternalChangeId(
    taskId: TaskId,
    changeId: ExternalChangeId,
    patchset: number,
    reviewUrl?: string
  ): Promise<void> {
    const now = new Date();
    await this.db
      .update(tasks)
      .set({
        gerritChangeId: changeId,
        currentPatchset: patchset,
        updatedAt: now,
        ...(reviewUrl !== undefined ? { reviewUrl } : {}),
      })
      .where(eq(tasks.taskId, taskId));
  }

  /** Create a new REVIEW_PENDING code-review task; returns the existing task when the task ID already exists. */
  async createReviewTask(input: {
    taskId: TaskId;
    ticketId: TicketId;
    subject: string;
    description?: string;
    sourceLabel?: string;
    changeId: ExternalChangeId;
    patchset: number;
    reviewUrl?: string;
    displayId?: string;
  }): Promise<Task> {
    const now = new Date();
    try {
      await this.db.insert(tasks).values({
        taskId: input.taskId,
        ticketId: input.ticketId,
        ticketSourceLabel: input.sourceLabel ?? "gerrit",
        ticketTitle: input.subject,
        ticketDescription: input.description ?? "",
        state: "REVIEW_PENDING",
        taskType: "code-review",
        gerritChangeId: input.changeId,
        currentPatchset: input.patchset,
        reviewedPatchset: null,
        cycleCount: 0,
        failureReason: null,
        ticketUrl: null,
        reviewUrl: input.reviewUrl ?? null,
        displayId: input.displayId ?? null,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err: unknown) {
      const existing = await this.getTask(input.taskId);
      if (existing) return existing;
      throw err;
    }
    const task = await this.getTask(input.taskId);
    if (!task) throw new Error(`Failed to create review task ${input.taskId}`);
    return task;
  }

  /** Record the patchset number that was last reviewed so new uploads can be detected. */
  async setReviewedPatchset(taskId: TaskId, patchset: number): Promise<void> {
    const now = new Date();
    await this.db
      .update(tasks)
      .set({ reviewedPatchset: patchset, updatedAt: now })
      .where(eq(tasks.taskId, taskId));
  }

  /** Atomically increment `cycle_count` and return the new value. */
  async incrementCycle(taskId: TaskId): Promise<number> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const newCount = task.cycleCount + 1;
    await this.db
      .update(tasks)
      .set({ cycleCount: newCount, updatedAt: new Date() })
      .where(eq(tasks.taskId, taskId));
    return newCount;
  }

  /** Store a human-readable failure reason on the task row. */
  async setFailureReason(taskId: TaskId, reason: string): Promise<void> {
    await this.db
      .update(tasks)
      .set({ failureReason: reason, updatedAt: new Date() })
      .where(eq(tasks.taskId, taskId));
  }

  /** Persist the JSON-serialised agent result and optional validation result for a cycle. */
  async saveAgentCycle(
    taskId: TaskId,
    cycleNumber: number,
    result: AgentResult,
    validationResult?: ValidationResult
  ): Promise<void> {
    await this.db.insert(agentCycles).values({
      taskId,
      cycleNumber,
      agentResult: JSON.stringify(result),
      validationResult: validationResult ? JSON.stringify(validationResult) : null,
      agentEvents: result.agentEvents ? JSON.stringify(result.agentEvents) : null,
      createdAt: new Date(),
    });
  }

  /** Retrieve all agent cycles for a task, deserialising stored JSON. */
  async getAgentCycles(taskId: TaskId): Promise<AgentCycle[]> {
    const rows = await this.db.query.agentCycles.findMany({
      where: eq(agentCycles.taskId, taskId),
    });
    return rows.map((r) => {
      let result: AgentResult;
      let validationResult: ValidationResult | null = null;
      try {
        result = JSON.parse(r.agentResult) as AgentResult;
      } catch {
        result = { status: "failed", summary: "[corrupt cycle data]", modifiedFiles: [], agentLogs: "", metadata: {} };
      }
      if (r.validationResult) {
        try {
          validationResult = JSON.parse(r.validationResult) as ValidationResult;
        } catch {
          validationResult = null;
        }
      }
      return {
        id: r.id,
        taskId: r.taskId as TaskId,
        cycleNumber: r.cycleNumber,
        result,
        validationResult,
        createdAt: r.createdAt,
      };
    });
  }

  /** Retrieve the structured log events captured during a specific agent cycle. */
  async getAgentCycleEvents(taskId: TaskId, cycleNumber: number): Promise<AgentLogEvent[]> {
    const row = await this.db.query.agentCycles.findFirst({
      where: (c, { and }) => and(eq(c.taskId, taskId), eq(c.cycleNumber, cycleNumber)),
    });
    if (!row?.agentEvents) return [];
    try {
      return JSON.parse(row.agentEvents) as AgentLogEvent[];
    } catch {
      return [];
    }
  }

  /** Retrieve the ordered state transition history for a task. */
  async getStateTransitions(taskId: TaskId): Promise<StateTransition[]> {
    const rows = await this.db.query.stateTransitions.findMany({
      where: eq(stateTransitions.taskId, taskId),
      orderBy: (transition, { asc }) => [asc(transition.createdAt), asc(transition.id)],
    });

    return rows.map((row) => {
      let metadata: Record<string, unknown>;
      try {
        metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        metadata = {};
      }

      return {
        id: row.id,
        taskId: row.taskId as TaskId,
        fromState: row.fromState as TaskState,
        toState: row.toState as TaskState,
        metadata,
        createdAt: row.createdAt,
      };
    });
  }

  /** Count FAILED and ABANDONED tasks for a ticket, optionally scoped to a source label. */
  async getFailedAttemptCount(ticketId: TicketId, ticketSourceLabel?: string): Promise<number> {
    // Source-aware query: if ticketSourceLabel is provided, filter by both ticket_id and source.
    // This prevents Redmine #1 and GitLab #1 from sharing the same failure count.
    // If ticketSourceLabel is undefined, fall back to legacy behavior (all sources).
    if (ticketSourceLabel !== undefined) {
      const row = this.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM tasks WHERE ticket_id = ? AND ticket_source_label = ? AND state IN ('FAILED', 'ABANDONED')"
        )
        .get(ticketId, ticketSourceLabel) as { count: number };
      return row.count;
    }

    // Legacy behavior: count failures across all sources for this ticket_id
    const row = this.raw
      .prepare("SELECT COUNT(*) AS count FROM tasks WHERE ticket_id = ? AND state IN ('FAILED', 'ABANDONED')")
      .get(ticketId) as { count: number };

    return row.count;
  }

  /** Return the set of Gerrit/review comment IDs already processed for a task. */
  async getProcessedCommentIds(taskId: TaskId): Promise<Set<string>> {
    const rows = await this.db.query.processedComments.findMany({
      where: eq(processedComments.taskId, taskId),
    });
    return new Set(rows.map((r) => r.gerritCommentId));
  }

  /** Record that a review comment has been processed so it is not re-sent to the agent. */
  async markCommentProcessed(taskId: TaskId, gerritCommentId: string): Promise<void> {
    await this.db.insert(processedComments).values({
      taskId,
      gerritCommentId,
      createdAt: new Date(),
    });
  }

  /** Write a pause action to the transition log without changing the task state. */
  async pauseTask(taskId: TaskId): Promise<Task> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // Record pause as a metadata-only transition without changing state
    const now = new Date();
    this.raw
      .prepare(
        "INSERT INTO state_transitions (task_id, from_state, to_state, metadata, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(taskId, task.state, task.state, JSON.stringify({ action: "pause" }), Math.floor(now.getTime() / 1000));

    return task;
  }

  /** Write a resume action to the transition log without changing the task state. */
  async resumeTask(taskId: TaskId): Promise<Task> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // Record resume as a metadata-only transition without changing state
    const now = new Date();
    this.raw
      .prepare(
        "INSERT INTO state_transitions (task_id, from_state, to_state, metadata, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(taskId, task.state, task.state, JSON.stringify({ action: "resume" }), Math.floor(now.getTime() / 1000));

    return task;
  }

  /** Return true when the most recent state-transition metadata carries `action: "pause"`. */
  async isTaskPaused(taskId: TaskId): Promise<boolean> {
    // Query the most recent state_transition for this task
    const row = this.raw
      .prepare(
        "SELECT metadata FROM state_transitions WHERE task_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(taskId) as { metadata: string } | undefined;

    if (!row) return false;

    try {
      const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      const latestAction = metadata['action'] as string | undefined;
      // Task is paused if the most recent action is 'pause' (not 'resume')
      return latestAction === "pause";
    } catch {
      return false;
    }
  }

  /** Reset the task to DETECTED with zero cycle count, recording a retry event. */
  async retryTask(taskId: TaskId): Promise<Task> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // Reset cycle count and transition back to DETECTED
    const now = new Date();
    this.raw.transaction(() => {
      this.raw.prepare("UPDATE tasks SET state = ?, cycle_count = ?, failure_reason = ?, updated_at = ? WHERE task_id = ?").run("DETECTED", 0, null, Math.floor(now.getTime() / 1000), taskId);

      this.raw
        .prepare(
          "INSERT INTO state_transitions (task_id, from_state, to_state, metadata, created_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(taskId, task.state, "DETECTED", JSON.stringify({ action: "retry" }), Math.floor(now.getTime() / 1000));
    })();

    const updated = await this.getTask(taskId);
    if (!updated) throw new Error(`Task disappeared after retry: ${taskId}`);
    return updated;
  }

  /** Transition the task to ABANDONED and record an abandon event. */
  async abandonTask(taskId: TaskId): Promise<Task> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const now = new Date();
    this.raw.transaction(() => {
      this.raw.prepare("UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ?").run("ABANDONED", Math.floor(now.getTime() / 1000), taskId);

      this.raw
        .prepare(
          "INSERT INTO state_transitions (task_id, from_state, to_state, metadata, created_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(taskId, task.state, "ABANDONED", JSON.stringify({ action: "abandon" }), Math.floor(now.getTime() / 1000));
    })();

    const updated = await this.getTask(taskId);
    if (!updated) throw new Error(`Task disappeared after abandon: ${taskId}`);
    return updated;
  }

  /** Remove a task: transitions active tasks to ABANDONED first; hard-deletes terminal tasks with all child rows. */
  async deleteTask(taskId: TaskId): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const now = Math.floor(Date.now() / 1000);

    // For non-terminal tasks, only transition to ABANDONED — do NOT remove the row.
    // Completely deleting an active task removes the record that prevents the polling
    // loop from re-detecting the open ticket and spinning up a replacement task within
    // the next poll cycle.  The polling loop's "already completed or abandoned" guard
    // (pollingLoop.ts) skips tickets that have an existing ABANDONED task, so keeping
    // the row is the only way to stop the task from resurrecting.
    // Callers can press delete a second time (task is now ABANDONED — a terminal state)
    // to fully remove the record from the database.
    if (!TERMINAL_STATES.has(task.state)) {
      this.raw.transaction(() => {
        this.raw.prepare("UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ?").run("ABANDONED", now, taskId);
        this.raw
          .prepare(
            "INSERT INTO state_transitions (task_id, from_state, to_state, metadata, created_at) VALUES (?, ?, ?, ?, ?)"
          )
          .run(taskId, task.state, "ABANDONED", JSON.stringify({ action: "delete" }), now);
      })();
      return;
    }

    // For terminal tasks (DONE, FAILED, ABANDONED, …): actually remove all records.
    // The ticket should already be closed or reassigned by the time the task reaches
    // a terminal state, so deleting the row is safe.
    this.raw.transaction(() => {
      this.raw.prepare("DELETE FROM change_per_repository WHERE task_id = ?").run(taskId);
      this.raw.prepare("DELETE FROM processed_comments WHERE task_id = ?").run(taskId);
      this.raw.prepare("DELETE FROM agent_cycles WHERE task_id = ?").run(taskId);
      this.raw.prepare("DELETE FROM state_transitions WHERE task_id = ?").run(taskId);
      this.raw.prepare("DELETE FROM tasks WHERE task_id = ?").run(taskId);
    })();
  }

  /** Hard-delete all tasks (and their child rows) that share the same ticket ID or external change ID. */
  async deleteTaskGroup(taskId: TaskId): Promise<void> {
    // Collect all sibling task IDs. Start with tasks sharing the same ticketId
    // (covers every task type: code-gen retries, review patchset history, …).
    const anchor = this.raw
      .prepare("SELECT ticket_id, gerrit_change_id FROM tasks WHERE task_id = ?")
      .get(taskId) as { ticket_id: string; gerrit_change_id: string | null } | undefined;

    if (!anchor) return;

    const tidSet = new Set<string>();

    // All tasks with the same ticketId (the primary grouping key, works for all types).
    const byTicket = this.raw
      .prepare("SELECT task_id FROM tasks WHERE ticket_id = ?")
      .all(anchor.ticket_id) as Array<Record<string, unknown>>;
    for (const r of byTicket) tidSet.add(r["task_id"] as string);

    // When an external change ID is present (e.g. Gerrit's Change-Id), also
    // collect tasks that share it. This covers the edge case where the
    // integration was recreated (different integrationId → different ticketId)
    // but the underlying change is the same. The check is data-driven — any
    // review system that populates this field gets the same benefit.
    if (anchor.gerrit_change_id) {
      const byChange = this.raw
        .prepare("SELECT task_id FROM tasks WHERE gerrit_change_id = ?")
        .all(anchor.gerrit_change_id) as Array<Record<string, unknown>>;
      for (const r of byChange) tidSet.add(r["task_id"] as string);
    }

    if (tidSet.size === 0) return;

    this.raw.transaction(() => {
      for (const tid of tidSet) {
        this.raw.prepare("DELETE FROM change_per_repository WHERE task_id = ?").run(tid);
        this.raw.prepare("DELETE FROM processed_comments WHERE task_id = ?").run(tid);
        this.raw.prepare("DELETE FROM agent_cycles WHERE task_id = ?").run(tid);
        this.raw.prepare("DELETE FROM state_transitions WHERE task_id = ?").run(tid);
        this.raw.prepare("DELETE FROM tasks WHERE task_id = ?").run(tid);
      }
    })();
  }

  /** Return all prompts ordered by ID. */
  async getPrompts(): Promise<Prompt[]> {
    const rows = await this.db.query.prompts.findMany({
      orderBy: (prompt, { asc }) => [asc(prompt.id)],
    });
    return rows.map((row) => this.rowToPrompt(row));
  }

  /** Fetch a single prompt by ID; returns null when not found. */
  async getPrompt(id: string): Promise<Prompt | null> {
    const row = await this.db.query.prompts.findFirst({
      where: eq(prompts.id, id),
    });
    return row ? this.rowToPrompt(row) : null;
  }

  /** Update an existing prompt's content or insert it when absent; also persists system-prompt overrides to disk. */
  async upsertPrompt(id: string, content: string): Promise<Prompt> {
    const now = new Date();
    const existing = await this.getPrompt(id);

    if (existing) {
      await this.db
        .update(prompts)
        .set({
          label: existing.label,
          content,
          updatedAt: now,
        })
        .where(eq(prompts.id, id));
    } else {
      await this.db.insert(prompts).values({
        id,
        label: this.defaultPromptLabel(id),
        content,
        promptType: "user",
        createdAt: now,
        updatedAt: now,
      });
    }

    // Write back to data dir for built-in (system) prompts so customizations survive a DB wipe.
    if (existing?.promptType === "system") {
      await this.writePromptOverride(id, content);
    }

    const result = await this.getPrompt(id);
    if (!result) throw new Error(`Failed to upsert prompt ${id}`);
    return result;
  }

  /** Create a new user prompt deriving the ID from the label; throws when the derived ID already exists. */
  async createPrompt(label: string, content: string): Promise<Prompt> {
    const id = this.normalizePromptId(label);

    // Validate id format
    if (!id || !/^[a-z][a-z0-9_-]{0,63}$/.test(id)) {
      throw new Error(`Invalid prompt id derived from label: "${id}"`);
    }

    // Check if id already exists
    const existing = await this.getPrompt(id);
    if (existing) {
      throw new Error(`Prompt with id "${id}" already exists`);
    }

    const now = new Date();
    await this.db.insert(prompts).values({
      id,
      label,
      content,
      promptType: "user",
      createdAt: now,
      updatedAt: now,
    });

    const result = await this.getPrompt(id);
    if (!result) throw new Error(`Failed to create prompt ${id}`);
    return result;
  }

  /** Delete a user prompt; throws when the prompt is a built-in system prompt. */
  async deletePrompt(id: string): Promise<void> {
    const existing = await this.getPrompt(id);
    if (!existing) {
      throw new Error(`Prompt not found: "${id}"`);
    }
    if (existing.promptType === "system") {
      throw new Error(`Cannot delete built-in prompt: "${id}"`);
    }

    await this.db.delete(prompts).where(eq(prompts.id, id));
  }

  /** Convert a human-readable label to a lowercase hyphenated ID safe for use as a primary key. */
  private normalizePromptId(label: string): string {
    return label
      .toLowerCase()
      .trim()
      .replace(/\s+/g, "-") // spaces to dashes
      .replace(/[^a-z0-9_-]/g, "") // remove invalid chars
      .replace(/^-+|-+$/g, "") // trim dashes
      .substring(0, 64); // max 64 chars
  }

  /** Return the default display label for a prompt given its ID (currently an identity). */
  private defaultPromptLabel(id: string): string {
    return id;
  }

  /** Map an ORM tasks row to the public Task interface. */
  private rowToTask(
    row: typeof tasks.$inferSelect
  ): Task {
    return {
      taskId: row.taskId as TaskId,
      ticketId: row.ticketId as TicketId,
      ticketSourceLabel: row.ticketSourceLabel,
      ticketTitle: row.ticketTitle,
      ticketDescription: row.ticketDescription,
      state: row.state as TaskState,
      taskType: row.taskType,
      externalChangeId: row.gerritChangeId
        ? makeExternalChangeId(row.gerritChangeId)
        : null,
      currentPatchset: row.currentPatchset,
      reviewedPatchset: row.reviewedPatchset ?? null,
      cycleCount: row.cycleCount,
      failureReason: row.failureReason ?? null,
      ticketUrl: row.ticketUrl ?? null,
      reviewUrl: row.reviewUrl ?? null,
      projectId: (row.projectId ?? null) as Task["projectId"],
      displayId: (row as unknown as { displayId?: string | null }).displayId ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Map an ORM prompts row to the public Prompt interface. */
  private rowToPrompt(row: typeof prompts.$inferSelect): Prompt {
    return {
      id: row.id,
      label: row.label,
      content: row.content,
      promptType: (row.promptType ?? "user") as "system" | "user",
      updatedAt: row.updatedAt,
    };
  }

  // ─── Integration CRUD ─────────────────────────────────────────────────────

  /** Return all configured integrations. */
  async getIntegrations(): Promise<Integration[]> {
    const rows = await this.db.query.integrations.findMany();
    return rows.map((r) => this.rowToIntegration(r));
  }

  /** Fetch a single integration by ID; returns null when not found. */
  async getIntegration(id: string): Promise<Integration | null> {
    const row = await this.db.query.integrations.findFirst({
      where: eq(integrations.id, id),
    });
    return row ? this.rowToIntegration(row) : null;
  }

  /** Insert or update an integration record (matched by ID). */
  async upsertIntegration(data: Omit<Integration, "createdAt" | "updatedAt">): Promise<Integration> {
    const now = new Date();
    const existing = await this.getIntegration(data.id);
    if (existing) {
      await this.db
        .update(integrations)
        .set({
          type: data.type,
          name: data.name,
          configJson: data.configJson,
          enabled: data.enabled ? 1 : 0,
          updatedAt: now,
        })
        .where(eq(integrations.id, data.id));
    } else {
      await this.db.insert(integrations).values({
        id: data.id,
        type: data.type,
        name: data.name,
        configJson: data.configJson,
        enabled: data.enabled ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      });
    }
    const result = await this.getIntegration(data.id);
    if (!result) throw new Error(`Failed to upsert integration ${data.id}`);
    return result;
  }

  /** Delete an integration by ID. */
  async deleteIntegration(id: string): Promise<void> {
    await this.db.delete(integrations).where(eq(integrations.id, id));
  }

  /** Count how many agents, push targets, ticket sources, and review integrations reference this integration. */
  async countIntegrationReferences(id: string): Promise<number> {
    const [agentRows, ticketRows, pushRows, reviewRows] = await Promise.all([
      this.db.query.agents.findMany({ where: eq(agents.integrationId, id) }),
      this.db.query.projectTicketSource.findMany({ where: eq(projectTicketSource.integrationId, id) }),
      this.db.query.projectPushTargets.findMany({ where: eq(projectPushTargets.integrationId, id) }),
      this.db.query.projectReviewIntegration.findMany({ where: eq(projectReviewIntegration.integrationId, id) }),
    ]);
    return agentRows.length + ticketRows.length + pushRows.length + reviewRows.length;
  }

  /** Set the enabled flag on an integration and return the updated record. */
  async setIntegrationEnabled(id: string, enabled: boolean): Promise<Integration> {
    const existing = await this.getIntegration(id);
    if (!existing) throw new Error(`Integration not found: ${id}`);
    await this.db
      .update(integrations)
      .set({ enabled: enabled ? 1 : 0, updatedAt: new Date() })
      .where(eq(integrations.id, id));
    const result = await this.getIntegration(id);
    if (!result) throw new Error(`Integration disappeared after update: ${id}`);
    return result;
  }

  /** Map an ORM integrations row to the public Integration interface. */
  private rowToIntegration(row: typeof integrations.$inferSelect): Integration {
    return {
      id: row.id,
      type: row.type as IntegrationType,
      name: row.name,
      configJson: row.configJson,
      enabled: row.enabled === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      discoveredResourcesJson: row.discoveredResourcesJson ?? null,
      discoveredAt: row.discoveredAt ?? null,
    };
  }

  async listOAuthApps(provider?: string): Promise<OAuthApp[]> {
    const rows = provider
      ? await this.db.query.oauthApps.findMany({ where: eq(oauthApps.provider, provider) })
      : await this.db.query.oauthApps.findMany();
    return rows.map((row) => this.rowToOAuthApp(row));
  }

  async getOAuthApp(provider: string, baseUrl: string): Promise<OAuthApp | null> {
    const normalizedBaseUrl = normalizeGitLabBaseUrl(baseUrl);
    const row = await this.db.query.oauthApps.findFirst({
      where: and(eq(oauthApps.provider, provider), eq(oauthApps.baseUrl, normalizedBaseUrl)),
    });
    return row ? this.rowToOAuthApp(row) : null;
  }

  async upsertOAuthApp(app: Omit<OAuthApp, "createdAt" | "updatedAt">): Promise<OAuthApp> {
    const normalizedBaseUrl = normalizeGitLabBaseUrl(app.baseUrl);
    const now = new Date();
    await this.db
      .insert(oauthApps)
      .values({
        provider: app.provider,
        baseUrl: normalizedBaseUrl,
        clientId: app.clientId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [oauthApps.provider, oauthApps.baseUrl],
        set: { clientId: app.clientId, updatedAt: now },
      });
    const result = await this.getOAuthApp(app.provider, normalizedBaseUrl);
    if (!result) throw new Error(`Failed to upsert OAuth app ${app.provider}:${normalizedBaseUrl}`);
    return result;
  }

  async deleteOAuthApp(provider: string, baseUrl: string): Promise<void> {
    const normalizedBaseUrl = normalizeGitLabBaseUrl(baseUrl);
    await this.db.delete(oauthApps).where(
      and(eq(oauthApps.provider, provider), eq(oauthApps.baseUrl, normalizedBaseUrl))
    );
  }

  private rowToOAuthApp(row: typeof oauthApps.$inferSelect): OAuthApp {
    return {
      provider: row.provider,
      baseUrl: row.baseUrl,
      clientId: row.clientId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ── Per-repository change tracking ──────────────────────────────────────────

  /** Upsert a per-repository change record (Gerrit Change-Id or GitLab MR IID) for a task. */
  async saveChangePerRepository(
    taskId: TaskId,
    repoKey: string,
    changeIdValue: string,
    reviewUrl: string | null,
    status: string,
    integrationId = "",
    reviewSystem = "",
    commitIndex = 0,
    subjectHash: string | null = null
  ): Promise<void> {
    const now = new Date();
    const id = commitIndex > 0 ? `${taskId}:${repoKey}:${commitIndex}` : `${taskId}:${repoKey}`;

    // Upsert: try insert, on conflict update
    this.raw
      .prepare(
        `INSERT INTO change_per_repository (id, task_id, repo_key, change_id, review_url, status, integration_id, review_system, commit_index, subject_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           change_id = excluded.change_id,
           review_url = excluded.review_url,
           status = excluded.status,
           integration_id = excluded.integration_id,
           review_system = excluded.review_system,
           commit_index = excluded.commit_index,
           subject_hash = excluded.subject_hash,
           updated_at = excluded.updated_at`
      )
      .run(id, taskId, repoKey, changeIdValue, reviewUrl, status, integrationId, reviewSystem, commitIndex, subjectHash, now.getTime(), now.getTime());
  }

  /** Return all per-repository change rows for a task. */
  async getChangesForTask(taskId: TaskId): Promise<ChangePerRepository[]> {
    const rows = await this.db
      .select()
      .from(changePerRepository)
      .where(eq(changePerRepository.taskId, taskId));

    return rows.map((r) => ({
      id: r.id,
      taskId: r.taskId as TaskId,
      repoKey: r.repoKey,
      changeId: r.changeId,
      reviewUrl: r.reviewUrl,
      status: r.status,
      integrationId: (r as unknown as { integrationId?: string }).integrationId ?? "",
      reviewSystem: (r as unknown as { reviewSystem?: string }).reviewSystem ?? "",
      commitIndex: (r as unknown as { commitIndex?: number }).commitIndex ?? 0,
      subjectHash: (r as unknown as { subjectHash?: string | null }).subjectHash ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  /** Return all per-repository change rows for multiple tasks in one batch query. */
  async getChangesForTasks(taskIds: TaskId[]): Promise<ChangePerRepository[]> {
    if (taskIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(changePerRepository)
      .where(inArray(changePerRepository.taskId, taskIds as string[]));

    return rows.map((r) => ({
      id: r.id,
      taskId: r.taskId as TaskId,
      repoKey: r.repoKey,
      changeId: r.changeId,
      reviewUrl: r.reviewUrl,
      status: r.status,
      integrationId: (r as unknown as { integrationId?: string }).integrationId ?? "",
      reviewSystem: (r as unknown as { reviewSystem?: string }).reviewSystem ?? "",
      commitIndex: (r as unknown as { commitIndex?: number }).commitIndex ?? 0,
      subjectHash: (r as unknown as { subjectHash?: string | null }).subjectHash ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  /** Find the most recent task associated with an external change/MR ID, optionally scoped to an integration. */
  async findTaskByExternalChangeId(
    integrationId: string | null,
    externalChangeId: string
  ): Promise<Task | null> {
    if (!externalChangeId) return null;

    // 1) Single-repo path — match on tasks.gerrit_change_id directly.
    const singleRow = this.raw
      .prepare("SELECT * FROM tasks WHERE gerrit_change_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(externalChangeId) as Record<string, unknown> | undefined;
    if (singleRow) {
      const orm = await this.db.query.tasks.findFirst({
        where: eq(tasks.taskId, singleRow["task_id"] as TaskId),
      });
      if (orm) return this.rowToTask(orm);
    }

    // 2) Multi-repo path — match on change_per_repository.change_id and
    //    optionally restrict to this integration when `integrationId` is given.
    const cprRow = integrationId
      ? this.raw
          .prepare(
            "SELECT task_id FROM change_per_repository WHERE change_id = ? AND integration_id = ? ORDER BY updated_at DESC LIMIT 1"
          )
          .get(externalChangeId, integrationId) as { task_id: string } | undefined
      : this.raw
          .prepare(
            "SELECT task_id FROM change_per_repository WHERE change_id = ? ORDER BY updated_at DESC LIMIT 1"
          )
          .get(externalChangeId) as { task_id: string } | undefined;

    if (cprRow) {
      const orm = await this.db.query.tasks.findFirst({
        where: eq(tasks.taskId, cprRow.task_id as TaskId),
      });
      if (orm) return this.rowToTask(orm);
    }

    return null;
  }


  /** Bind a task to a project by setting its `project_id` column. */
  async setTaskProjectId(taskId: TaskId, projectId: ProjectId): Promise<void> {
    this.raw
      .prepare("UPDATE tasks SET project_id = ?, updated_at = ? WHERE task_id = ?")
      .run(projectId as string, Math.floor(Date.now() / 1000), taskId);
  }


  /** Update the status (and optionally the change ID) of a per-repository change row. */
  async updateChangePerRepositoryStatus(
    taskId: TaskId,
    repoKey: string,
    status: string,
    changeId?: string
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    if (changeId) {
      // Multi-commit: target the specific row by Gerrit/GitLab change ID
      this.raw
        .prepare(
          `UPDATE change_per_repository SET status = ?, updated_at = ? WHERE task_id = ? AND change_id = ?`
        )
        .run(status, now, taskId, changeId);
    } else {
      // Legacy single-commit: target by composite PK
      const id = `${taskId}:${repoKey}`;
      this.raw
        .prepare(
          `UPDATE change_per_repository SET status = ?, updated_at = ? WHERE id = ?`
        )
        .run(status, now, id);
    }
  }

  /** Close the underlying SQLite database connection. */
  close(): void {
    this.raw.close();
  }

  // ─── Agents CRUD ─────────────────────────────────────────────────

  /** Map an ORM agents row to the public AgentRecord interface. */
  private rowToAgent(row: typeof agents.$inferSelect): AgentRecord {
    return {
      id: row.id as AgentId,
      name: row.name,
      type: row.type,
      modelConfigJson: row.modelConfigJson,
      integrationId: row.integrationId ?? null,
      systemPromptId: row.systemPromptId ?? null,
      instructionsPromptId: row.instructionsPromptId ?? null,
      maxConcurrent: row.maxConcurrent,
      enabled: row.enabled === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Create a new agent record; returns the persisted record with auto-generated ID when none is supplied. */
  async createAgent(input: {
    id?: string;
    name: string;
    type: AgentType;
    modelConfigJson: string;
    integrationId?: string | null;
    systemPromptId?: string | null;
    instructionsPromptId?: string | null;
    maxConcurrent?: number;
    enabled?: boolean;
  }): Promise<AgentRecord> {
    const now = new Date();
    const id = input.id ?? randomUUID();
    await this.db.insert(agents).values({
      id,
      name: input.name,
      type: input.type,
      modelConfigJson: input.modelConfigJson,
      integrationId: input.integrationId ?? null,
      systemPromptId: input.systemPromptId ?? null,
      instructionsPromptId: input.instructionsPromptId ?? null,
      maxConcurrent: input.maxConcurrent ?? 1,
      enabled: input.enabled === false ? 0 : 1,
      createdAt: now,
      updatedAt: now,
    });
    const created = await this.getAgentById(id as AgentId);
    if (!created) throw new Error(`Failed to create agent ${id}`);
    return created;
  }

  /** Fetch a single agent by ID; returns null when not found. */
  async getAgentById(id: AgentId): Promise<AgentRecord | null> {
    const row = await this.db.query.agents.findFirst({ where: eq(agents.id, id) });
    return row ? this.rowToAgent(row) : null;
  }

  /** List all agents, optionally filtered by type or enabled status. */
  async listAgents(filter?: { type?: AgentType; enabled?: boolean }): Promise<AgentRecord[]> {
    const rows = await this.db.query.agents.findMany({
      orderBy: (table, { asc: a }) => [a(table.name)],
    });
    let result = rows.map((r) => this.rowToAgent(r));
    if (filter?.type !== undefined) result = result.filter((a) => a.type === filter.type);
    if (filter?.enabled !== undefined) result = result.filter((a) => a.enabled === filter.enabled);
    return result;
  }

  /** Apply a partial update to an agent record and return the updated row. */
  async updateAgent(
    id: AgentId,
    partial: Partial<Pick<AgentRecord, "name" | "type" | "modelConfigJson" | "integrationId" | "systemPromptId" | "instructionsPromptId" | "maxConcurrent" | "enabled">>
  ): Promise<AgentRecord> {
    const existing = await this.getAgentById(id);
    if (!existing) throw new Error(`Agent not found: ${id}`);
    const now = new Date();
    const update: Record<string, unknown> = { updatedAt: now };
    if (partial.name !== undefined) update["name"] = partial.name;
    if (partial.type !== undefined) update["type"] = partial.type;
    if (partial.modelConfigJson !== undefined) update["modelConfigJson"] = partial.modelConfigJson;
    if (partial.integrationId !== undefined) update["integrationId"] = partial.integrationId;
    if (partial.systemPromptId !== undefined) update["systemPromptId"] = partial.systemPromptId;
    if (partial.instructionsPromptId !== undefined) update["instructionsPromptId"] = partial.instructionsPromptId;
    if (partial.maxConcurrent !== undefined) update["maxConcurrent"] = partial.maxConcurrent;
    if (partial.enabled !== undefined) update["enabled"] = partial.enabled ? 1 : 0;
    await this.db.update(agents).set(update).where(eq(agents.id, id));
    const updated = await this.getAgentById(id);
    if (!updated) throw new Error(`Agent disappeared after update: ${id}`);
    return updated;
  }

  /** Delete an agent; throws when it is still referenced by a project. */
  async deleteAgent(id: AgentId): Promise<void> {
    const referenced = this.raw
      .prepare("SELECT 1 FROM projects WHERE agent_id = ? LIMIT 1")
      .get(id) as unknown;
    if (referenced) {
      throw new Error(`Cannot delete agent ${id}: still referenced by one or more projects`);
    }
    await this.db.delete(agents).where(eq(agents.id, id));
  }

  /** Enable or disable an agent without modifying any other fields. */
  async setAgentEnabled(id: AgentId, enabled: boolean): Promise<void> {
    const existing = await this.getAgentById(id);
    if (!existing) throw new Error(`Agent not found: ${id}`);
    await this.db
      .update(agents)
      .set({ enabled: enabled ? 1 : 0, updatedAt: new Date() })
      .where(eq(agents.id, id));
  }

  // ─── Projects CRUD ───────────────────────────────────────────────

  /** Map an ORM projects row to the public ProjectRecord interface. */
  private rowToProject(row: typeof projects.$inferSelect): ProjectRecord {
    return {
      id: row.id as ProjectId,
      name: row.name,
      type: row.type,
      agentId: row.agentId as AgentId,
      agentOverrideJson: row.agentOverrideJson ?? null,
      postCloneScript: row.postCloneScript,
      enabled: row.enabled === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Create a new project bound to an existing agent; returns the persisted record. */
  async createProject(input: {
    id?: string;
    name: string;
    type: ProjectType;
    agentId: AgentId;
    agentOverrideJson?: string | null;
    postCloneScript?: string;
    enabled?: boolean;
  }): Promise<ProjectRecord> {
    const now = new Date();
    const id = input.id ?? randomUUID();
    const agent = await this.getAgentById(input.agentId);
    if (!agent) throw new Error(`Cannot create project: agent not found: ${input.agentId}`);
    await this.db.insert(projects).values({
      id,
      name: input.name,
      type: input.type,
      agentId: input.agentId,
      agentOverrideJson: input.agentOverrideJson ?? null,
      postCloneScript: input.postCloneScript ?? "",
      enabled: input.enabled === false ? 0 : 1,
      createdAt: now,
      updatedAt: now,
    });
    const created = await this.getProjectById(id as ProjectId);
    if (!created) throw new Error(`Failed to create project ${id}`);
    return created;
  }

  /** Fetch a single project by ID; returns null when not found. */
  async getProjectById(id: ProjectId): Promise<ProjectRecord | null> {
    const row = await this.db.query.projects.findFirst({ where: eq(projects.id, id) });
    return row ? this.rowToProject(row) : null;
  }

  /** List all projects, optionally filtered by type or enabled status. */
  async listProjects(filter?: { type?: ProjectType; enabled?: boolean }): Promise<ProjectRecord[]> {
    const rows = await this.db.query.projects.findMany({
      orderBy: (table, { asc: a }) => [a(table.name)],
    });
    let result = rows.map((r) => this.rowToProject(r));
    if (filter?.type !== undefined) result = result.filter((p) => p.type === filter.type);
    if (filter?.enabled !== undefined) result = result.filter((p) => p.enabled === filter.enabled);
    return result;
  }

  /** Apply a partial update to a project record and return the updated row. */
  async updateProject(
    id: ProjectId,
    partial: Partial<Pick<ProjectRecord, "name" | "type" | "agentId" | "agentOverrideJson" | "postCloneScript" | "enabled">>
  ): Promise<ProjectRecord> {
    const existing = await this.getProjectById(id);
    if (!existing) throw new Error(`Project not found: ${id}`);
    const now = new Date();
    const update: Record<string, unknown> = { updatedAt: now };
    if (partial.name !== undefined) update["name"] = partial.name;
    if (partial.type !== undefined) update["type"] = partial.type;
    if (partial.agentId !== undefined) {
      const agent = await this.getAgentById(partial.agentId);
      if (!agent) throw new Error(`Cannot update project: agent not found: ${partial.agentId}`);
      update["agentId"] = partial.agentId;
    }
    if (partial.agentOverrideJson !== undefined) update["agentOverrideJson"] = partial.agentOverrideJson;
    if (partial.postCloneScript !== undefined) update["postCloneScript"] = partial.postCloneScript;
    if (partial.enabled !== undefined) update["enabled"] = partial.enabled ? 1 : 0;
    await this.db.update(projects).set(update).where(eq(projects.id, id));
    const updated = await this.getProjectById(id);
    if (!updated) throw new Error(`Project disappeared after update: ${id}`);
    return updated;
  }

  /** Delete a project, cascade child rows, and abandon non-terminal tasks linked to it. */
  async deleteProject(id: ProjectId): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const reason = `project ${id} deleted while tasks were still active`;
    const placeholders = [...TERMINAL_STATES].map(() => "?").join(", ");
    this.raw.transaction(() => {
      this.raw
        .prepare(
          `UPDATE tasks SET state = 'ABANDONED', failure_reason = ?, updated_at = ? ` +
          `WHERE project_id = ? AND state NOT IN (${placeholders})`
        )
        .run(reason, now, id, ...TERMINAL_STATES);
      this.raw.prepare("DELETE FROM project_ticket_source WHERE project_id = ?").run(id);
      this.raw.prepare("DELETE FROM project_push_targets WHERE project_id = ?").run(id);
      this.raw.prepare("DELETE FROM project_review_repos WHERE project_id = ?").run(id);
      this.raw.prepare("DELETE FROM project_review_integration WHERE project_id = ?").run(id);
      this.raw.prepare("DELETE FROM projects WHERE id = ?").run(id);
    })();
  }

  /** Enable or disable a project without modifying any other fields. */
  async setProjectEnabled(id: ProjectId, enabled: boolean): Promise<void> {
    const existing = await this.getProjectById(id);
    if (!existing) throw new Error(`Project not found: ${id}`);
    await this.db
      .update(projects)
      .set({ enabled: enabled ? 1 : 0, updatedAt: new Date() })
      .where(eq(projects.id, id));
  }

  // ─── Project ticket source (coding) ──────────────────────────────

  /** Map an ORM project_ticket_source row to the public ProjectTicketSourceRecord interface. */
  private rowToProjectTicketSource(row: typeof projectTicketSource.$inferSelect): ProjectTicketSourceRecord {
    return {
      id: row.id,
      projectId: row.projectId as ProjectId,
      integrationId: row.integrationId,
      ticketProjectKey: row.ticketProjectKey,
      createdAt: row.createdAt,
    };
  }

  /** Atomically replace the ticket source for a project, enforcing the global uniqueness constraint. */
  async setProjectTicketSource(
    projectId: ProjectId,
    input: { integrationId: string; ticketProjectKey: string }
  ): Promise<ProjectTicketSourceRecord> {
    const now = new Date();
    return this.raw.transaction((): ProjectTicketSourceRecord => {
      // Enforce global uniqueness on (integrationId, ticketProjectKey) excluding rows of this project.
      const conflict = this.raw
        .prepare(
          "SELECT project_id FROM project_ticket_source WHERE integration_id = ? AND ticket_project_key = ? AND project_id != ?"
        )
        .get(input.integrationId, input.ticketProjectKey, projectId) as { project_id: string } | undefined;
      if (conflict) {
        throw new Error(
          `Ticket source (${input.integrationId}, ${input.ticketProjectKey}) is already claimed by project ${conflict.project_id}`
        );
      }
      this.raw.prepare("DELETE FROM project_ticket_source WHERE project_id = ?").run(projectId);
      this.raw
        .prepare(
          "INSERT INTO project_ticket_source (project_id, integration_id, ticket_project_key, created_at) VALUES (?, ?, ?, ?)"
        )
        .run(projectId, input.integrationId, input.ticketProjectKey, Math.floor(now.getTime() / 1000));
      const row = this.raw
        .prepare("SELECT id, project_id, integration_id, ticket_project_key, created_at FROM project_ticket_source WHERE project_id = ?")
        .get(projectId) as { id: number; project_id: string; integration_id: string; ticket_project_key: string; created_at: number };
      return {
        id: row.id,
        projectId: row.project_id as ProjectId,
        integrationId: row.integration_id,
        ticketProjectKey: row.ticket_project_key,
        createdAt: new Date(row.created_at * 1000),
      };
    })();
  }

  /** Return the ticket source configuration for a project, or null when none is set. */
  async getProjectTicketSource(projectId: ProjectId): Promise<ProjectTicketSourceRecord | null> {
    const row = await this.db.query.projectTicketSource.findFirst({
      where: eq(projectTicketSource.projectId, projectId),
    });
    return row ? this.rowToProjectTicketSource(row) : null;
  }

  /** Find the project that owns a given (integrationId, ticketProjectKey) ticket source. */
  async findProjectByTicketSource(integrationId: string, ticketProjectKey: string): Promise<ProjectRecord | null> {
    const row = this.raw
      .prepare(
        "SELECT project_id FROM project_ticket_source WHERE integration_id = ? AND ticket_project_key = ? LIMIT 1"
      )
      .get(integrationId, ticketProjectKey) as { project_id: string } | undefined;
    if (!row) return null;
    return this.getProjectById(row.project_id as ProjectId);
  }

  // ─── Project push targets (coding, 1..N) ─────────────────────────

  /** Map an ORM project_push_targets row to the public ProjectPushTargetRecord interface. */
  private rowToProjectPushTarget(row: typeof projectPushTargets.$inferSelect): ProjectPushTargetRecord {
    return {
      id: row.id,
      projectId: row.projectId as ProjectId,
      integrationId: row.integrationId,
      repoKey: row.repoKey,
      cloneUrl: row.cloneUrl,
      targetBranch: row.targetBranch,
      role: row.role,
      commitOrder: row.commitOrder,
      localPath: row.localPath,
      sshKeyPath: row.sshKeyPath ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Append a push target to a project and return the persisted record. */
  async addProjectPushTarget(
    projectId: ProjectId,
    input: {
      integrationId: string;
      repoKey: string;
      cloneUrl: string;
      targetBranch: string;
      role: PushTargetRole;
      commitOrder: number;
      localPath: string;
      sshKeyPath?: string | null;
    }
  ): Promise<ProjectPushTargetRecord> {
    const now = new Date();
    const result = this.raw
      .prepare(
        `INSERT INTO project_push_targets
         (project_id, integration_id, repo_key, clone_url, target_branch, role, commit_order, local_path, ssh_key_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        projectId,
        input.integrationId,
        input.repoKey,
        input.cloneUrl,
        input.targetBranch,
        input.role,
        input.commitOrder,
        input.localPath,
        input.sshKeyPath ?? null,
        Math.floor(now.getTime() / 1000),
        Math.floor(now.getTime() / 1000)
      );
    const id = Number(result.lastInsertRowid);
    const row = await this.db.query.projectPushTargets.findFirst({
      where: eq(projectPushTargets.id, id),
    });
    if (!row) throw new Error(`Failed to create push target on project ${projectId}`);
    return this.rowToProjectPushTarget(row);
  }

  /** Return all push targets for a project ordered by commit order. */
  async listProjectPushTargets(projectId: ProjectId): Promise<ProjectPushTargetRecord[]> {
    const rows = await this.db.query.projectPushTargets.findMany({
      where: eq(projectPushTargets.projectId, projectId),
      orderBy: (table, { asc: a }) => [a(table.commitOrder)],
    });
    return rows.map((r) => this.rowToProjectPushTarget(r));
  }

  /** Delete a single push target by its auto-increment ID. */
  async removeProjectPushTarget(id: number): Promise<void> {
    await this.db.delete(projectPushTargets).where(eq(projectPushTargets.id, id));
  }

  /** Atomically replace all push targets for a project in a single transaction. */
  async replaceProjectPushTargets(
    projectId: ProjectId,
    inputs: Array<{
      integrationId: string;
      repoKey: string;
      cloneUrl: string;
      targetBranch: string;
      role: PushTargetRole;
      commitOrder: number;
      localPath: string;
      sshKeyPath?: string | null;
    }>
  ): Promise<ProjectPushTargetRecord[]> {
    const now = new Date();
    this.raw.transaction(() => {
      this.raw.prepare("DELETE FROM project_push_targets WHERE project_id = ?").run(projectId);
      const stmt = this.raw.prepare(
        `INSERT INTO project_push_targets
         (project_id, integration_id, repo_key, clone_url, target_branch, role, commit_order, local_path, ssh_key_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const input of inputs) {
        stmt.run(
          projectId,
          input.integrationId,
          input.repoKey,
          input.cloneUrl,
          input.targetBranch,
          input.role,
          input.commitOrder,
          input.localPath,
          input.sshKeyPath ?? null,
          Math.floor(now.getTime() / 1000),
          Math.floor(now.getTime() / 1000)
        );
      }
    })();
    return this.listProjectPushTargets(projectId);
  }

  // ─── Project review target (review) ──────────────────────────────

  /**
   * Atomically set the review integration + repo inclusion list for a project.
   * Replaces any existing configuration (upsert semantics).
   */
  async setProjectReviewConfig(
    projectId: ProjectId,
    integrationId: string,
    repoKeys: string[]
  ): Promise<void> {
    this.raw.transaction((): void => {
      this.raw
        .prepare(
          "INSERT INTO project_review_integration (project_id, integration_id) VALUES (?, ?) " +
          "ON CONFLICT(project_id) DO UPDATE SET integration_id = excluded.integration_id"
        )
        .run(projectId, integrationId);
      this.raw.prepare("DELETE FROM project_review_repos WHERE project_id = ?").run(projectId);
      const insertRepo = this.raw.prepare(
        "INSERT INTO project_review_repos (project_id, repo_key) VALUES (?, ?)"
      );
      for (const key of repoKeys) {
        insertRepo.run(projectId, key);
      }
    })();
  }

  /** Return the review integration config for a project, or null when none is configured. */
  async getProjectReviewConfig(projectId: ProjectId): Promise<ProjectReviewConfig | null> {
    const intRow = this.raw
      .prepare("SELECT integration_id FROM project_review_integration WHERE project_id = ?")
      .get(projectId) as { integration_id: string } | undefined;
    if (!intRow) return null;
    const repoRows = this.raw
      .prepare("SELECT repo_key FROM project_review_repos WHERE project_id = ?")
      .all(projectId) as Array<{ repo_key: string }>;
    return {
      integrationId: intRow.integration_id,
      repos: repoRows.map((r) => r.repo_key),
    };
  }

  /** Return all enabled review projects that cover the given integration and repository. */
  async findProjectsByReviewTarget(integrationId: string, repoKey: string): Promise<ProjectRecord[]> {
    const rows = this.raw
      .prepare(
        `SELECT p.id FROM projects p
         JOIN project_review_integration pri ON pri.project_id = p.id
         JOIN project_review_repos prr ON prr.project_id = p.id
         WHERE prr.repo_key = ?
           AND pri.integration_id = ?
           AND p.enabled = 1`
      )
      .all(repoKey, integrationId) as Array<{ id: string }>;
    const results: ProjectRecord[] = [];
    for (const row of rows) {
      const project = await this.getProjectById(row.id as ProjectId);
      if (project) results.push(project);
    }
    return results;
  }

  // ─── Integration discovery snapshot ──────────────────────────────

  /** Store the latest resource-discovery snapshot for an integration. */
  async setIntegrationDiscoveredResources(id: string, json: string): Promise<void> {
    const existing = await this.getIntegration(id);
    if (!existing) throw new Error(`Integration not found: ${id}`);
    const now = new Date();
    await this.db
      .update(integrations)
      .set({ discoveredResourcesJson: json, discoveredAt: now, updatedAt: now })
      .where(eq(integrations.id, id));
  }

  /** Return the stored resource-discovery snapshot (JSON string) and its timestamp for an integration. */
  async getIntegrationDiscoveredResources(id: string): Promise<{ json: string | null; at: Date | null }> {
    const row = await this.db.query.integrations.findFirst({ where: eq(integrations.id, id) });
    if (!row) return { json: null, at: null };
    return {
      json: row.discoveredResourcesJson ?? null,
      at: row.discoveredAt ?? null,
    };
  }

  // ─── Global concurrency ──────────────────────────────────────────

  /** Return the global max-concurrent task limit, or null when unlimited. */
  async getGlobalConcurrencyLimit(): Promise<number | null> {
    const row = await this.db.query.appConcurrency.findFirst({ where: eq(appConcurrency.id, "global") });
    if (!row) return null;
    return row.maxConcurrent ?? null;
  }

  /** Upsert the global max-concurrent task limit; pass null to remove the cap. */
  async setGlobalConcurrencyLimit(value: number | null): Promise<void> {
    const now = new Date();
    const existing = await this.db.query.appConcurrency.findFirst({ where: eq(appConcurrency.id, "global") });
    if (existing) {
      await this.db
        .update(appConcurrency)
        .set({ maxConcurrent: value, updatedAt: now })
        .where(eq(appConcurrency.id, "global"));
    } else {
      await this.db.insert(appConcurrency).values({ id: "global", maxConcurrent: value, updatedAt: now });
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  /** Convenience helper: fetch the ProjectRecord bound to a task via its projectId. */
  async getProjectForTask(task: Task): Promise<ProjectRecord | null> {
    if (!task.projectId) return null;
    return this.getProjectById(task.projectId);
  }
}

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

  const overridePrompts = overrideCfg as { systemPromptId?: unknown; instructionsPromptId?: unknown };
  const sysOverride = typeof overridePrompts.systemPromptId === "string" ? overridePrompts.systemPromptId : null;
  const insOverride = typeof overridePrompts.instructionsPromptId === "string" ? overridePrompts.instructionsPromptId : null;

  const known = new Set(["model", "apiKey", "sessionToken", "systemPromptId", "instructionsPromptId"]);
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
    systemPromptId: sysOverride ?? agent.systemPromptId ?? "system",
    instructionsPromptId: insOverride ?? agent.instructionsPromptId ?? "instructions",
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

