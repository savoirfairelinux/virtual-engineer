import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import type { Server } from "node:http";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { createAdminServer, type AdminServerDependencies } from "../../src/admin/adminServer.js";

function tempDbPath(): string {
  return join(tmpdir(), `ve-admin-identities-${randomUUID()}.db`);
}

interface FetchResult { status: number; body: Record<string, unknown> | null; }

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
    identityStore: store,
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

describe("Admin API — Identity routes (/api/admin/identities)", () => {
  let store: SqliteStateStore;
  let server: Server;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
    server = createAdminServer(makeDeps(store));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    store.close();
  });

  it("GET / returns empty initially", async () => {
    const r = await rest(server, "/api/admin/identities");
    expect(r.status).toBe(200);
    expect(r.body?.["identities"]).toEqual([]);
  });

  it("POST / creates an identity, then GET/PUT/DELETE work", async () => {
    const created = await rest(server, "/api/admin/identities", {
      method: "POST",
      body: { name: "VE Bot", email: "ve@example.com", username: "ve-bot", signature: "— VE" },
    });
    expect(created.status).toBe(201);
    const identity = created.body?.["identity"] as Record<string, unknown>;
    expect(identity["name"]).toBe("VE Bot");
    expect(identity["signature"]).toBe("— VE");
    const id = identity["id"] as string;

    const fetched = await rest(server, `/api/admin/identities/${id}`);
    expect(fetched.status).toBe(200);

    const updated = await rest(server, `/api/admin/identities/${id}`, {
      method: "PUT",
      body: { name: "Renamed" },
    });
    expect(updated.status).toBe(200);
    expect((updated.body?.["identity"] as Record<string, unknown>)["name"]).toBe("Renamed");

    const deleted = await rest(server, `/api/admin/identities/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);

    const gone = await rest(server, `/api/admin/identities/${id}`);
    expect(gone.status).toBe(404);
  });

  it("POST / rejects a missing name", async () => {
    const r = await rest(server, "/api/admin/identities", { method: "POST", body: { email: "x@y.z" } });
    expect(r.status).toBe(400);
  });
});
