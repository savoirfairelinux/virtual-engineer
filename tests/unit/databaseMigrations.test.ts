import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { runDatabaseMigrations } from "../../src/state/databaseMigrations.js";
import * as schema from "../../src/state/schema.js";

interface MigrationLedgerRow {
  hash: string;
  created_at: number;
}

interface Journal {
  entries: Array<{ tag: string; when: number }>;
}

interface CountRow {
  count: number;
}

interface NameRow {
  name: string;
}

interface BindingRow {
  id: string;
  project_id: string;
  integration_id: string;
  capability: string;
  config_json: string;
  created_at: number;
  updated_at: number;
}

function createMigrationLedger(raw: Database.Database, row: MigrationLedgerRow): void {
  raw.exec(`
    CREATE TABLE __drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `);
  raw.prepare(
    "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)"
  ).run(row.hash, row.created_at);
}

function openMemoryDatabase(): Database.Database {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  return raw;
}

async function expectedBaseline(): Promise<MigrationLedgerRow> {
  const migrationFolder = join(process.cwd(), "drizzle");
  const journal = JSON.parse(
    await readFile(join(migrationFolder, "meta", "_journal.json"), "utf8")
  ) as Journal;
  const entry = journal.entries[0];
  expect(entry).toBeDefined();
  const sql = await readFile(join(migrationFolder, `${entry?.tag}.sql`), "utf8");
  return {
    hash: createHash("sha256").update(sql).digest("hex"),
    created_at: entry?.when ?? 0,
  };
}

