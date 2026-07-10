import { describe, it, expect, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import { createAdminServer, type AdminServerDependencies } from "../../src/admin/adminServer.js";

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

function makeDeps(runtimeGateway: AdminServerDependencies["runtimeGateway"]): AdminServerDependencies {
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
    config: {
      nodeEnv: "test",
      logLevel: "error",
      maxAgentCycles: 3,
      maxRetryAttempts: 5,
      pollingIntervalMs: 30000,
    },
    polling: { isRunning: () => false, getIntervals: () => ({ intervalMs: 30000 }) },
    providers: [],
    runtimeGateway,
  };
}

describe("Admin API — Runtime status route", () => {
  let server: Server;

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  });

  async function start(runtimeGateway: AdminServerDependencies["runtimeGateway"]): Promise<void> {
    server = createAdminServer(makeDeps(runtimeGateway));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  }

  it("reports a healthy kubernetes gateway with its address", async () => {
    await start({ healthy: async () => true, address: "127.0.0.1:8080" });
    const r = await rest(server, "/api/admin/runtime/status");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      driver: "kubernetes",
      gatewayConfigured: true,
      gatewayAddress: "127.0.0.1:8080",
      gatewayHealthy: true,
    });
  });

  it("reports unhealthy when the probe throws (best-effort)", async () => {
    await start({ healthy: async () => { throw new Error("unreachable"); }, address: "127.0.0.1:8080" });
    const r = await rest(server, "/api/admin/runtime/status");
    expect(r.status).toBe(200);
    expect(r.body?.["gatewayHealthy"]).toBe(false);
  });

  it("reports not-configured when no gateway address is set", async () => {
    await start({ healthy: async () => false, address: undefined });
    const r = await rest(server, "/api/admin/runtime/status");
    expect(r.status).toBe(200);
    expect(r.body?.["gatewayConfigured"]).toBe(false);
    expect(r.body?.["gatewayAddress"]).toBe(null);
  });
});
