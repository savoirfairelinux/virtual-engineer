import { describe, it, expect, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import { createAdminServer, type AdminServerDependencies } from "../../src/admin/adminServer.js";
import type { ModelUsageSummary } from "../../src/interfaces.js";

interface Result {
  status: number;
  body: Record<string, unknown> | null;
}

async function rest(server: Server, path: string): Promise<Result> {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server not bound");
  const r = await fetch(`http://127.0.0.1:${addr.port}${path}`);
  const text = await r.text();
  let parsed: Record<string, unknown> | null = null;
  if (text) {
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* leave null */ }
  }
  return { status: r.status, body: parsed };
}

const emptySummary: ModelUsageSummary = {
  byModel: [],
  perProject: [],
  totalRuns: 0,
  totalUsd: 0,
  sinceEpochSeconds: null,
};

function makeDeps(getModelUsageSummary: AdminServerDependencies["stateStore"]["getModelUsageSummary"]): AdminServerDependencies {
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
      getModelUsageSummary,
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
    concurrency: { snapshot: () => ({ global: 0, perProject: {}, perAgent: {} }) },
  };
}

describe("Admin API — Model usage route", () => {
  let server: Server;

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns the model usage summary", async () => {
    const summary: ModelUsageSummary = {
      byModel: [{ modelId: "claude-sonnet", runCount: 3, usd: 0.06 }],
      perProject: [{ projectId: "p1", projectName: "BACKEND", models: [{ modelId: "claude-sonnet", runCount: 3, usd: 0.06 }] }],
      totalRuns: 3,
      totalUsd: 0.06,
      sinceEpochSeconds: null,
    };
    const fn = vi.fn(async () => summary);
    server = createAdminServer(makeDeps(fn));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const res = await rest(server, "/api/admin/model-usage");
    expect(res.status).toBe(200);
    expect(res.body?.["totalRuns"]).toBe(3);
    expect(fn).toHaveBeenCalledWith(undefined);
  });

  it("maps ?days=<n> to a `since` Date", async () => {
    const fn = vi.fn(async () => emptySummary);
    server = createAdminServer(makeDeps(fn));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const before = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const res = await rest(server, "/api/admin/model-usage?days=7");
    const after = Date.now() - 7 * 24 * 60 * 60 * 1000;

    expect(res.status).toBe(200);
    const arg = (fn.mock.calls[0] as unknown[])?.[0] as { since?: Date } | undefined;
    expect(arg?.since).toBeInstanceOf(Date);
    const sinceMs = arg!.since!.getTime();
    expect(sinceMs).toBeGreaterThanOrEqual(before - 1000);
    expect(sinceMs).toBeLessThanOrEqual(after + 1000);
  });

  it("ignores invalid days and passes undefined", async () => {
    const fn = vi.fn(async () => emptySummary);
    server = createAdminServer(makeDeps(fn));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const res = await rest(server, "/api/admin/model-usage?days=abc");
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledWith(undefined);
  });

  it("returns 500 when the store throws", async () => {
    const fn = vi.fn(async () => { throw new Error("boom"); });
    server = createAdminServer(makeDeps(fn));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const res = await rest(server, "/api/admin/model-usage");
    expect(res.status).toBe(500);
  });
});
