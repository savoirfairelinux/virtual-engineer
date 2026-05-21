import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import type { Server } from "node:http";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { createAdminServer, type AdminServerDependencies } from "../../src/admin/adminServer.js";

function tempDb(): string {
  return join(tmpdir(), `ve-admin-conc-${randomUUID()}.db`);
}

interface Result {
  status: number;
  body: Record<string, unknown> | null;
}

async function rest(server: Server, path: string, opts: { method?: string; body?: unknown } = {}): Promise<Result> {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server not bound");
  const init: RequestInit = { method: opts.method ?? "GET" };
  if (opts.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  const r = await fetch(`http://127.0.0.1:${addr.port}${path}`, init);
  const text = await r.text();
  let parsed: Record<string, unknown> | null = null;
  if (text) {
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* leave null */ }
  }
  return { status: r.status, body: parsed };
}

function makeDeps(
  store: SqliteStateStore,
  snapshot: () => { global: number; perProject: Record<string, number>; perAgent: Record<string, number> }
): AdminServerDependencies {
  return {
    stateStore: {
      getActiveTasks: vi.fn(async () => []),
      getAllTasks: vi.fn(async () => []),
      getTask: vi.fn(async () => null),
      getAgentCycles: vi.fn(async () => []),
      getAgentCycleEvents: vi.fn(async () => []),
      getStateTransitions: vi.fn(async () => []),
      pauseTask: vi.fn(async () => { throw new Error("nimpl"); }),
      resumeTask: vi.fn(async () => { throw new Error("nimpl"); }),
      retryTask: vi.fn(async () => { throw new Error("nimpl"); }),
      abandonTask: vi.fn(async () => { throw new Error("nimpl"); }),
      deleteTask: vi.fn(async () => {}),
      deleteTaskGroup: vi.fn(async () => {}),
    },
    config: {
      nodeEnv: "test",
      logLevel: "error",
      maxAgentCycles: 3,
      maxRetryAttempts: 5,
      pollingIntervalMs: 30000,
    },
    polling: { isRunning: () => false, getIntervals: () => ({ intervalMs: 30000 }) },
    providers: [],
    concurrency: {
      getGlobalLimit: () => store.getGlobalConcurrencyLimit(),
      setGlobalLimit: (v) => store.setGlobalConcurrencyLimit(v),
      snapshot,
    },
  };
}

describe("Admin API — Phase 6 Concurrency routes", () => {
  let store: SqliteStateStore;
  let server: Server;
  let snap: { global: number; perProject: Record<string, number>; perAgent: Record<string, number> };

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDb());
    snap = { global: 0, perProject: {}, perAgent: {} };
    server = createAdminServer(makeDeps(store, () => snap));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    store.close();
  });

  it("GET returns global=null when no row is set", async () => {
    const r = await rest(server, "/api/admin/concurrency");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ global: null, snapshot: { global: 0, perProject: {}, perAgent: {} } });
  });

  it("PUT sets the global limit and GET returns it", async () => {
    const put = await rest(server, "/api/admin/concurrency", { method: "PUT", body: { global: 7 } });
    expect(put.status).toBe(200);
    expect(put.body?.["global"]).toBe(7);
    const get = await rest(server, "/api/admin/concurrency");
    expect(get.body?.["global"]).toBe(7);
  });

  it("PUT with global=null clears the limit", async () => {
    await rest(server, "/api/admin/concurrency", { method: "PUT", body: { global: 4 } });
    const cleared = await rest(server, "/api/admin/concurrency", { method: "PUT", body: { global: null } });
    expect(cleared.status).toBe(200);
    expect(cleared.body?.["global"]).toBeNull();
    const get = await rest(server, "/api/admin/concurrency");
    expect(get.body?.["global"]).toBeNull();
  });

  it("GET reports the live tracker snapshot", async () => {
    snap = { global: 3, perProject: { p1: 2, p2: 1 }, perAgent: { a1: 3 } };
    const r = await rest(server, "/api/admin/concurrency");
    expect(r.status).toBe(200);
    expect(r.body?.["snapshot"]).toEqual({ global: 3, perProject: { p1: 2, p2: 1 }, perAgent: { a1: 3 } });
  });

  it("PUT rejects negative or non-numeric values", async () => {
    const r1 = await rest(server, "/api/admin/concurrency", { method: "PUT", body: { global: -1 } });
    expect(r1.status).toBe(400);
    const r2 = await rest(server, "/api/admin/concurrency", { method: "PUT", body: { global: "abc" } });
    expect(r2.status).toBe(400);
  });
});
