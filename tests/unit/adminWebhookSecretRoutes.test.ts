import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import { createAdminServer } from "../../src/admin/adminServer.js";
import type { AdminServerDependencies } from "../../src/admin/adminServer.js";
import { registerBuiltinPlugins } from "../../src/plugins/init.js";
import { PluginManager } from "../../src/plugins/pluginManager.js";
import type { Integration, IntegrationStore } from "../../src/interfaces.js";

const SECRET_MASK = "********";

function makeStore(initial: Integration[] = []): IntegrationStore {
  const data = new Map<string, Integration>();
  for (const i of initial) data.set(i.id, { ...i });
  return {
    getIntegrations: vi.fn(async () => [...data.values()]),
    getIntegration: vi.fn(async (id) => data.get(id) ?? null),
    upsertIntegration: vi.fn(async (i) => {
      const prev = data.get(i.id);
      const r: Integration = { ...i, createdAt: prev?.createdAt ?? new Date(), updatedAt: new Date() };
      data.set(i.id, r);
      return r;
    }),
    deleteIntegration: vi.fn(async (id) => { data.delete(id); }),
    countIntegrationReferences: vi.fn(async (_id) => 0),
    setIntegrationEnabled: vi.fn(async (id, enabled) => {
      const e = data.get(id)!;
      e.enabled = enabled;
      e.updatedAt = new Date();
      return e;
    }),
  };
}

function baseDeps(store: IntegrationStore, pm: PluginManager): AdminServerDependencies {
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
    integrationStore: store,
    pluginManager: pm,
  };
}

async function start(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error();
  return `http://127.0.0.1:${a.port}`;
}

async function call(url: string, opts: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = { method: opts.method ?? "GET" };
  if (opts.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, init);
  const body = await res.json() as Record<string, unknown>;
  return { status: res.status, body };
}

describe("Admin /api/admin/integrations/:id/webhook-secret/rotate + /webhook-info", () => {
  let server: Server;
  let url: string;
  let store: IntegrationStore;

  beforeEach(async () => {
    registerBuiltinPlugins();
    const integration: Integration = {
      id: "redmine-1",
      provider: "redmine",
      name: "Redmine 1",
      configJson: JSON.stringify({ baseUrl: "http://r/", apiKey: "k", virtualEngineerUserLogin: "ve" }),
      enabled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    store = makeStore([integration]);
    const pm = new PluginManager(store);
    server = createAdminServer(baseDeps(store, pm));
    url = await start(server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  });

  it("rotate returns a 64-hex secret and persists it", async () => {
    const r = await call(`${url}/api/admin/integrations/redmine-1/webhook-secret/rotate`, { method: "POST" });
    expect(r.status).toBe(200);
    const secret = r.body["secret"] as string;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);

    const stored = await store.getIntegration("redmine-1");
    expect(stored).not.toBeNull();
    const cfg = JSON.parse(stored!.configJson) as Record<string, unknown>;
    expect(cfg["webhookSecret"]).toBe(secret);
  });

  it("rotate returns 404 for unknown integration", async () => {
    const r = await call(`${url}/api/admin/integrations/missing/webhook-secret/rotate`, { method: "POST" });
    expect(r.status).toBe(404);
  });

  it("subsequent GET integration masks the webhookSecret", async () => {
    await call(`${url}/api/admin/integrations/redmine-1/webhook-secret/rotate`, { method: "POST" });
    const r = await call(`${url}/api/admin/integrations/redmine-1`);
    expect(r.status).toBe(200);
    const integration = r.body["integration"] as { config: Record<string, unknown> };
    expect(integration.config["webhookSecret"]).toBe(SECRET_MASK);
  });

  it("webhook-info reports secretConfigured=false before rotation", async () => {
    const r = await call(`${url}/api/admin/integrations/redmine-1/webhook-info`);
    expect(r.status).toBe(200);
    expect(r.body["secretConfigured"]).toBe(false);
    expect(Array.isArray(r.body["events"])).toBe(true);
    expect((r.body["events"] as string[]).length).toBeGreaterThan(0);
    expect(typeof r.body["url"]).toBe("string");
  });

  it("webhook-info reports secretConfigured=true after rotation", async () => {
    await call(`${url}/api/admin/integrations/redmine-1/webhook-secret/rotate`, { method: "POST" });
    const r = await call(`${url}/api/admin/integrations/redmine-1/webhook-info`);
    expect(r.status).toBe(200);
    expect(r.body["secretConfigured"]).toBe(true);
  });

  it("webhook-info url contains /webhooks/<integrationId>/<event>", async () => {
    const r = await call(`${url}/api/admin/integrations/redmine-1/webhook-info`);
    const u = r.body["url"] as string;
    expect(u).toContain("/webhooks/redmine-1/");
  });

  it("webhook-info returns 404 for unknown integration", async () => {
    const r = await call(`${url}/api/admin/integrations/missing/webhook-info`);
    expect(r.status).toBe(404);
  });
});

describe("Admin /api/admin/integrations/:id/webhook-allowed-ips (IP allowlisting)", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    registerBuiltinPlugins();
    const store = makeStore([
      {
        id: "gerrit-1",
        provider: "gerrit",
        name: "Staging Gerrit",
        configJson: JSON.stringify({}),
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const pm = new PluginManager(store);
    server = createAdminServer(baseDeps(store, pm));
    url = await start(server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("PUT /webhook-allowed-ips sets IP list", async () => {
    const r = await call(`${url}/api/admin/integrations/gerrit-1/webhook-allowed-ips`, {
      method: "PUT",
      body: { allowedIps: ["192.168.48.60", "10.0.0.1"] },
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ allowedIps: ["192.168.48.60", "10.0.0.1"] });
  });

  it("GET /webhook-allowed-ips returns IP list", async () => {
    await call(`${url}/api/admin/integrations/gerrit-1/webhook-allowed-ips`, {
      method: "PUT",
      body: { allowedIps: ["192.168.48.60"] },
    });
    const r = await call(`${url}/api/admin/integrations/gerrit-1/webhook-allowed-ips`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ allowedIps: ["192.168.48.60"] });
  });

  it("GET /webhook-allowed-ips returns empty array if not set", async () => {
    const r = await call(`${url}/api/admin/integrations/gerrit-1/webhook-allowed-ips`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ allowedIps: [] });
  });

  it("PUT /webhook-allowed-ips rejects non-array", async () => {
    const r = await call(`${url}/api/admin/integrations/gerrit-1/webhook-allowed-ips`, {
      method: "PUT",
      body: { allowedIps: "not-an-array" },
    });
    expect(r.status).toBe(400);
    expect((r.body as Record<string, unknown>)["error"]).toBe("allowedIps must be an array of IP strings");
  });

  it("PUT /webhook-allowed-ips rejects non-string array elements", async () => {
    const r = await call(`${url}/api/admin/integrations/gerrit-1/webhook-allowed-ips`, {
      method: "PUT",
      body: { allowedIps: ["192.168.48.60", 123] },
    });
    expect(r.status).toBe(400);
    expect((r.body as Record<string, unknown>)["error"]).toBe("Each allowed IP must be a string");
  });

  it("PUT /webhook-allowed-ips returns 404 for unknown integration", async () => {
    const r = await call(`${url}/api/admin/integrations/missing/webhook-allowed-ips`, {
      method: "PUT",
      body: { allowedIps: ["192.168.48.60"] },
    });
    expect(r.status).toBe(404);
  });
});
