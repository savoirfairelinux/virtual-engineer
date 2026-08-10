import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import { createAdminServer, type AdminServerDependencies } from "../../src/admin/adminServer.js";

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
      getChangesForTask: vi.fn(async () => []),
      getChangesForTasks: vi.fn(async () => []),
      deleteTaskGroup: vi.fn(async () => {}),
      getCostSummary: vi.fn(async () => ({ totalUsd: 0, totalAiCredits: 0, totalPremiumRequests: 0, totalRuns: 0, perProject: [], sinceEpochSeconds: null })),
      getModelUsageSummary: vi.fn(async () => ({ byModel: [], perProject: [], totalRuns: 0, totalUsd: 0, sinceEpochSeconds: null })),
    },
    allowUnauthenticatedAdmin: true,
    config: {
      nodeEnv: "test",
      logLevel: "error",
      maxAgentCycles: 3,
      maxRetryAttempts: 5,
      pollingIntervalMs: 30000,
    },
    polling: { isRunning: () => false, getIntervals: () => ({ intervalMs: 30000 }) },
    providers: [],
    concurrency: { snapshot },
  };
}

describe("Admin API — Concurrency routes", () => {
  let server: Server;
  let snap: { global: number; perProject: Record<string, number>; perAgent: Record<string, number> };

  beforeEach(async () => {
    snap = { global: 0, perProject: {}, perAgent: {} };
    server = createAdminServer(makeDeps(() => snap));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  });

  it("GET returns the live tracker snapshot", async () => {
    const r = await rest(server, "/api/admin/concurrency");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ snapshot: { global: 0, perProject: {}, perAgent: {} } });
  });

  it("GET reflects non-zero adapter counters", async () => {
    snap = { global: 3, perProject: { p1: 2, p2: 1 }, perAgent: { "copilot-integration-1": 3 } };
    const r = await rest(server, "/api/admin/concurrency");
    expect(r.status).toBe(200);
    expect(r.body?.["snapshot"]).toEqual({
      global: 3,
      perProject: { p1: 2, p2: 1 },
      perAgent: { "copilot-integration-1": 3 },
    });
  });

  it("PUT returns 405 Method Not Allowed", async () => {
    const r = await rest(server, "/api/admin/concurrency", { method: "PUT", body: { global: 5 } });
    expect(r.status).toBe(405);
  });
});

