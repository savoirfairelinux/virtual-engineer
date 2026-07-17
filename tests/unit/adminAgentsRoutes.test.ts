import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { createAdminServer, type AdminServerDependencies } from "../../src/admin/adminServer.js";
import { fetchAvailableModelsWithPat } from "../../src/agents/copilotModelsService.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

// Partially mock copilotModelsService: replace the SDK-based PAT function with
// a vi.fn() to avoid spawning the copilot CLI process in unit tests.
vi.mock("../../src/agents/copilotModelsService.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/agents/copilotModelsService.js")>();
  return { ...actual, fetchAvailableModelsWithPat: vi.fn() };
});

function tempDbPath(): string {
  return tempDatabasePath("ve-admin-agents");
}

interface FetchResult {
  status: number;
  body: Record<string, unknown> | null;
}

async function rest(server: Server, path: string, opts: { method?: string; body?: unknown } = {}): Promise<FetchResult> {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Server not bound");
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const init: RequestInit = { method: opts.method ?? "GET" };
  if (opts.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  if (text) {
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* leave null */ }
  }
  return { status: res.status, body: parsed };
}

function makeDeps(store: SqliteStateStore): AdminServerDependencies {
  return {
    stateStore: {
      getActiveTasks: vi.fn(async () => []),
      getAllTasks: vi.fn(async () => []),
      getTask: vi.fn(async () => null),
      getAgentCycles: vi.fn(async () => []),
      getAgentCycleEvents: vi.fn(async () => []),
      getStateTransitions: vi.fn(async () => []),
      pauseTask: vi.fn(async () => { throw new Error("not impl"); }),
      resumeTask: vi.fn(async () => { throw new Error("not impl"); }),
      retryTask: vi.fn(async () => { throw new Error("not impl"); }),
      abandonTask: vi.fn(async () => { throw new Error("not impl"); }),
      deleteTask: vi.fn(async () => {}),
      getChangesForTask: vi.fn(async () => []),
      getChangesForTasks: vi.fn(async () => []),
      deleteTaskGroup: vi.fn(async () => {}),
      getCostSummary: vi.fn(async () => ({ totalUsd: 0, totalAiCredits: 0, totalPremiumRequests: 0, totalRuns: 0, perProject: [], sinceEpochSeconds: null })),
      getModelUsageSummary: vi.fn(async () => ({ byModel: [], perProject: [], totalRuns: 0, totalUsd: 0, sinceEpochSeconds: null })),
    },
    agentStore: store,
    projectStore: store,
    integrationStore: store,
    config: {
      nodeEnv: "test",
      logLevel: "error",
      maxAgentCycles: 3,
      maxRetryAttempts: 5,
      pollingIntervalMs: 30000,
    },
    polling: { isRunning: () => false, getIntervals: () => ({ intervalMs: 30000 }) },
    providers: [],
  };
}

