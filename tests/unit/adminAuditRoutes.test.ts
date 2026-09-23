import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { makeAgentId, makeTaskId, makeTicketId, type AuditEntry } from "../../src/interfaces.js";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { createAdminServer } from "../../src/admin/adminServer.js";
import { registerBuiltinPlugins } from "../../src/plugins/init.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

registerBuiltinPlugins();

const SECRET = "audit-routes-secret";


function tempDbPath(): string {
  return tempDatabasePath("ve-audit-routes");
}

function makeServer(store: SqliteStateStore): ReturnType<typeof createAdminServer> {
  return createAdminServer({
    stateStore: store,
    integrationStore: store,
    promptStore: store,
    agentStore: store,
    projectStore: store,
    config: {
      nodeEnv: "test",
      logLevel: "info",
      maxAgentCycles: 3,
      maxRetryAttempts: 5,
      pollingIntervalMs: 30_000,
      adminAuthSecret: SECRET,
    },
    polling: {
      isRunning: () => true,
      getIntervals: () => ({ intervalMs: 30_000 }),
    },
    providers: [],
  });
}

async function listen(server: ReturnType<typeof createAdminServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: ReturnType<typeof createAdminServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

interface SessionResponse {
  token: string;
  user: { id: string; username: string; role: string };
}

describe("adminAuditRoutes + audit instrumentation", () => {
  let store: SqliteStateStore;
  let server: ReturnType<typeof createAdminServer>;
  let baseUrl: string;
  let adminToken: string;
  let adminUserId: string;

  /** Fire-and-forget appends land a tick after the response — poll briefly. */
  async function waitForAudit(action: string, expected = 1): Promise<AuditEntry[]> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const { entries } = await store.listAuditEntries({ action });
      if (entries.length >= expected) return entries;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const { entries } = await store.listAuditEntries({ action });
    return entries;
  }

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
    server = makeServer(store);
    baseUrl = await listen(server);
    const setup = await fetch(`${baseUrl}/api/admin/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "Str0ng-Pass-1x" }),
    });
    expect(setup.status).toBe(201);
    const session = (await setup.json()) as SessionResponse;
    adminToken = session.token;
    adminUserId = session.user.id;
  });

  afterEach(async () => {
    await closeServer(server);
    store.close();
  });

  async function createOperatorToken(): Promise<string> {
    const create = await fetch(`${baseUrl}/api/admin/users`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ username: "ops", password: "Str0ng-Pass-1x", role: "operator" }),
    });
    expect(create.status).toBe(201);
    const login = await fetch(`${baseUrl}/api/admin/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ops", password: "Str0ng-Pass-1x" }),
    });
    expect(login.status).toBe(200);
    return ((await login.json()) as SessionResponse).token;
  }

  describe("GET /api/admin/audit", () => {
    it("is admin-only (operator gets 403)", async () => {
      const operatorToken = await createOperatorToken();
      const forbidden = await fetch(`${baseUrl}/api/admin/audit`, {
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(forbidden.status).toBe(403);

      const ok = await fetch(`${baseUrl}/api/admin/audit`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(ok.status).toBe(200);
    });

    it("returns serialized entries with pagination metadata", async () => {
      const response = await fetch(`${baseUrl}/api/admin/audit`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const payload = (await response.json()) as {
        entries: Array<Record<string, unknown>>;
        actions: string[];
        total: number;
        limit: number;
        offset: number;
      };
      expect(payload.limit).toBe(50);
      expect(payload.offset).toBe(0);
      expect(payload.total).toBeGreaterThanOrEqual(1); // auth.setup
      expect(payload.actions).toContain("auth.setup");
      const setupEntry = payload.entries.find((e) => e["action"] === "auth.setup");
      expect(setupEntry).toBeDefined();
      expect(setupEntry).toMatchObject({
        actorName: "root",
        targetType: "user",
        details: expect.objectContaining({ username: "root", role: "admin" }),
      });
      expect(typeof setupEntry?.["id"]).toBe("number");
      expect(typeof setupEntry?.["createdAt"]).toBe("string");
      expect(Number.isNaN(Date.parse(setupEntry?.["createdAt"] as string))).toBe(false);
    });

    it("passes limit/offset/action/actor filters through to the store", async () => {
      for (let i = 0; i < 5; i++) {
        await store.appendAuditEntry({ actorName: "seed-actor", action: "seed.action", details: { i } });
      }
      const filtered = await fetch(
        `${baseUrl}/api/admin/audit?action=seed.action&actor=seed-actor&limit=2&offset=1`,
        { headers: { authorization: `Bearer ${adminToken}` } }
      );
      const payload = (await filtered.json()) as {
        entries: Array<Record<string, unknown>>;
        actions: string[];
        total: number;
        limit: number;
        offset: number;
      };
      expect(payload.total).toBe(5);
      expect(payload.limit).toBe(2);
      expect(payload.offset).toBe(1);
      expect(payload.entries).toHaveLength(2);
      expect(payload.actions).toEqual(expect.arrayContaining(["auth.setup", "seed.action"]));
      // Newest-first: entries 3 and 2 after skipping entry 4.
      expect(payload.entries.map((e) => (e["details"] as { i: number }).i)).toEqual([3, 2]);
      expect(payload.entries.every((e) => e["actorName"] === "seed-actor")).toBe(true);

      const noMatch = await fetch(`${baseUrl}/api/admin/audit?action=does.not.exist`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const empty = (await noMatch.json()) as { entries: unknown[]; total: number };
      expect(empty.entries).toHaveLength(0);
      expect(empty.total).toBe(0);
    });

    it("filters by inclusive calendar dates and rejects invalid ranges", async () => {
      const future = await fetch(
        `${baseUrl}/api/admin/audit?from=2099-01-01&to=2099-01-31`,
        { headers: { authorization: `Bearer ${adminToken}` } },
      );
      expect(future.status).toBe(200);
      expect((await future.json() as { entries: unknown[] }).entries).toHaveLength(0);

      const invalid = await fetch(
        `${baseUrl}/api/admin/audit?from=2026-09-23&to=2026-09-22`,
        { headers: { authorization: `Bearer ${adminToken}` } },
      );
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toEqual({ error: "from must be before or equal to 'to'" });
    });

    it("returns filter options and exports a quoted CSV", async () => {
      await store.appendAuditEntry({
        actorName: "alice",
        action: "integration.update",
        targetType: "integration",
        targetId: "int-1",
        details: { name: "GitLab, primary", note: 'changed "token"' },
      });
      const optionsResponse = await fetch(`${baseUrl}/api/admin/audit/options`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(optionsResponse.status).toBe(200);
      expect(await optionsResponse.json()).toMatchObject({
        actions: expect.arrayContaining(["integration.update"]),
        actors: expect.arrayContaining(["alice"]),
        targetTypes: expect.arrayContaining(["integration"]),
        integrations: [{ id: "int-1", name: "GitLab, primary" }],
        dateRange: {
          from: expect.any(String),
          to: expect.any(String),
        },
      });

      const csvResponse = await fetch(
        `${baseUrl}/api/admin/audit/export.csv?actor=alice&integration=int-1`,
        { headers: { authorization: `Bearer ${adminToken}` } },
      );
      expect(csvResponse.status).toBe(200);
      expect(csvResponse.headers.get("content-type")).toContain("text/csv");
      expect(csvResponse.headers.get("content-disposition")).toContain("attachment");
      const csv = await csvResponse.text();
      expect(csv).toContain('"id","createdAt","actorUserId","actorName","action","targetType","targetId","details"');
      expect(csv).toContain('"alice"');
      expect(csv).toContain('""name"":""GitLab, primary""');
      expect(csv).toContain('changed \\""token\\"""');
    });

    it("neutralizes formula-like values in CSV cells", async () => {
      await store.appendAuditEntry({
        actorName: "=HYPERLINK(\"https://example.test\")",
        action: "audit.csv_formula",
        targetType: "integration",
        targetId: "+target",
        details: { note: "@SUM(1,1)" },
      });
      const response = await fetch(
        `${baseUrl}/api/admin/audit/export.csv?action=audit.csv_formula`,
        { headers: { authorization: `Bearer ${adminToken}` } },
      );
      expect(response.status).toBe(200);
      const csv = await response.text();
      expect(csv).toContain('"\'=HYPERLINK(""https://example.test"")"');
      expect(csv).toContain('"\'+target"');
      expect(csv).toContain('"{""note"":""@SUM(1,1)""}"');
    });

    it("exports a stable snapshot when entries are appended between pages", async () => {
      for (let index = 0; index <= 200; index++) {
        await store.appendAuditEntry({
          actorName: "snapshot-user",
          action: "audit.snapshot",
          details: { index },
        });
      }
      const listEntries = store.listAuditEntries.bind(store);
      let appendedDuringExport = false;
      vi.spyOn(store, "listAuditEntries").mockImplementation(async (filter) => {
        const result = await listEntries(filter);
        if (!appendedDuringExport && filter?.action === "audit.snapshot" && filter.offset === 0) {
          appendedDuringExport = true;
          await store.appendAuditEntry({
            actorName: "snapshot-user",
            action: "audit.snapshot",
            details: { index: 999 },
          });
        }
        return result;
      });

      const response = await fetch(
        `${baseUrl}/api/admin/audit/export.csv?action=audit.snapshot`,
        { headers: { authorization: `Bearer ${adminToken}` } },
      );
      expect(response.status).toBe(200);
      const csv = await response.text();
      expect(csv.trimEnd().split("\r\n")).toHaveLength(202);
      expect(csv).toContain('""index"":200');
      expect(csv).not.toContain('""index"":999');
    });
  });

  describe("mutation instrumentation", () => {
    it("records integration.create with the authenticated actor", async () => {
      const response = await fetch(`${baseUrl}/api/admin/integrations`, {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ id: "int-redmine-1", provider: "redmine", name: "Redmine Agent", config: {} }),
      });
      expect(response.status).toBe(201);
      const entries = await waitForAudit("integration.create");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actorUserId: adminUserId,
        actorName: "root",
        action: "integration.create",
        targetType: "integration",
        targetId: "int-redmine-1",
        details: { name: "Redmine Agent", provider: "redmine" },
      });
    });

    it("records task.pause with the authenticated actor", async () => {
      await store.createTask(makeTaskId("task-1"), makeTicketId("101"), "Title");
      const response = await fetch(`${baseUrl}/api/admin/tasks/task-1/pause`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(response.status).toBe(200);
      const entries = await waitForAudit("task.pause");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actorName: "root",
        action: "task.pause",
        targetType: "task",
        targetId: "task-1",
        details: { ticketId: "101" },
      });
    });

    it("records prompt.create with the authenticated actor", async () => {
      const response = await fetch(`${baseUrl}/api/admin/prompts`, {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ label: "Audit Prompt", content: "hello world", promptType: "instructions" }),
      });
      expect(response.status).toBe(201);
      const entries = await waitForAudit("prompt.create");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actorName: "root",
        action: "prompt.create",
        targetType: "prompt",
        details: { label: "Audit Prompt" },
      });
    });

    it("records project.disable with the authenticated actor", async () => {
      const agent = await store.createAgent({
        name: "Coder", type: "coding", modelConfigJson: "{}",
        systemPromptId: "system_generic_code", instructionsPromptId: "instructions_generic_code",
      });
      const project = await store.createProject({ name: "Proj", type: "coding", agentId: makeAgentId(agent.id) });
      const response = await fetch(`${baseUrl}/api/admin/projects/${project.id}/disable`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(response.status).toBe(204);
      const entries = await waitForAudit("project.disable");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actorName: "root",
        action: "project.disable",
        targetType: "project",
        targetId: project.id,
        details: { name: "Proj" },
      });
    });
  });
});
