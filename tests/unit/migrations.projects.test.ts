import { describe, it, expect } from "vitest";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

function tempDbPath(): string {
  return tempDatabasePath("ve-migrations");
}

interface TableInfoRow {
  name: string;
}

interface ColumnInfoRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

describe("Phase 2 migrations", () => {
  it("creates the new tables on a fresh DB", async () => {
    const store = await SqliteStateStore.create(tempDbPath());
    try {
      const raw = (store as unknown as { raw: { prepare: (s: string) => { all: () => unknown[] } } }).raw;
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as TableInfoRow[];
      const names = new Set(tables.map((t) => t.name));
      for (const expected of [
        "agents",
        "projects",
        "project_integration_bindings",
        "project_push_targets",
        "app_concurrency",
      ]) {
        expect(names.has(expected), `missing table ${expected}`).toBe(true);
      }
    } finally {
      store.close();
    }
  });

  it("adds discovered_resources_json + discovered_at to integrations and project_id to tasks", async () => {
    const store = await SqliteStateStore.create(tempDbPath());
    try {
      const raw = (store as unknown as { raw: { prepare: (s: string) => { all: () => unknown[] } } }).raw;
      const intCols = raw.prepare("PRAGMA table_info(integrations)").all() as ColumnInfoRow[];
      const intColNames = new Set(intCols.map((c) => c.name));
      expect(intColNames.has("discovered_resources_json")).toBe(true);
      expect(intColNames.has("discovered_at")).toBe(true);

      const taskCols = raw.prepare("PRAGMA table_info(tasks)").all() as ColumnInfoRow[];
      const taskColNames = new Set(taskCols.map((c) => c.name));
      expect(taskColNames.has("project_id")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("enforces UNIQUE (integration_id, ticket_project_key) on project_ticket_source", async () => {
    const store = await SqliteStateStore.create(tempDbPath());
    try {
      const a = await store.createAgent({
        name: "A",
        type: "coding",
        modelConfigJson: "{}",
        enabled: true,
      });
      await store.upsertIntegration({ id: "r1", provider: "redmine", name: "R", configJson: "{}", enabled: true });
      const p1 = await store.createProject({ name: "P1", type: "coding", agentId: a.id });
      const p2 = await store.createProject({ name: "P2", type: "coding", agentId: a.id });
      await store.setProjectTicketSource(p1.id, { integrationId: "r1", ticketProjectKey: "K" });
      await expect(
        store.setProjectTicketSource(p2.id, { integrationId: "r1", ticketProjectKey: "K" })
      ).rejects.toThrow();
    } finally {
      store.close();
    }
  });

  it("app_concurrency CHECK constraint blocks non-'global' ids", async () => {
    const store = await SqliteStateStore.create(tempDbPath());
    try {
      const raw = (store as unknown as { raw: { prepare: (s: string) => { run: (...args: unknown[]) => void } } }).raw;
      expect(() =>
        raw
          .prepare("INSERT INTO app_concurrency (id, max_concurrent, updated_at) VALUES (?, ?, ?)")
          .run("not-global", 1, Math.floor(Date.now() / 1000))
      ).toThrow();
    } finally {
      store.close();
    }
  });
});