describe("runDatabaseMigrations", () => {
  it("applies the tracked baseline to an empty database", async () => {
    const raw = openMemoryDatabase();
    try {
      runDatabaseMigrations(raw);

      const rows = raw.prepare(
        "SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at"
      ).all() as MigrationLedgerRow[];
      expect(rows).toEqual([await expectedBaseline()]);
    } finally {
      raw.close();
    }
  });

  it("does not add another ledger row on a second run", () => {
    const raw = openMemoryDatabase();
    try {
      runDatabaseMigrations(raw);
      runDatabaseMigrations(raw);

      const row = raw.prepare(
        "SELECT COUNT(*) AS count FROM __drizzle_migrations"
      ).get() as CountRow;
      expect(row.count).toBe(1);
    } finally {
      raw.close();
    }
  });

  it("keeps tracked tables, columns, and indexes aligned with the Drizzle schema", () => {
    const raw = openMemoryDatabase();
    try {
      runDatabaseMigrations(raw);

      const schemaTables = Object.values(schema).flatMap((value) =>
        is(value, SQLiteTable) ? [getTableConfig(value)] : []
      );
      const actualTables = new Set(
        (raw.prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        `).all() as NameRow[]).map((row) => row.name)
      );

      expect(actualTables).toEqual(new Set([
        ...schemaTables.map((table) => table.name),
        "__drizzle_migrations",
      ]));
      for (const table of schemaTables) {
        const actualColumns = (raw.prepare(`PRAGMA table_info(\`${table.name}\`)`).all() as NameRow[])
          .map((row) => row.name)
          .sort();
        const actualIndexes = (raw.prepare(`PRAGMA index_list(\`${table.name}\`)`).all() as NameRow[])
          .map((row) => row.name)
          .filter((name) => !name.startsWith("sqlite_autoindex_"))
          .sort();

        expect(actualColumns, `column drift for ${table.name}`).toEqual(
          table.columns.map((column) => column.name).sort()
        );
        expect(actualIndexes, `index drift for ${table.name}`).toEqual(
          [
            ...table.indexes.map((index) => index.config.name),
            ...table.uniqueConstraints
              .map((constraint) => constraint.getName())
              .filter((name): name is string => name !== undefined),
            ...table.columns
              .filter((column) => column.isUnique)
              .map((column) => column.uniqueName)
              .filter((name): name is string => name !== undefined),
          ].sort()
        );
      }
    } finally {
      raw.close();
    }
  });

  it("rejects a ledger entry whose hash does not match tracked history", () => {
    const raw = openMemoryDatabase();
    try {
      runDatabaseMigrations(raw);
      raw.prepare("UPDATE __drizzle_migrations SET hash = 'mismatched'").run();

      expect(() => runDatabaseMigrations(raw)).toThrow(/does not match tracked history/i);
    } finally {
      raw.close();
    }
  });

  it("rejects a forged matching ledger without the canonical schema", async () => {
    const raw = openMemoryDatabase();
    try {
      createMigrationLedger(raw, await expectedBaseline());

      expect(() => runDatabaseMigrations(raw)).toThrow(/canonical schema validation failed/i);
    } finally {
      raw.close();
    }
  });

  it("rejects unknown future ledger entries", () => {
    const raw = openMemoryDatabase();
    try {
      runDatabaseMigrations(raw);
      raw.prepare(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('future', 9999999999999)"
      ).run();

      expect(() => runDatabaseMigrations(raw)).toThrow(/unknown or future entries/i);
    } finally {
      raw.close();
    }
  });

  it("rejects canonical schemas containing foreign-key violations", () => {
    const raw = openMemoryDatabase();
    try {
      runDatabaseMigrations(raw);
      raw.pragma("foreign_keys = OFF");
      raw.prepare(`
        INSERT INTO state_transitions (
          task_id, from_state, to_state, metadata, created_at
        ) VALUES ('missing-task', 'DETECTED', 'FAILED', '{}', 1)
      `).run();
      raw.pragma("foreign_keys = ON");

      expect(() => runDatabaseMigrations(raw)).toThrow(/foreign key validation failed/i);
    } finally {
      raw.close();
    }
  });

  it("upgrades and adopts a recognized projects-only legacy database", async () => {
    const raw = openMemoryDatabase();
    try {
      raw.exec(`
        CREATE TABLE prompts (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          model_config_json TEXT NOT NULL DEFAULT '{}',
          system_prompt_id TEXT REFERENCES prompts(id),
          instructions_prompt_id TEXT REFERENCES prompts(id),
          max_concurrent INTEGER NOT NULL DEFAULT 1,
          enabled INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          agent_id TEXT NOT NULL REFERENCES agents(id),
          agent_override_json TEXT,
          post_clone_script TEXT NOT NULL DEFAULT '',
          skill_discovery_enabled INTEGER NOT NULL DEFAULT 0,
          local_skills_path TEXT NOT NULL DEFAULT '.github/skills',
          enabled INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO agents (
          id, name, type, model_config_json, enabled, created_at, updated_at
        ) VALUES ('agent', 'Legacy agent', 'coding', '{}', 1, 1, 1);
        INSERT INTO projects (
          id, name, type, agent_id, enabled, created_at, updated_at
        ) VALUES ('legacy', 'Legacy', 'coding', 'agent', 1, 1, 1);
      `);

      runDatabaseMigrations(raw);

      const project = raw.prepare(
        "SELECT name, skill_sources_json FROM projects WHERE id = 'legacy'"
      ).get() as { name: string; skill_sources_json: string };
      const ledger = raw.prepare(
        "SELECT hash, created_at FROM __drizzle_migrations"
      ).get() as MigrationLedgerRow;
      expect(project).toEqual({ name: "Legacy", skill_sources_json: "[]" });
      expect(ledger).toEqual(await expectedBaseline());
    } finally {
      raw.close();
    }
  });

  it("adopts legacy agent cycles with appended columns and preserves rows", () => {
    const raw = openMemoryDatabase();
    try {
      runDatabaseMigrations(raw);
      raw.exec(`
        DROP TABLE __drizzle_migrations;
        DROP INDEX idx_agent_cycles_created_at;
        DROP INDEX idx_agent_cycles_task_id;
        DROP TABLE agent_cycles;
        CREATE TABLE agent_cycles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL REFERENCES tasks(task_id),
          cycle_number INTEGER NOT NULL,
          agent_result TEXT NOT NULL,
          validation_result TEXT,
          created_at INTEGER NOT NULL,
          agent_events TEXT,
          cost_ai_credits REAL,
          cost_usd REAL,
          premium_requests REAL,
          cost_input_tokens INTEGER,
          cost_output_tokens INTEGER,
          cost_cached_tokens INTEGER,
          cost_cache_write_tokens INTEGER,
          cost_model_id TEXT
        );
        CREATE INDEX idx_agent_cycles_task_id ON agent_cycles(task_id);
        CREATE INDEX idx_agent_cycles_created_at ON agent_cycles(created_at);
        INSERT INTO tasks (
          task_id, ticket_id, ticket_source_label, ticket_title,
          ticket_description, state, created_at, updated_at
        ) VALUES ('task', 'ticket', 'redmine', '', '', 'DONE', 1, 1);
        INSERT INTO agent_cycles (
          id, task_id, cycle_number, agent_result, created_at, cost_usd
        ) VALUES (7, 'task', 1, '{}', 2, 0.25);
      `);

      runDatabaseMigrations(raw);

      expect(raw.prepare(`
        SELECT id, task_id, cycle_number, agent_result, created_at, cost_usd
        FROM agent_cycles WHERE id = 7
      `).get()).toEqual({
        id: 7,
        task_id: "task",
        cycle_number: 1,
        agent_result: "{}",
        created_at: 2,
        cost_usd: 0.25,
      });
    } finally {
      raw.close();
    }
  });

  it("drops known retired vendor fields while preserving canonical row data", () => {
    const raw = openMemoryDatabase();
    try {
      runDatabaseMigrations(raw);
      raw.exec(`
        DROP TABLE __drizzle_migrations;
        ALTER TABLE project_vendor_components ADD COLUMN note TEXT NOT NULL DEFAULT '';
        ALTER TABLE project_vendor_components ADD COLUMN integration_id TEXT;
        ALTER TABLE project_vendor_components ADD COLUMN repo_key TEXT;
        INSERT INTO agents (
          id, name, type, model_config_json, enabled, created_at, updated_at
        ) VALUES ('agent', 'Agent', 'coding', '{}', 1, 1, 1);
        INSERT INTO projects (
          id, name, type, agent_id, enabled, created_at, updated_at
        ) VALUES ('project', 'Project', 'coding', 'agent', 1, 1, 1);
        INSERT INTO project_vendor_components (
          id, project_id, source_path, local_path, clone_url, revision, origin,
          note, integration_id, repo_key, created_at, updated_at
        ) VALUES (
          5, 'project', 'manifest.yaml', 'vendor/lib', 'https://example.test/lib.git',
          'abc123', 'patch_required', 'retired guidance', 'gerrit', 'team/lib', 2, 3
        );
      `);

      runDatabaseMigrations(raw);

      expect(raw.prepare(`
        SELECT id, project_id, source_path, local_path, clone_url, revision,
               origin, created_at, updated_at
        FROM project_vendor_components WHERE id = 5
      `).get()).toEqual({
        id: 5,
        project_id: "project",
        source_path: "manifest.yaml",
        local_path: "vendor/lib",
        clone_url: "https://example.test/lib.git",
        revision: "abc123",
        origin: "patch_required",
        created_at: 2,
        updated_at: 3,
      });
      const columns = raw.prepare("PRAGMA table_info(project_vendor_components)")
        .all() as NameRow[];
      expect(columns.map((column) => column.name)).not.toEqual(
        expect.arrayContaining(["note", "integration_id", "repo_key"])
      );
    } finally {
      raw.close();
    }
  });

  it("converts legacy issue and review bindings before dropping predecessor tables", () => {
    const raw = openMemoryDatabase();
    try {
      runDatabaseMigrations(raw);
      raw.exec(`
        DROP TABLE __drizzle_migrations;
        INSERT INTO integrations (
          id, provider, name, config_json, enabled, created_at, updated_at
        ) VALUES
          ('issues', 'redmine', 'Issues', '{}', 1, 10, 11),
          ('reviews', 'gerrit', 'Reviews', '{}', 1, 12, 13);
        INSERT INTO agents (
          id, name, type, model_config_json, enabled, created_at, updated_at
        ) VALUES ('agent', 'Agent', 'coding', '{}', 1, 20, 21);
        INSERT INTO projects (
          id, name, type, agent_id, enabled, created_at, updated_at
        ) VALUES
          ('issue-project', 'Issue project', 'coding', 'agent', 1, 100, 101),
          ('review-project', 'Review project', 'review', 'agent', 1, 200, 201),
          ('empty-review-project', 'Empty review project', 'review', 'agent', 1, 300, 301);
        CREATE TABLE project_ticket_source (
          id INTEGER PRIMARY KEY,
          project_id TEXT NOT NULL,
          integration_id TEXT NOT NULL,
          ticket_project_key TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE project_review_integration (
          project_id TEXT PRIMARY KEY,
          integration_id TEXT NOT NULL
        );
        CREATE TABLE project_review_repos (
          id INTEGER PRIMARY KEY,
          project_id TEXT NOT NULL,
          repo_key TEXT NOT NULL
        );
        INSERT INTO project_ticket_source (
          id, project_id, integration_id, ticket_project_key, created_at
        ) VALUES (7, 'issue-project', 'issues', 'TEAM', 123);
        INSERT INTO project_review_integration (project_id, integration_id)
          VALUES
            ('review-project', 'reviews'),
            ('empty-review-project', 'reviews');
        INSERT INTO project_review_repos (id, project_id, repo_key) VALUES
          (1, 'review-project', 'z/repo'),
          (2, 'review-project', 'a/repo'),
          (3, 'review-project', 'z/repo');
      `);

      runDatabaseMigrations(raw);

      const bindings = raw.prepare(`
        SELECT id, project_id, integration_id, capability, config_json, created_at, updated_at
        FROM project_integration_bindings ORDER BY capability
      `).all() as BindingRow[];
      expect(bindings).toEqual([
        {
          id: "legacy:project_review_integration:empty-review-project",
          project_id: "empty-review-project",
          integration_id: "reviews",
          capability: "code_review",
          config_json: JSON.stringify({ repos: [] }),
          created_at: 300,
          updated_at: 301,
        },
        {
          id: "legacy:project_review_integration:review-project",
          project_id: "review-project",
          integration_id: "reviews",
          capability: "code_review",
          config_json: JSON.stringify({ repos: ["a/repo", "z/repo"] }),
          created_at: 200,
          updated_at: 201,
        },
        {
          id: "legacy:project_ticket_source:7",
          project_id: "issue-project",
          integration_id: "issues",
          capability: "issue_tracking",
          config_json: JSON.stringify({ ticketProjectKey: "TEAM" }),
          created_at: 123,
          updated_at: 123,
        },
      ]);
      for (const table of [
        "project_ticket_source",
        "project_review_integration",
        "project_review_repos",
      ]) {
        expect(raw.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
        ).get(table)).toBeUndefined();
      }
    } finally {
      raw.close();
    }
  });

  it("rejects malformed predecessor binding tables and rolls back adoption", () => {
    const raw = openMemoryDatabase();
    try {
      runDatabaseMigrations(raw);
      raw.exec(`
        DROP TABLE __drizzle_migrations;
        CREATE TABLE project_ticket_source (
          id INTEGER PRIMARY KEY,
          project_id TEXT NOT NULL,
          integration_id TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);

      expect(() => runDatabaseMigrations(raw)).toThrow(/project_ticket_source/i);

      expect(raw.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_ticket_source'"
      ).get()).toBeDefined();
      expect(raw.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'"
      ).get()).toBeUndefined();
    } finally {
      raw.close();
    }
  });

  it("rolls back predecessor conversion when a canonical binding conflicts", () => {
    const raw = openMemoryDatabase();
    try {
      runDatabaseMigrations(raw);
      raw.exec(`
        DROP TABLE __drizzle_migrations;
        INSERT INTO integrations (
          id, provider, name, config_json, enabled, created_at, updated_at
        ) VALUES ('issues', 'redmine', 'Issues', '{}', 1, 10, 11);
        INSERT INTO agents (
          id, name, type, model_config_json, enabled, created_at, updated_at
        ) VALUES ('agent', 'Agent', 'coding', '{}', 1, 20, 21);
        INSERT INTO projects (
          id, name, type, agent_id, enabled, created_at, updated_at
        ) VALUES ('project', 'Project', 'coding', 'agent', 1, 30, 31);
        INSERT INTO project_integration_bindings (
          id, project_id, integration_id, capability, config_json, created_at, updated_at
        ) VALUES ('existing', 'project', 'issues', 'issue_tracking', '{}', 30, 31);
        CREATE TABLE project_ticket_source (
          id INTEGER PRIMARY KEY,
          project_id TEXT NOT NULL,
          integration_id TEXT NOT NULL,
          ticket_project_key TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        INSERT INTO project_ticket_source (
          id, project_id, integration_id, ticket_project_key, created_at
        ) VALUES (9, 'project', 'issues', 'TEAM', 40);
      `);

      expect(() => runDatabaseMigrations(raw)).toThrow(/unique constraint/i);

      expect(raw.prepare(
        "SELECT id, config_json FROM project_integration_bindings WHERE project_id = 'project'"
      ).get()).toEqual({ id: "existing", config_json: "{}" });
      expect(raw.prepare(
        "SELECT ticket_project_key FROM project_ticket_source WHERE id = 9"
      ).get()).toEqual({ ticket_project_key: "TEAM" });
      expect(raw.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'"
      ).get()).toBeUndefined();
    } finally {
      raw.close();
    }
  });

  it("rejects review repositories without a predecessor integration and preserves them", () => {
    const raw = openMemoryDatabase();
    try {
      runDatabaseMigrations(raw);
      raw.exec(`
        DROP TABLE __drizzle_migrations;
        INSERT INTO agents (
          id, name, type, model_config_json, enabled, created_at, updated_at
        ) VALUES ('agent', 'Agent', 'review', '{}', 1, 20, 21);
        INSERT INTO projects (
          id, name, type, agent_id, enabled, created_at, updated_at
        ) VALUES ('review-project', 'Review project', 'review', 'agent', 1, 30, 31);
        CREATE TABLE project_review_repos (
          id INTEGER PRIMARY KEY,
          project_id TEXT NOT NULL,
          repo_key TEXT NOT NULL
        );
        INSERT INTO project_review_repos (id, project_id, repo_key)
          VALUES (1, 'review-project', 'team/repo');
      `);

      expect(() => runDatabaseMigrations(raw)).toThrow(/review repositories.*without.*integration/i);

      expect(raw.prepare(
        "SELECT project_id, repo_key FROM project_review_repos WHERE id = 1"
      ).get()).toEqual({ project_id: "review-project", repo_key: "team/repo" });
      expect(raw.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'"
      ).get()).toBeUndefined();
    } finally {
      raw.close();
    }
  });

  it("rejects predecessor review integrations without a project and preserves them", () => {
    const raw = openMemoryDatabase();
    try {
      runDatabaseMigrations(raw);
      raw.exec(`
        DROP TABLE __drizzle_migrations;
        INSERT INTO integrations (
          id, provider, name, config_json, enabled, created_at, updated_at
        ) VALUES ('reviews', 'gerrit', 'Reviews', '{}', 1, 10, 11);
        CREATE TABLE project_review_integration (
          project_id TEXT PRIMARY KEY,
          integration_id TEXT NOT NULL
        );
        INSERT INTO project_review_integration (project_id, integration_id)
          VALUES ('missing-project', 'reviews');
      `);

      expect(() => runDatabaseMigrations(raw)).toThrow(/review integrations.*without.*project/i);

      expect(raw.prepare(
        "SELECT project_id, integration_id FROM project_review_integration"
      ).get()).toEqual({ project_id: "missing-project", integration_id: "reviews" });
      expect(raw.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'"
      ).get()).toBeUndefined();
    } finally {
      raw.close();
    }
  });

  it("preserves AUTOINCREMENT sequences while canonicalizing legacy tables", () => {
    const raw = openMemoryDatabase();
    try {
      runDatabaseMigrations(raw);
      raw.exec(`
        DROP TABLE __drizzle_migrations;
        INSERT INTO audit_log (
          id, actor_name, action, details_json, created_at
        ) VALUES (100, 'legacy', 'legacy.event', '{}', 1);
        DELETE FROM audit_log WHERE id = 100;
      `);

      runDatabaseMigrations(raw);

      const inserted = raw.prepare(`
        INSERT INTO audit_log (actor_name, action, details_json, created_at)
        VALUES ('current', 'current.event', '{}', 2)
      `).run();
      expect(inserted.lastInsertRowid).toBe(101);
    } finally {
      raw.close();
    }
  });

  it("rejects triggers that are absent from tracked migration history", () => {
    const raw = openMemoryDatabase();
    try {
      runDatabaseMigrations(raw);
      raw.exec(`
        CREATE TRIGGER mutate_inserted_tasks
        AFTER INSERT ON tasks
        BEGIN
          UPDATE tasks SET ticket_title = 'mutated' WHERE task_id = NEW.task_id;
        END;
      `);

      expect(() => runDatabaseMigrations(raw)).toThrow(/unexpected triggers.*mutate_inserted_tasks/i);
    } finally {
      raw.close();
    }
  });

  it("installs canonical triggers after creating the ledger during legacy adoption", async () => {
    const raw = openMemoryDatabase();
    const canonical = openMemoryDatabase();
    try {
      runDatabaseMigrations(raw);
      raw.exec("DROP TABLE __drizzle_migrations");
      runDatabaseMigrations(canonical);
      canonical.exec(`
        CREATE TRIGGER validate_migration_ledger
        BEFORE INSERT ON __drizzle_migrations
        WHEN NEW.hash = ''
        BEGIN
          SELECT RAISE(ABORT, 'empty migration hash');
        END;
      `);

      const migrationModule = await import("../../src/state/databaseMigrations.js");
      const baseline = await expectedBaseline();
      migrationModule.adoptLegacyDatabaseForTest(raw, canonical, {
        hash: baseline.hash,
        folderMillis: baseline.created_at,
      });

      expect(raw.prepare(
        "SELECT tbl_name FROM sqlite_master WHERE type = 'trigger' AND name = 'validate_migration_ledger'"
      ).get()).toEqual({ tbl_name: "__drizzle_migrations" });
    } finally {
      canonical.close();
      raw.close();
    }
  });

  it("rejects unknown legacy columns without losing their data", () => {
    const raw = openMemoryDatabase();
    try {
      runDatabaseMigrations(raw);
      raw.exec(`
        DROP TABLE __drizzle_migrations;
        ALTER TABLE prompts ADD COLUMN private_note TEXT;
        INSERT INTO prompts (
          id, label, content, prompt_type, created_at, updated_at, private_note
        ) VALUES ('custom', 'Custom', 'Content', 'instructions', 1, 2, 'keep me');
      `);

      expect(() => runDatabaseMigrations(raw)).toThrow(/unexpected legacy columns.*prompts\.private_note/i);

      const columns = raw.prepare("PRAGMA table_info(prompts)").all() as NameRow[];
      expect(columns.map((column) => column.name)).toContain("private_note");
      expect(raw.prepare(
        "SELECT private_note FROM prompts WHERE id = 'custom'"
      ).get()).toEqual({ private_note: "keep me" });
      expect(raw.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'"
      ).get()).toBeUndefined();
    } finally {
      raw.close();
    }
  });

  it("rejects an unknown ledgerless database", () => {
    const raw = openMemoryDatabase();
    try {
      raw.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY, value TEXT)");

      expect(() => runDatabaseMigrations(raw)).toThrow(/unrecognized ledgerless database/i);
      expect(raw.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'"
      ).get()).toBeUndefined();
    } finally {
      raw.close();
    }
  });

  it("rolls back legacy upgrades and ledger creation when validation fails", () => {
    const raw = openMemoryDatabase();
    try {
      raw.exec(`
        CREATE TABLE tasks (
          task_id TEXT PRIMARY KEY,
          ticket_id TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'DETECTED',
          gerrit_change_id TEXT,
          current_patchset INTEGER NOT NULL DEFAULT 0,
          cycle_count INTEGER NOT NULL DEFAULT 0,
          failure_reason TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO tasks (task_id, ticket_id, created_at, updated_at)
          VALUES ('one', 'duplicate', 1, 1), ('two', 'duplicate', 1, 1);
      `);

      expect(() => runDatabaseMigrations(raw)).toThrow();

      const columns = raw.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain("project_id");
      expect(raw.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'"
      ).get()).toBeUndefined();
    } finally {
      raw.close();
    }
  });

  it("rejects a weakened legacy constraint and rolls back adoption", () => {
    const raw = openMemoryDatabase();
    try {
      raw.exec(`
        CREATE TABLE app_settings (
          id TEXT PRIMARY KEY,
          polling_interval_ms INTEGER,
          max_agent_cycles INTEGER,
          max_retry_attempts INTEGER,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE prompts (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);

      expect(() => runDatabaseMigrations(raw)).toThrow(/canonical schema validation failed/i);

      const columns = raw.prepare("PRAGMA table_info(app_settings)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain("agent_timeout_ms");
      expect(raw.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'"
      ).get()).toBeUndefined();
    } finally {
      raw.close();
    }
  });
});