describe("Admin API — Agent routes (/api/admin/agents)", () => {
  let store: SqliteStateStore;
  let server: Server;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
    const deps = makeDeps(store);
    server = createAdminServer(deps);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    store.close();
  });

  it("GET / returns empty list initially", async () => {
    const r = await rest(server, "/api/admin/agents");
    expect(r.status).toBe(200);
    expect(r.body?.["agents"]).toEqual([]);
  });

  it("POST / creates an agent and masks secret fields on response", async () => {
    const r = await rest(server, "/api/admin/agents", {
      method: "POST",
      body: {
        name: "Coding Bot",
        type: "coding",
        modelConfig: { model: "gpt-4.1", githubToken: "ghp_secret", apiKey: "sk-1" },
        maxConcurrent: 2,
        enabled: true,
      },
    });
    expect(r.status).toBe(201);
    const agent = r.body?.["agent"] as Record<string, unknown>;
    expect(agent["name"]).toBe("Coding Bot");
    expect(agent["maxConcurrent"]).toBe(2);
    const cfg = agent["modelConfig"] as Record<string, unknown>;
    expect(cfg["model"]).toBe("gpt-4.1");
    expect(cfg["githubToken"]).toBe("********");
    expect(cfg["apiKey"]).toBe("********");
  });

  it("POST / returns 400 for invalid type", async () => {
    const r = await rest(server, "/api/admin/agents", {
      method: "POST",
      body: { name: "Bad", type: "wrong", modelConfig: {} },
    });
    expect(r.status).toBe(400);
  });

  it("POST / returns 400 when name missing", async () => {
    const r = await rest(server, "/api/admin/agents", {
      method: "POST",
      body: { type: "coding", modelConfig: {} },
    });
    expect(r.status).toBe(400);
  });

  it("GET /:id returns 404 for unknown agent", async () => {
    const r = await rest(server, "/api/admin/agents/nope");
    expect(r.status).toBe(404);
  });

  it("GET /:id returns the agent with masked secrets", async () => {
    const created = await store.createAgent({
      name: "Bot",
      type: "coding",
      modelConfigJson: JSON.stringify({ model: "gpt-4.1", githubToken: "tok" }),
    });
    const r = await rest(server, `/api/admin/agents/${created.id}`);
    expect(r.status).toBe(200);
    const agent = r.body?.["agent"] as Record<string, unknown>;
    const cfg = agent["modelConfig"] as Record<string, unknown>;
    expect(cfg["githubToken"]).toBe("********");
  });

  it("PUT /:id preserves secret when masked sentinel is sent", async () => {
    const created = await store.createAgent({
      name: "Bot",
      type: "coding",
      modelConfigJson: JSON.stringify({ model: "gpt-4.1", githubToken: "real-token" }),
    });
    const r = await rest(server, `/api/admin/agents/${created.id}`, {
      method: "PUT",
      body: { modelConfig: { model: "gpt-4o", githubToken: "********" } },
    });
    expect(r.status).toBe(200);
    const stored = await store.getAgentById(created.id);
    const cfg = JSON.parse(stored!.modelConfigJson) as Record<string, unknown>;
    expect(cfg["model"]).toBe("gpt-4o");
    expect(cfg["githubToken"]).toBe("real-token");
  });

  it("PUT /:id overwrites secret when a new value is sent", async () => {
    const created = await store.createAgent({
      name: "Bot",
      type: "coding",
      modelConfigJson: JSON.stringify({ githubToken: "old" }),
    });
    await rest(server, `/api/admin/agents/${created.id}`, {
      method: "PUT",
      body: { modelConfig: { githubToken: "new-token" } },
    });
    const stored = await store.getAgentById(created.id);
    const cfg = JSON.parse(stored!.modelConfigJson) as Record<string, unknown>;
    expect(cfg["githubToken"]).toBe("new-token");
  });

  it("DELETE /:id returns 204 on success", async () => {
    const a = await store.createAgent({ name: "X", type: "coding", modelConfigJson: "{}" });
    const r = await rest(server, `/api/admin/agents/${a.id}`, { method: "DELETE" });
    expect(r.status).toBe(204);
    expect(await store.getAgentById(a.id)).toBeNull();
  });

  it("DELETE /:id returns 409 when a project still references the agent", async () => {
    const a = await store.createAgent({ name: "X", type: "coding", modelConfigJson: "{}" });
    await store.createProject({ name: "P", type: "coding", agentId: a.id });
    const r = await rest(server, `/api/admin/agents/${a.id}`, { method: "DELETE" });
    expect(r.status).toBe(409);
    expect((r.body?.["message"] as string)).toMatch(/referenced/);
  });

  it("PATCH /:id/enable and /disable toggle the flag", async () => {
    const a = await store.createAgent({ name: "X", type: "coding", modelConfigJson: "{}", enabled: false });
    const r1 = await rest(server, `/api/admin/agents/${a.id}/enable`, { method: "PATCH" });
    expect(r1.status).toBe(204);
    expect((await store.getAgentById(a.id))?.enabled).toBe(true);
    const r2 = await rest(server, `/api/admin/agents/${a.id}/disable`, { method: "PATCH" });
    expect(r2.status).toBe(204);
    expect((await store.getAgentById(a.id))?.enabled).toBe(false);
  });

  it("GET / includes projectCount per agent", async () => {
    const a = await store.createAgent({ name: "X", type: "coding", modelConfigJson: "{}" });
    await store.createProject({ name: "P1", type: "coding", agentId: a.id });
    await store.createProject({ name: "P2", type: "coding", agentId: a.id });
    const r = await rest(server, "/api/admin/agents");
    const agents = r.body?.["agents"] as Array<Record<string, unknown>>;
    expect(agents[0]?.["projectCount"]).toBe(2);
  });

  it("POST / accepts integrationId and returns it in the response", async () => {
    // Create a copilot integration first
    await store.upsertIntegration({
      id: "copilot-1",
      provider: "copilot",
      name: "Copilot",
      configJson: JSON.stringify({ apiKey: "ghp_test" }),
      enabled: true,
    });
    const r = await rest(server, "/api/admin/agents", {
      method: "POST",
      body: {
        name: "Linked Bot",
        type: "coding",
        modelConfig: {},
        integrationId: "copilot-1",
      },
    });
    expect(r.status).toBe(201);
    const agent = r.body?.["agent"] as Record<string, unknown>;
    expect(agent["integrationId"]).toBe("copilot-1");
  });

  it("PUT /:id updates integrationId", async () => {
    await store.upsertIntegration({
      id: "copilot-2",
      provider: "copilot",
      name: "Copilot 2",
      configJson: JSON.stringify({ apiKey: "ghp_test" }),
      enabled: true,
    });
    const a = await store.createAgent({ name: "Bot", type: "coding", modelConfigJson: "{}" });
    const r = await rest(server, `/api/admin/agents/${a.id}`, {
      method: "PUT",
      body: { integrationId: "copilot-2" },
    });
    expect(r.status).toBe(200);
    const stored = await store.getAgentById(a.id);
    expect(stored?.integrationId).toBe("copilot-2");
  });

  it("GET /:id/available-models returns models for PAT-mode linked integration", async () => {
    await store.upsertIntegration({
      id: "copilot-pat",
      provider: "copilot",
      name: "Copilot PAT",
      configJson: JSON.stringify({ authMode: "pat", token: "github_pat_test123" }),
      enabled: true,
    });
    const agent = await store.createAgent({
      name: "PAT Bot",
      type: "coding",
      modelConfigJson: "{}",
      integrationId: "copilot-pat",
    });

    try {
      // PAT mode uses SDK (CLI subprocess) — mock it to avoid spawning copilot CLI
      vi.mocked(fetchAvailableModelsWithPat).mockResolvedValueOnce([
        { id: "gpt-4o", name: "GPT-4o", vendor: "Microsoft", version: "gpt-4o", category: "versatile" },
      ]);

      const r = await rest(server, `/api/admin/agents/${agent.id}/available-models`);
      expect(r.status).toBe(200);
      const models = r.body?.["models"] as Array<Record<string, unknown>>;
      expect(models).toHaveLength(1);
      expect(models[0]?.["id"]).toBe("gpt-4o");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
