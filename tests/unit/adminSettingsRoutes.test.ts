import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import { createAdminServer, type AdminServerDependencies } from "../../src/admin/adminServer.js";
import type { SettingsController, EffectiveWorkflowSettings, WorkflowSettingsPatch } from "../../src/admin/adminSettingsRoutes.js";

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

function makeDeps(settings?: SettingsController): AdminServerDependencies {
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
    ...(settings ? { settings } : {}),
  };
}

function makeController(): SettingsController & { current: EffectiveWorkflowSettings; update: ReturnType<typeof vi.fn> } {
  const defaults: EffectiveWorkflowSettings = { pollingIntervalMs: 30000, maxAgentCycles: 3, maxRetryAttempts: 5 };
  const current: EffectiveWorkflowSettings = { ...defaults };
  const update = vi.fn(async (patch: WorkflowSettingsPatch) => {
    for (const [key, value] of Object.entries(patch) as [keyof EffectiveWorkflowSettings, number | null][]) {
      // null clears the override → fall back to the default
      current[key] = value ?? defaults[key];
    }
    return { ...current };
  });
  return { current, get: () => ({ ...current }), update };
}

describe("Admin API — Settings routes", () => {
  let server: Server;
  let controller: ReturnType<typeof makeController>;

  beforeEach(async () => {
    controller = makeController();
    server = createAdminServer(makeDeps(controller));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  });

  it("GET returns the current effective settings", async () => {
    const r = await rest(server, "/api/admin/settings");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ settings: { pollingIntervalMs: 30000, maxAgentCycles: 3, maxRetryAttempts: 5 } });
  });

  it("PUT validates, persists, and returns updated settings", async () => {
    const r = await rest(server, "/api/admin/settings", {
      method: "PUT",
      body: { pollingIntervalMs: 15000, maxAgentCycles: 4, maxRetryAttempts: 8 },
    });
    expect(r.status).toBe(200);
    expect(controller.update).toHaveBeenCalledWith({ pollingIntervalMs: 15000, maxAgentCycles: 4, maxRetryAttempts: 8 });
    expect(r.body).toEqual({ settings: { pollingIntervalMs: 15000, maxAgentCycles: 4, maxRetryAttempts: 8 } });
  });

  it("PUT accepts a partial update", async () => {
    const r = await rest(server, "/api/admin/settings", { method: "PUT", body: { maxAgentCycles: 2 } });
    expect(r.status).toBe(200);
    expect(controller.update).toHaveBeenCalledWith({ maxAgentCycles: 2 });
  });

  it("PUT rejects non-positive integers", async () => {
    const r = await rest(server, "/api/admin/settings", { method: "PUT", body: { maxAgentCycles: 0 } });
    expect(r.status).toBe(400);
    expect(controller.update).not.toHaveBeenCalled();
  });

  it("PUT rejects non-integer values", async () => {
    const r = await rest(server, "/api/admin/settings", { method: "PUT", body: { pollingIntervalMs: 1.5 } });
    expect(r.status).toBe(400);
    expect(controller.update).not.toHaveBeenCalled();
  });

  it("PUT rejects a pollingIntervalMs that is not a whole number of seconds", async () => {
    const r = await rest(server, "/api/admin/settings", { method: "PUT", body: { pollingIntervalMs: 15500 } });
    expect(r.status).toBe(400);
    expect(controller.update).not.toHaveBeenCalled();
  });

  it("PUT accepts null to reset a value to its default", async () => {
    // First override, then clear it with null.
    await rest(server, "/api/admin/settings", { method: "PUT", body: { maxAgentCycles: 9 } });
    const r = await rest(server, "/api/admin/settings", { method: "PUT", body: { maxAgentCycles: null } });
    expect(r.status).toBe(200);
    expect(controller.update).toHaveBeenLastCalledWith({ maxAgentCycles: null });
    expect(r.body).toEqual({ settings: { pollingIntervalMs: 30000, maxAgentCycles: 3, maxRetryAttempts: 5 } });
  });

  it("PUT rejects an empty payload", async () => {
    const r = await rest(server, "/api/admin/settings", { method: "PUT", body: {} });
    expect(r.status).toBe(400);
    expect(controller.update).not.toHaveBeenCalled();
  });

  it("returns 501 when no settings controller is wired", async () => {
    const bareServer = createAdminServer(makeDeps());
    await new Promise<void>((resolve) => bareServer.listen(0, "127.0.0.1", resolve));
    try {
      const r = await rest(bareServer, "/api/admin/settings");
      expect(r.status).toBe(501);
    } finally {
      await new Promise<void>((resolve, reject) => bareServer.close((err) => err ? reject(err) : resolve()));
    }
  });
});
