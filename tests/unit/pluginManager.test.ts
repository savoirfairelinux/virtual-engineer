import { describe, it, expect, beforeEach, vi } from "vitest";
import { PluginManager } from "../../src/plugins/pluginManager.js";
import { registerBuiltinPlugins } from "../../src/plugins/init.js";
import type { AgentAdapter, AgentResult, IntegrationStore, Integration, IntegrationType, TaskContext } from "../../src/interfaces.js";

function makeStore(initial: Integration[] = []): IntegrationStore {
  const data = new Map<string, Integration>();
  for (const i of initial) data.set(i.id, { ...i });

  return {
    getIntegrations: vi.fn(async () => [...data.values()]),
    getIntegration: vi.fn(async (id: string) => data.get(id) ?? null),
    upsertIntegration: vi.fn(async (inp: Omit<Integration, "createdAt" | "updatedAt">) => {
      const now = new Date();
      const existing = data.get(inp.id);
      const result: Integration = {
        ...inp,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      data.set(inp.id, result);
      return result;
    }),
    deleteIntegration: vi.fn(async (id: string) => { data.delete(id); }),
    countIntegrationReferences: vi.fn(async (_id: string) => 0),
    setIntegrationEnabled: vi.fn(async (id: string, enabled: boolean) => {
      const existing = data.get(id);
      if (!existing) throw new Error(`Integration not found: ${id}`);
      existing.enabled = enabled;
      existing.updatedAt = new Date();
      return existing;
    }),
  };
}

function makeIntegration(overrides: Partial<Integration> & { id: string; type: IntegrationType }): Integration {
  return {
    name: overrides.type,
    configJson: "{}",
    enabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeMockPluginInstance(name: string): AgentAdapter {
  return {
    name,
    buildContainerSpec: vi.fn(() => ({
      image: "virtual-engineer-workspace:latest",
      env: {},
      command: ["node", "/agent-worker/dist/index.js"],
    })),
    execute: vi.fn(async (_context: TaskContext): Promise<AgentResult> => ({
      status: "success",
      modifiedFiles: [],
      summary: `${name} executed`,
      agentLogs: "",
      metadata: {},
    })),
  };
}

describe("PluginManager", () => {
  beforeEach(() => {
    registerBuiltinPlugins();
  });

  describe("loadFromDatabase", () => {
    it("loads enabled integrations at startup", async () => {
      const store = makeStore([
        makeIntegration({
          id: "r1",
          type: "redmine",
          name: "Redmine Prod",
          configJson: JSON.stringify({ baseUrl: "http://r:3000", apiKey: "k", virtualEngineerUserLogin: "ve" }),
          enabled: true,
        }),
        makeIntegration({
          id: "g1",
          type: "gerrit",
          name: "Gerrit",
          configJson: "{}",
          enabled: false,
        }),
      ]);

      const mgr = new PluginManager(store);
      const factory = vi.fn(() => makeMockPluginInstance("redmine-instance"));
      mgr.registerFactory("redmine", factory);
      mgr.registerFactory("gerrit", vi.fn(() => makeMockPluginInstance("gerrit-instance")));

      await mgr.loadFromDatabase();

      expect(factory).toHaveBeenCalledTimes(1);
      expect(mgr.getActiveConnector("redmine")).toBeTruthy();
      expect(mgr.getActiveConnector("gerrit")).toBeNull();
    });

    it("skips plugins with invalid config gracefully", async () => {
      const store = makeStore([
        makeIntegration({
          id: "bad",
          type: "redmine",
          configJson: JSON.stringify({ baseUrl: "not-a-url" }), // missing apiKey
          enabled: true,
        }),
      ]);

        const mgr = new PluginManager(store);
        mgr.registerFactory("redmine", vi.fn(() => makeMockPluginInstance("invalid-redmine")));

      // Should not throw
      await mgr.loadFromDatabase();
      // Redmine should still be null due to invalid config
    });

    it("passes copilot sessionToken through to the plugin factory", async () => {
      const store = makeStore([
        makeIntegration({
          id: "copilot-legacy",
          type: "copilot",
          configJson: JSON.stringify({
            sessionToken: "encrypted_tok",
          }),
          enabled: true,
        }),
      ]);

      const mgr = new PluginManager(store);
      const factory = vi.fn(() => makeMockPluginInstance("copilot-instance"));
      mgr.registerFactory("copilot", factory);

      await mgr.loadFromDatabase();

      expect(factory).toHaveBeenCalledWith(
        {
          sessionToken: "encrypted_tok",
        },
        expect.objectContaining({
          id: "copilot-legacy",
          type: "copilot",
        })
      );
    });
  });

  describe("enablePlugin", () => {
    it("validates config and creates instance", async () => {
      const store = makeStore([
        makeIntegration({
          id: "r1",
          type: "redmine",
          configJson: JSON.stringify({ baseUrl: "http://r:3000", apiKey: "k", virtualEngineerUserLogin: "ve" }),
          enabled: false,
        }),
      ]);

      const instance = makeMockPluginInstance("redmine-mock");
      const mgr = new PluginManager(store);
      mgr.registerFactory("redmine", vi.fn(() => instance));

      await mgr.enablePlugin("r1");

      expect(mgr.getActiveConnector("redmine")).toBe(instance);
      expect(store.setIntegrationEnabled).toHaveBeenCalledWith("r1", true);
    });

    it("keeps both providers in the same category active (Phase 4 multi-instance)", async () => {
      const store = makeStore([
        makeIntegration({
          id: "m1",
          type: "mock",
          name: "Mock Agent",
          configJson: JSON.stringify({ status: "success", simulateDelayMs: 0 }),
          enabled: true,
        }),
        makeIntegration({
          id: "c1",
          type: "copilot",
          name: "Copilot Agent",
          configJson: JSON.stringify({ apiKey: "ghp-test-token" }),
          enabled: false,
        }),
      ]);

      const mockInstance = makeMockPluginInstance("mock-agent");
      const copilotInstance = makeMockPluginInstance("copilot-agent");
      const mgr = new PluginManager(store);
      mgr.registerFactory("mock", vi.fn(() => mockInstance));
      mgr.registerFactory("copilot", vi.fn(() => copilotInstance));

      await mgr.loadFromDatabase();
      expect(mgr.getActiveConnector("mock")).toBe(mockInstance);

      await mgr.enablePlugin("c1");

      // Phase 4: do not auto-disable other integrations in the same category.
      // The orchestrator picks the right one per-project via getConnectorForIntegration.
      expect(store.setIntegrationEnabled).not.toHaveBeenCalledWith("m1", false);
      expect(store.setIntegrationEnabled).toHaveBeenCalledWith("c1", true);
      expect(mgr.getActiveConnector("mock")).toBe(mockInstance);
      expect(mgr.getActiveConnector("copilot")).toBe(copilotInstance);
      await expect(store.getIntegration("m1")).resolves.toMatchObject({ enabled: true });
      await expect(store.getIntegration("c1")).resolves.toMatchObject({ enabled: true });
    });

    it("throws for unknown integration id", async () => {
      const store = makeStore();
      const mgr = new PluginManager(store);

      await expect(mgr.enablePlugin("nonexistent")).rejects.toThrow("Integration not found");
    });

    it("throws for invalid config", async () => {
      const store = makeStore([
        makeIntegration({
          id: "bad",
          type: "redmine",
          configJson: JSON.stringify({ baseUrl: "not-a-url" }),
          enabled: false,
        }),
      ]);

        const mgr = new PluginManager(store);
        mgr.registerFactory("redmine", vi.fn(() => makeMockPluginInstance("bad-redmine")));

      await expect(mgr.enablePlugin("bad")).rejects.toThrow("Invalid config");
    });
  });

  describe("disablePlugin", () => {
    it("removes active instance and updates store", async () => {
      const store = makeStore([
        makeIntegration({
          id: "r1",
          type: "redmine",
          configJson: JSON.stringify({ baseUrl: "http://r:3000", apiKey: "k", virtualEngineerUserLogin: "ve" }),
          enabled: true,
        }),
      ]);

        const mgr = new PluginManager(store);
        mgr.registerFactory("redmine", vi.fn(() => makeMockPluginInstance("r")));
      await mgr.loadFromDatabase();

      expect(mgr.getActiveConnector("redmine")).toBeTruthy();

      await mgr.disablePlugin("r1");

      expect(mgr.getActiveConnector("redmine")).toBeNull();
      expect(store.setIntegrationEnabled).toHaveBeenCalledWith("r1", false);
    });

    it("throws for unknown id", async () => {
      const store = makeStore();
      const mgr = new PluginManager(store);

      await expect(mgr.disablePlugin("x")).rejects.toThrow("Integration not found");
    });
  });

  describe("testConnection", () => {
    it("returns structured success when tester passes", async () => {
      const store = makeStore([
        makeIntegration({
          id: "r1",
          type: "redmine",
          configJson: JSON.stringify({ baseUrl: "http://r:3000", apiKey: "k", virtualEngineerUserLogin: "ve" }),
          enabled: false,
        }),
      ]);

      const mgr = new PluginManager(store);
      mgr.registerConnectionTester("redmine", vi.fn(async () => ({ success: true, error: null })));

      const result = await mgr.testConnection("r1");
      expect(result).toMatchObject({ success: true, error: null });
    });

    it("returns tester failures with error details", async () => {
      const store = makeStore([
        makeIntegration({
          id: "r1",
          type: "redmine",
          configJson: JSON.stringify({ baseUrl: "http://r:3000", apiKey: "bad", virtualEngineerUserLogin: "ve" }),
          enabled: false,
        }),
      ]);

      const mgr = new PluginManager(store);
      mgr.registerConnectionTester("redmine", vi.fn(async () => ({ success: false, error: "Invalid API key" })));

      const result = await mgr.testConnection("r1");
      expect(result).toMatchObject({ success: false, error: "Invalid API key" });
    });

    it("validates config schema when no tester is registered", async () => {
      const store = makeStore([
        makeIntegration({
          id: "m1",
          type: "mock",
          configJson: "{}",
          enabled: false,
        }),
      ]);

      const mgr = new PluginManager(store);
      const result = await mgr.testConnection("m1");
      expect(result).toMatchObject({ success: true, error: null });
    });

    it("tests raw config and preserves structured tester details", async () => {
      const store = makeStore();
      const mgr = new PluginManager(store);
      const tester = vi.fn(async () => ({
        success: true,
        error: null,
        models: [{ id: "gpt-4.1", name: "GPT-4.1" }],
      }));
      mgr.registerConnectionTester("copilot", tester);

      const result = await mgr.testConnectionConfig("copilot", { sessionToken: "enc_tok" });

      expect(tester).toHaveBeenCalledWith({ authMode: "oauth", sessionToken: "enc_tok" });
      expect(result).toMatchObject({
        success: true,
        error: null,
        models: [{ id: "gpt-4.1", name: "GPT-4.1" }],
      });
    });

    it("passes sessionToken through when testing the copilot connection", async () => {
      const store = makeStore();
      const mgr = new PluginManager(store);
      const tester = vi.fn(async () => ({
        success: true,
        error: null,
        models: [{ id: "gpt-4.1", name: "GPT-4.1" }],
      }));
      mgr.registerConnectionTester("copilot", tester);

      await mgr.testConnectionConfig("copilot", {
        sessionToken: "enc_tok",
      });

      expect(tester).toHaveBeenCalledWith({
        authMode: "oauth",
        sessionToken: "enc_tok",
      });
    });

    it("throws for unknown id", async () => {
      const store = makeStore();
      const mgr = new PluginManager(store);

      await expect(mgr.testConnection("x")).rejects.toThrow("Integration not found");
    });
  });

  describe("onPluginChange", () => {
    it("notifies callbacks on enable", async () => {
      const store = makeStore([
        makeIntegration({
          id: "r1",
          type: "redmine",
          configJson: JSON.stringify({ baseUrl: "http://r:3000", apiKey: "k", virtualEngineerUserLogin: "ve" }),
          enabled: false,
        }),
      ]);

        const mgr = new PluginManager(store);
        const instance = makeMockPluginInstance("r");
      mgr.registerFactory("redmine", vi.fn(() => instance));

      const callback = vi.fn();
      mgr.onPluginChange(callback);

      await mgr.enablePlugin("r1");

      expect(callback).toHaveBeenCalledWith();
    });

    it("notifies callbacks with null on disable", async () => {
      const store = makeStore([
        makeIntegration({
          id: "r1",
          type: "redmine",
          configJson: JSON.stringify({ baseUrl: "http://r:3000", apiKey: "k", virtualEngineerUserLogin: "ve" }),
          enabled: true,
        }),
      ]);

        const mgr = new PluginManager(store);
        mgr.registerFactory("redmine", vi.fn(() => makeMockPluginInstance("r")));
      await mgr.loadFromDatabase();

      const callback = vi.fn();
      mgr.onPluginChange(callback);

      await mgr.disablePlugin("r1");

      expect(callback).toHaveBeenCalledWith();
    });
  });

  describe("reloadIntegration", () => {
    it("recreates an active integration from updated config and notifies listeners", async () => {
      const store = makeStore([
        makeIntegration({
          id: "r1",
          type: "redmine",
          name: "Redmine Prod",
          configJson: JSON.stringify({ baseUrl: "http://r:3000", apiKey: "k1", virtualEngineerUserLogin: "ve" }),
          enabled: true,
        }),
      ]);

      const initialInstance = makeMockPluginInstance("redmine-old");
      const reloadedInstance = makeMockPluginInstance("redmine-new");
      const factory = vi
        .fn()
        .mockReturnValueOnce(initialInstance)
        .mockReturnValueOnce(reloadedInstance);

      const mgr = new PluginManager(store);
      mgr.registerFactory("redmine", factory);

      const callback = vi.fn();
      mgr.onPluginChange(callback);

      await mgr.loadFromDatabase();
      callback.mockClear();

      await store.upsertIntegration({
        id: "r1",
        type: "redmine",
        name: "Redmine Prod",
        configJson: JSON.stringify({ baseUrl: "http://r2:3000", apiKey: "k2", virtualEngineerUserLogin: "ve" }),
        enabled: true,
      });

      await (mgr as unknown as { reloadIntegration(id: string): Promise<void> }).reloadIntegration("r1");

      expect(factory).toHaveBeenCalledTimes(2);
      expect(factory).toHaveBeenLastCalledWith(
        {
          baseUrl: "http://r2:3000",
          apiKey: "k2",
          virtualEngineerUserLogin: "ve",
        },
        expect.objectContaining({
          id: "r1",
          type: "redmine",
        })
      );
      expect(mgr.getActiveConnector("redmine")).toBe(reloadedInstance);
      expect(callback).toHaveBeenCalledWith();
    });
  });

  describe("getActiveIntegrationTypes", () => {
    it("returns currently active types", async () => {
      const store = makeStore([
        makeIntegration({
          id: "r1",
          type: "redmine",
          configJson: JSON.stringify({ baseUrl: "http://r:3000", apiKey: "k", virtualEngineerUserLogin: "ve" }),
          enabled: true,
        }),
        makeIntegration({
          id: "m1",
          type: "mock",
          configJson: "{}",
          enabled: true,
        }),
      ]);

        const mgr = new PluginManager(store);
        mgr.registerFactory("redmine", vi.fn(() => makeMockPluginInstance("r")));
        mgr.registerFactory("mock", vi.fn(() => makeMockPluginInstance("m")));
      await mgr.loadFromDatabase();

      const types = mgr.getActiveIntegrationTypes();
      expect(types).toContain("redmine");
      expect(types).toContain("mock");
    });
  });

  describe("descriptor fallback hooks", () => {
    it("uses descriptor.createInstance when no factory is registered (redmine)", async () => {
      // This exercises the path introduced by the refactor: PluginManager falls
      // back to descriptor.createInstance when registerFactory was not called for
      // the integration type.
      const store = makeStore([
        makeIntegration({
          id: "r1",
          type: "redmine",
          configJson: JSON.stringify({ baseUrl: "http://r:3000", apiKey: "k", virtualEngineerUserLogin: "ve" }),
          enabled: true,
        }),
      ]);

      const mgr = new PluginManager(store);
      // Intentionally no registerFactory("redmine", ...) call.

      await mgr.loadFromDatabase();

      // The descriptor's createInstance should have been used.
      expect(mgr.getActiveConnector("redmine")).toBeTruthy();
    });

    it("uses descriptor.createInstance for mock when no factory is registered", async () => {
      const store = makeStore([
        makeIntegration({
          id: "m1",
          type: "mock",
          configJson: JSON.stringify({ status: "success", simulateDelayMs: 0 }),
          enabled: true,
        }),
      ]);

      const mgr = new PluginManager(store);
      // Intentionally no registerFactory("mock", ...) call.

      await mgr.loadFromDatabase();

      expect(mgr.getActiveConnector("mock")).toBeTruthy();
    });

    it("uses descriptor.testConnection when no tester is registered (redmine)", async () => {
      // This exercises the testConnection fallback path: PluginManager delegates to
      // descriptor.testConnection when registerConnectionTester was not called.
      const store = makeStore();
      const mgr = new PluginManager(store);
      // Intentionally no registerConnectionTester("redmine", ...) call.

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ user: { id: 1, login: "admin" } }),
        text: vi.fn().mockResolvedValue(""),
      } as unknown as Response);

      const result = await mgr.testConnectionConfig("redmine", {
        baseUrl: "http://r:3000",
        apiKey: "k",
        virtualEngineerUserLogin: "admin",
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        "http://r:3000/users/current.json",
        expect.objectContaining({ headers: expect.objectContaining({ "X-Redmine-API-Key": "k" }) })
      );
      expect(result).toMatchObject({ success: true, error: null });

      fetchSpy.mockRestore();
    });

    it("descriptor.testConnection failure propagates correctly (redmine)", async () => {
      const store = makeStore();
      const mgr = new PluginManager(store);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: vi.fn().mockResolvedValue("Unauthorized"),
      } as unknown as Response);

      const result = await mgr.testConnectionConfig("redmine", {
        baseUrl: "http://r:3000",
        apiKey: "bad-key",
        virtualEngineerUserLogin: "ve",
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Redmine authentication failed/);

      fetchSpy.mockRestore();
    });

    it("throws when no factory and no descriptor.createInstance exist", async () => {
      const store = makeStore([
        makeIntegration({
          id: "c1",
          type: "copilot",
          configJson: "{}",
          enabled: true,
        }),
      ]);

      const mgr = new PluginManager(store);
      // copilot has no descriptor.createInstance; no registerFactory either.
      // loadFromDatabase should log the error and skip the integration gracefully.
      await expect(mgr.loadFromDatabase()).resolves.not.toThrow();
      expect(mgr.getActiveConnector("copilot")).toBeNull();
    });
  });
});
