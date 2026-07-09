import { describe, it, expect, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import { createAdminServer, type AdminServerDependencies } from "../../src/admin/adminServer.js";
import type { RuntimePolicyStoreApi } from "../../src/state/stores/runtimePolicyStore.js";
import type { DenialStoreApi } from "../../src/state/stores/denialStore.js";
import type { RuntimeId } from "../../src/runtime/runtimeProfile.js";

interface Result { status: number; body: Record<string, unknown> | null }

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
  if (text) { try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* leave null */ } }
  return { status: r.status, body: parsed };
}

function baseStateStore(): AdminServerDependencies["stateStore"] {
  return {
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
  } as unknown as AdminServerDependencies["stateStore"];
}

function makeInMemoryPolicyStore(): RuntimePolicyStoreApi {
  const policies = new Map<string, { id: string; name: string; kind: string; yaml: string; description: string; createdAt: Date; updatedAt: Date }>();
  let seq = 0;
  return {
    createRuntimePolicy: vi.fn(async (input) => {
      const id = `pol-${++seq}`;
      const rec = { id, name: input.name, kind: input.kind, yaml: input.yaml ?? "", description: input.description ?? "", createdAt: new Date(), updatedAt: new Date() };
      policies.set(id, rec);
      return rec;
    }),
    getRuntimePolicyById: vi.fn(async (id: string) => policies.get(id) ?? null),
    listRuntimePolicies: vi.fn(async () => [...policies.values()]),
    updateRuntimePolicy: vi.fn(async (id: string, partial) => {
      const rec = policies.get(id);
      if (!rec) throw new Error("not found");
      Object.assign(rec, partial, { updatedAt: new Date() });
      return rec;
    }),
    deleteRuntimePolicy: vi.fn(async (id: string) => { policies.delete(id); }),
    bindRuntimePolicy: vi.fn(async (input) => {
      if ((input.projectId == null) === (input.agentId == null)) throw new Error("exactly one of projectId or agentId");
      return { id: "bind-1", policyId: input.policyId, projectId: input.projectId ?? null, agentId: input.agentId ?? null, createdAt: new Date(), updatedAt: new Date() };
    }),
    unbindRuntimePolicy: vi.fn(async () => {}),
    getRuntimePoliciesForProject: vi.fn(async () => []),
    getRuntimePoliciesForAgent: vi.fn(async () => []),
  } as unknown as RuntimePolicyStoreApi;
}

function makeDenialStore(events: unknown[]): DenialStoreApi {
  return {
    recordPolicyDenial: vi.fn(async () => { throw new Error("nimpl"); }),
    listPolicyDenials: vi.fn(async () => events),
  } as unknown as DenialStoreApi;
}

function makeDeps(over: Partial<AdminServerDependencies> = {}): AdminServerDependencies {
  return {
    stateStore: baseStateStore(),
    config: { nodeEnv: "test", logLevel: "error", maxAgentCycles: 3, maxRetryAttempts: 5, pollingIntervalMs: 30000 },
    polling: { isRunning: () => false, getIntervals: () => ({ intervalMs: 30000 }) },
    providers: [],
    ...over,
  } as AdminServerDependencies;
}

describe("Admin API — runtime/policy/denial routes", () => {
  let server: Server;

  async function start(over: Partial<AdminServerDependencies>): Promise<void> {
    server = createAdminServer(makeDeps(over));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  }

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("GET /api/admin/runtime returns default + available + supported", async () => {
    let current: RuntimeId = "docker";
    await start({
      runtime: {
        getDefaultRuntime: () => current,
        setDefaultRuntime: async (id) => { current = id; },
        listRuntimes: () => ["docker", "openshell"],
        gatewayHealthy: async () => true,
      },
    });
    const r = await rest(server, "/api/admin/runtime");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ defaultRuntime: "docker", available: ["docker", "openshell"], gatewayHealthy: true });
  });

  it("PUT /api/admin/runtime rejects an unknown runtime and accepts a registered one", async () => {
    let current: RuntimeId = "docker";
    await start({
      runtime: {
        getDefaultRuntime: () => current,
        setDefaultRuntime: async (id) => { current = id; },
        listRuntimes: () => ["docker", "openshell"],
        gatewayHealthy: async () => undefined,
      },
    });
    expect((await rest(server, "/api/admin/runtime", { method: "PUT", body: { defaultRuntime: "podman" } })).status).toBe(400);
    const ok = await rest(server, "/api/admin/runtime", { method: "PUT", body: { defaultRuntime: "openshell" } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ defaultRuntime: "openshell" });
  });

  it("policy CRUD: create, list, bind, delete", async () => {
    await start({ runtimePolicyStore: makeInMemoryPolicyStore() });
    const created = await rest(server, "/api/admin/runtime/policies", { method: "POST", body: { name: "review-ro", kind: "network", yaml: "network:\n  default: deny\n" } });
    expect(created.status).toBe(201);
    const id = (created.body?.["policy"] as { id: string }).id;

    const list = await rest(server, "/api/admin/runtime/policies");
    expect((list.body?.["policies"] as unknown[]).length).toBe(1);

    const bind = await rest(server, `/api/admin/runtime/policies/${id}/bindings`, { method: "POST", body: { agentId: "a1" } });
    expect(bind.status).toBe(201);

    const badBind = await rest(server, `/api/admin/runtime/policies/${id}/bindings`, { method: "POST", body: { projectId: "p", agentId: "a" } });
    expect(badBind.status).toBe(400);

    expect((await rest(server, `/api/admin/runtime/policies/${id}`, { method: "DELETE" })).status).toBe(204);
  });

  it("POST policy rejects an invalid kind", async () => {
    await start({ runtimePolicyStore: makeInMemoryPolicyStore() });
    const r = await rest(server, "/api/admin/runtime/policies", { method: "POST", body: { name: "x", kind: "bogus" } });
    expect(r.status).toBe(400);
  });

  it("GET denials returns the audit log", async () => {
    await start({ denialStore: makeDenialStore([{ id: 1, host: "api.github.com", decision: "deny" }]) });
    const r = await rest(server, "/api/admin/runtime/denials?limit=10");
    expect(r.status).toBe(200);
    expect((r.body?.["denials"] as unknown[]).length).toBe(1);
  });

  it("returns 501 when controllers are not wired", async () => {
    await start({});
    expect((await rest(server, "/api/admin/runtime")).status).toBe(501);
    expect((await rest(server, "/api/admin/runtime/policies")).status).toBe(501);
    expect((await rest(server, "/api/admin/runtime/denials")).status).toBe(501);
  });
});
