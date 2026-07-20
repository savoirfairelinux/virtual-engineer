import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { createAdminServer, type AdminServerDependencies } from "../../src/admin/adminServer.js";
import type { CostSummary } from "../../src/interfaces.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

function tempDbPath(): string {
  return tempDatabasePath("ve-admin-cost");
}

async function rest(server: Server, path: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Server not bound");
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`);
  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  if (text) {
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* leave null */ }
  }
  return { status: res.status, body: parsed };
}

const SAMPLE: CostSummary = {
  totalUsd: 42,
  totalAiCredits: 4200,
  totalPremiumRequests: 3,
  totalRuns: 7,
  perProject: [
    { projectId: "p1", projectName: "PLATFORM", usd: 28, aiCredits: 2800, premiumRequests: 2, runCount: 4 },
    { projectId: "p2", projectName: "MOBILE", usd: 14, aiCredits: 1400, premiumRequests: 1, runCount: 3 },
  ],
  sinceEpochSeconds: null,
};

function makeDeps(store: SqliteStateStore, getCostSummary: AdminServerDependencies["stateStore"]["getCostSummary"]): AdminServerDependencies {
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
      getCostSummary,
      getModelUsageSummary: vi.fn(async () => ({ byModel: [], perProject: [], totalRuns: 0, totalUsd: 0, sinceEpochSeconds: null })),
    },
    agentStore: store,
    projectStore: store,
    integrationStore: store,
    config: { nodeEnv: "test", logLevel: "error", maxAgentCycles: 3, maxRetryAttempts: 5, pollingIntervalMs: 30000 },
    polling: { isRunning: () => false, getIntervals: () => ({ intervalMs: 30000 }) },
    providers: [],
  };
}

describe("Admin API — Cost summary route (/api/admin/cost-summary)", () => {
  let store: SqliteStateStore;
  let server: Server;
  let getCostSummary: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
    getCostSummary = vi.fn(async () => SAMPLE);
    server = createAdminServer(makeDeps(store, getCostSummary as unknown as AdminServerDependencies["stateStore"]["getCostSummary"]));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    store.close();
  });

  it("returns the aggregated cost summary as JSON (all-time by default)", async () => {
    const r = await rest(server, "/api/admin/cost-summary");
    expect(r.status).toBe(200);
    expect(r.body?.["totalUsd"]).toBe(42);
    expect(r.body?.["totalRuns"]).toBe(7);
    expect((r.body?.["perProject"] as unknown[]).length).toBe(2);
    expect(getCostSummary).toHaveBeenCalledWith(undefined);
  });

  it("passes a `since` window when `days` is provided", async () => {
    const before = Date.now();
    const r = await rest(server, "/api/admin/cost-summary?days=7");
    expect(r.status).toBe(200);
    expect(getCostSummary).toHaveBeenCalledTimes(1);
    const arg = getCostSummary.mock.calls[0]?.[0] as { since: Date } | undefined;
    expect(arg?.since).toBeInstanceOf(Date);
    const expected = before - 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(arg!.since.getTime() - expected)).toBeLessThan(5000);
  });

  it("ignores invalid `days` values and falls back to all-time", async () => {
    const r = await rest(server, "/api/admin/cost-summary?days=-3");
    expect(r.status).toBe(200);
    expect(getCostSummary).toHaveBeenCalledWith(undefined);
  });

  it("returns 500 when aggregation fails", async () => {
    getCostSummary.mockRejectedValueOnce(new Error("boom"));
    const r = await rest(server, "/api/admin/cost-summary");
    expect(r.status).toBe(500);
    expect(r.body?.["error"]).toBeDefined();
  });
});
