import { describe, it, expect, beforeEach, vi } from "vitest";
import { PluginManager } from "../../src/plugins/pluginManager.js";
import { registerBuiltinPlugins } from "../../src/plugins/init.js";
import { decryptToken, encryptToken } from "../../src/utils/encryption.js";
import type { AgentAdapter, AgentResult, IntegrationStore, Integration, ProviderId, DomainCapability, TaskContext } from "../../src/interfaces.js";

const PROVIDER_CAPABILITY: Record<ProviderId, DomainCapability> = {
  redmine: "issue_tracking",
  gerrit: "code_review",
  gitlab: "issue_tracking",
  github: "issue_tracking",
  mock: "agent_execution",
  copilot: "agent_execution",
  claude: "agent_execution",
  aider: "agent_execution",
};

/** Resolve the first active connector for a provider via its primary capability. */
function activeConnector<T>(mgr: PluginManager, provider: ProviderId): T | null {
  const integration = mgr.getActiveIntegrationsByProvider(provider)[0];
  if (!integration) return null;
  return mgr.getConnectorForCapability<T>(integration.id, PROVIDER_CAPABILITY[provider]);
}

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

function makeIntegration(overrides: Partial<Integration> & { id: string; provider: ProviderId }): Integration {
  return {
    name: overrides.provider,
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

  describe("credential migration", () => {
    it("identifies integrations whose stored config is invalid JSON", async () => {
      const store = makeStore([
        makeIntegration({
          id: "invalid-json",
          provider: "redmine",
          configJson: "{not-json",
        }),
      ]);
      const mgr = new PluginManager(store, { adminAuthSecret: "migration-test-secret" });

      await expect(mgr.migrateEncryptCredentials()).rejects.toThrow(/invalid-json/);
      expect(store.upsertIntegration).not.toHaveBeenCalled();
    });

    it("rejects startup credentials when ADMIN_AUTH_SECRET is missing", async () => {
      const store = makeStore([
        makeIntegration({
          id: "redmine-plain",
          provider: "redmine",
          configJson: JSON.stringify({ baseUrl: "https://redmine.example.com", apiKey: "raw-secret", virtualEngineerUserLogin: "ve" }),
        }),
      ]);
      const mgr = new PluginManager(store);

      await expect(mgr.migrateEncryptCredentials()).rejects.toThrow(/ADMIN_AUTH_SECRET.*redmine-plain/);
      expect(store.upsertIntegration).not.toHaveBeenCalled();
    });

    it("migrates legacy plain:-prefixed credentials to AES encryption", async () => {
      const secret = "migration-test-secret";
      const legacy = `plain:${Buffer.from("raw-secret", "utf8").toString("base64")}`;
      const store = makeStore([
        makeIntegration({
          id: "redmine-legacy",
          provider: "redmine",
          configJson: JSON.stringify({ baseUrl: "https://redmine.example.com", apiKey: legacy, virtualEngineerUserLogin: "ve" }),
        }),
      ]);
      const mgr = new PluginManager(store, { adminAuthSecret: secret });

      await mgr.migrateEncryptCredentials();

      expect(store.upsertIntegration).toHaveBeenCalledTimes(1);
      const updated = await store.getIntegration("redmine-legacy");
      const config = JSON.parse(updated?.configJson ?? "{}") as Record<string, unknown>;
      expect(config["apiKey"]).not.toBe(legacy);
      expect(config["apiKey"]).toMatch(/^veenc:v1:/);
      expect(decryptToken(String(config["apiKey"]), secret)).toBe("raw-secret");
    });

    it("rewrites valid unprefixed AES ciphertext into the versioned envelope", async () => {
      const secret = "migration-test-secret";
      const legacyCiphertext = encryptToken("raw-secret", secret).replace(/^veenc:v1:/, "");
      const store = makeStore([
        makeIntegration({
          id: "redmine-aes-legacy",
          provider: "redmine",
          configJson: JSON.stringify({ baseUrl: "https://redmine.example.com", apiKey: legacyCiphertext, virtualEngineerUserLogin: "ve" }),
        }),
      ]);
      const mgr = new PluginManager(store, { adminAuthSecret: secret });

      await mgr.migrateEncryptCredentials();

      const updated = await store.getIntegration("redmine-aes-legacy");
      const config = JSON.parse(updated?.configJson ?? "{}") as Record<string, unknown>;
      expect(config["apiKey"]).toMatch(/^veenc:v1:/);
      expect(decryptToken(String(config["apiKey"]), secret)).toBe("raw-secret");
    });

    it("fails closed for marked ciphertext encrypted with a different secret", async () => {
      const encrypted = encryptToken("raw-secret", "old-secret");
      const store = makeStore([
        makeIntegration({
          id: "redmine-marked-wrong-key",
          provider: "redmine",
          configJson: JSON.stringify({ baseUrl: "https://redmine.example.com", apiKey: encrypted, virtualEngineerUserLogin: "ve" }),
        }),
      ]);
      const mgr = new PluginManager(store, { adminAuthSecret: "new-secret" });

      await expect(mgr.migrateEncryptCredentials()).rejects.toThrow(/redmine-marked-wrong-key/);
      expect(store.upsertIntegration).not.toHaveBeenCalled();
    });

    it("fails closed for probable unprefixed AES ciphertext encrypted with a different secret", async () => {
      const legacyCiphertext = encryptToken("raw-secret", "old-secret").replace(/^veenc:v1:/, "");
      const store = makeStore([
        makeIntegration({
          id: "redmine-aes-wrong-key",
          provider: "redmine",
          configJson: JSON.stringify({ baseUrl: "https://redmine.example.com", apiKey: legacyCiphertext, virtualEngineerUserLogin: "ve" }),
        }),
      ]);
      const mgr = new PluginManager(store, { adminAuthSecret: "new-secret" });

      await expect(mgr.migrateEncryptCredentials()).rejects.toThrow(/redmine-aes-wrong-key/);
      expect(store.upsertIntegration).not.toHaveBeenCalled();
    });
  });

  describe("loadFromDatabase", () => {
    it("loads enabled integrations at startup", async () => {
      const store = makeStore([
        makeIntegration({
          id: "r1",
          provider: "redmine",
          name: "Redmine Prod",
          configJson: JSON.stringify({ baseUrl: "http://r:3000", apiKey: "k", virtualEngineerUserLogin: "ve" }),
          enabled: true,
        }),
        makeIntegration({
          id: "g1",
          provider: "gerrit",
          name: "Gerrit",
          configJson: "{}",
          enabled: false,
        }),
      ]);

      const mgr = new PluginManager(store);

      await mgr.loadFromDatabase();

      expect(activeConnector(mgr, "redmine")).toBeTruthy();
      expect(activeConnector(mgr, "gerrit")).toBeNull();
    });

    it("skips plugins with invalid config gracefully", async () => {
      const store = makeStore([
        makeIntegration({
          id: "bad",
          provider: "redmine",
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
          provider: "copilot",
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
          provider: "copilot",
        })
      );
    });

    it.each([
      ["a malformed managed envelope", "veenc:v1:not-valid-ciphertext"],
      ["undecryptable probable legacy ciphertext", encryptToken("stored-secret", "old-secret").replace(/^veenc:v1:/, "")],
    ])("fails closed when runtime config contains %s", (_label, credential) => {
      const integration = makeIntegration({
        id: "redmine-managed-invalid",
        provider: "redmine",
        configJson: JSON.stringify({ baseUrl: "https://redmine.example.com", apiKey: credential, virtualEngineerUserLogin: "ve" }),
      });
      const mgr = new PluginManager(makeStore([integration]), { adminAuthSecret: "current-secret" });

      expect(() => mgr.decryptIntegrationConfig(integration)).toThrow(/decrypt.*credential/i);
    });

    it("preserves raw plaintext credentials for unsaved connection tests", async () => {
      const mgr = new PluginManager(makeStore(), { adminAuthSecret: "current-secret" });
      const tester = vi.fn(async () => ({ success: true, error: null }));
      mgr.registerConnectionTester("redmine", tester);

      await mgr.testConnectionConfig("redmine", {
        baseUrl: "https://redmine.example.com",
        apiKey: "raw-admin-form-token",
        virtualEngineerUserLogin: "ve",
      });

      expect(tester).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "raw-admin-form-token" }));
    });
  });

  describe("enablePlugin", () => {
    it("validates config and creates instance", async () => {
      const store = makeStore([
        makeIntegration({
          id: "r1",
          provider: "copilot",
          configJson: JSON.stringify({ apiKey: "ghp-test-token" }),
          enabled: false,
        }),
      ]);

      const instance = makeMockPluginInstance("copilot-mock");
      const mgr = new PluginManager(store);
      mgr.registerFactory("copilot", vi.fn(() => instance));

      await mgr.enablePlugin("r1");

      expect(activeConnector(mgr, "copilot")).toBe(instance);
      expect(store.setIntegrationEnabled).toHaveBeenCalledWith("r1", true);
    });

    it("keeps both providers in the same category active (Phase 4 multi-instance)", async () => {
      const store = makeStore([
        makeIntegration({
          id: "m1",
          provider: "mock",
          name: "Mock Agent",
          configJson: JSON.stringify({ status: "success", simulateDelayMs: 0 }),
          enabled: true,
        }),
        makeIntegration({
          id: "c1",
          provider: "copilot",
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
      expect(activeConnector(mgr, "mock")).toBe(mockInstance);

      await mgr.enablePlugin("c1");

      // Phase 4: do not auto-disable other integrations in the same category.
      // The orchestrator picks the right one per-project via getConnectorForIntegration.
      expect(store.setIntegrationEnabled).not.toHaveBeenCalledWith("m1", false);
      expect(store.setIntegrationEnabled).toHaveBeenCalledWith("c1", true);
      expect(activeConnector(mgr, "mock")).toBe(mockInstance);
      expect(activeConnector(mgr, "copilot")).toBe(copilotInstance);
      await expect(store.getIntegration("m1")).resolves.toMatchObject({ enabled: true });
      await expect(store.getIntegration("c1")).resolves.toMatchObject({ enabled: true });
    });

    it("throws for unknown integration id", async () => {
      const store = makeStore();
      const mgr = new PluginManager(store);

      await expect(mgr.enablePlugin("nonexistent")).rejects.toThrow("Integration not found");
    });

    it("fails closed when hot-enabling malformed managed credentials", async () => {
      const store = makeStore([
        makeIntegration({
          id: "redmine-hot-malformed",
          provider: "redmine",
          configJson: JSON.stringify({
            baseUrl: "https://redmine.example.com",
            apiKey: "veenc:v1:not-valid-ciphertext",
            virtualEngineerUserLogin: "ve",
          }),
        }),
      ]);
      const mgr = new PluginManager(store, { adminAuthSecret: "current-secret" });

      await expect(mgr.enablePlugin("redmine-hot-malformed")).rejects.toThrow(/decrypt.*credential/i);
      expect(store.setIntegrationEnabled).not.toHaveBeenCalled();
    });

    it("skips connector creation for invalid config without throwing", async () => {
      const store = makeStore([
        makeIntegration({
          id: "bad",
          provider: "redmine",
          configJson: JSON.stringify({ baseUrl: "not-a-url" }),
          enabled: false,
        }),
      ]);

        const mgr = new PluginManager(store);

      await expect(mgr.enablePlugin("bad")).resolves.toBeUndefined();
      expect(activeConnector(mgr, "redmine")).toBeNull();
    });
  });

  describe("disablePlugin", () => {
    it("removes active instance and updates store", async () => {
      const store = makeStore([
        makeIntegration({
          id: "r1",
          provider: "redmine",
          configJson: JSON.stringify({ baseUrl: "http://r:3000", apiKey: "k", virtualEngineerUserLogin: "ve" }),
          enabled: true,
        }),
      ]);

        const mgr = new PluginManager(store);
        mgr.registerFactory("redmine", vi.fn(() => makeMockPluginInstance("r")));
      await mgr.loadFromDatabase();

      expect(activeConnector(mgr, "redmine")).toBeTruthy();

      await mgr.disablePlugin("r1");

      expect(activeConnector(mgr, "redmine")).toBeNull();
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
          provider: "redmine",
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
          provider: "redmine",
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
          provider: "mock",
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
          provider: "redmine",
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
          provider: "redmine",
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
          provider: "copilot",
          name: "Copilot Prod",
          configJson: JSON.stringify({ sessionToken: "k1" }),
          enabled: true,
        }),
      ]);

      const initialInstance = makeMockPluginInstance("copilot-old");
      const reloadedInstance = makeMockPluginInstance("copilot-new");
      const factory = vi
        .fn()
        .mockReturnValueOnce(initialInstance)
        .mockReturnValueOnce(reloadedInstance);

      const mgr = new PluginManager(store);
      mgr.registerFactory("copilot", factory);

      const callback = vi.fn();
      mgr.onPluginChange(callback);

      await mgr.loadFromDatabase();
      callback.mockClear();

      await store.upsertIntegration({
        id: "r1",
        provider: "copilot",
        name: "Copilot Prod",
        configJson: JSON.stringify({ sessionToken: "k2" }),
        enabled: true,
      });

      await (mgr as unknown as { reloadIntegration(id: string): Promise<void> }).reloadIntegration("r1");

      expect(factory).toHaveBeenCalledTimes(2);
      expect(factory).toHaveBeenLastCalledWith(
        {
          sessionToken: "k2",
        },
        expect.objectContaining({
          id: "r1",
          provider: "copilot",
        })
      );
      expect(activeConnector(mgr, "copilot")).toBe(reloadedInstance);
      expect(callback).toHaveBeenCalledWith();
    });
  });

  describe("getActiveIntegrationTypes", () => {
    it("returns currently active types", async () => {
      const store = makeStore([
        makeIntegration({
          id: "r1",
          provider: "redmine",
          configJson: JSON.stringify({ baseUrl: "http://r:3000", apiKey: "k", virtualEngineerUserLogin: "ve" }),
          enabled: true,
        }),
        makeIntegration({
          id: "m1",
          provider: "mock",
          configJson: "{}",
          enabled: true,
        }),
      ]);

        const mgr = new PluginManager(store);
        mgr.registerFactory("redmine", vi.fn(() => makeMockPluginInstance("r")));
        mgr.registerFactory("mock", vi.fn(() => makeMockPluginInstance("m")));
      await mgr.loadFromDatabase();

      const types = mgr.getActiveProviders();
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
          provider: "redmine",
          configJson: JSON.stringify({ baseUrl: "http://r:3000", apiKey: "k", virtualEngineerUserLogin: "ve" }),
          enabled: true,
        }),
      ]);

      const mgr = new PluginManager(store);
      // Intentionally no registerFactory("redmine", ...) call.

      await mgr.loadFromDatabase();

      // The descriptor's createInstance should have been used.
      expect(activeConnector(mgr, "redmine")).toBeTruthy();
    });

    it("uses descriptor.createInstance for mock when no factory is registered", async () => {
      const store = makeStore([
        makeIntegration({
          id: "m1",
          provider: "mock",
          configJson: JSON.stringify({ status: "success", simulateDelayMs: 0 }),
          enabled: true,
        }),
      ]);

      const mgr = new PluginManager(store);
      // Intentionally no registerFactory("mock", ...) call.

      await mgr.loadFromDatabase();

      expect(activeConnector(mgr, "mock")).toBeTruthy();
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
          provider: "copilot",
          configJson: "{}",
          enabled: true,
        }),
      ]);

      const mgr = new PluginManager(store);
      // copilot has no descriptor.createInstance; no registerFactory either.
      // loadFromDatabase should log the error and skip the integration gracefully.
      await expect(mgr.loadFromDatabase()).resolves.not.toThrow();
      expect(activeConnector(mgr, "copilot")).toBeNull();
    });
  });

  describe("per-integration capability + intake", () => {
    it("integrationSupportsCapability checks the active integration's descriptor", async () => {
      const store = makeStore([
        makeIntegration({
          id: "r1",
          provider: "redmine",
          configJson: JSON.stringify({ baseUrl: "http://r:3000", apiKey: "k" }),
          enabled: true,
        }),
      ]);
      const mgr = new PluginManager(store);
      await mgr.loadFromDatabase();

      expect(mgr.integrationSupportsCapability("r1", "issue_tracking")).toBe(true);
      expect(mgr.integrationSupportsCapability("r1", "code_review")).toBe(false);
      // Unknown / inactive integration id
      expect(mgr.integrationSupportsCapability("missing", "issue_tracking")).toBe(false);
    });

    it("getIntegrationCapabilityIntake returns the descriptor intake mechanisms", async () => {
      const store = makeStore([
        makeIntegration({
          id: "r1",
          provider: "redmine",
          configJson: JSON.stringify({ baseUrl: "http://r:3000", apiKey: "k" }),
          enabled: true,
        }),
      ]);
      const mgr = new PluginManager(store);
      await mgr.loadFromDatabase();

      expect(mgr.getIntegrationCapabilityIntake("r1", "issue_tracking")).toEqual(["polling", "webhook"]);
      expect(mgr.getIntegrationCapabilityIntake("r1", "code_review")).toEqual([]);
      expect(mgr.getIntegrationCapabilityIntake("missing", "issue_tracking")).toEqual([]);
    });
  });

  describe("descriptor-driven agent adapters", () => {
    it("builds an agent adapter from the descriptor buildAdapter hook using the runtime context (no registerFactory)", async () => {
      const store = makeStore([
        makeIntegration({
          id: "claude-1",
          provider: "claude",
          configJson: JSON.stringify({ authMode: "api_key", apiKey: "sk-ant-key" }),
          enabled: true,
        }),
      ]);
      const mgr = new PluginManager(store, {
        agentAdapterContext: { maxCommitsPerCycle: 7, dockerNetwork: "ve-net" },
      });
      await mgr.loadFromDatabase();

      const adapter = mgr.getConnectorForCapability<AgentAdapter>("claude-1", "agent_execution");
      expect(adapter).not.toBeNull();
      expect(adapter?.name).toBe("claude");
    });

    it("does not build an agent adapter when no runtime context is provided", async () => {
      const store = makeStore([
        makeIntegration({
          id: "claude-2",
          provider: "claude",
          configJson: JSON.stringify({ authMode: "api_key", apiKey: "sk-ant-key" }),
          enabled: true,
        }),
      ]);
      const mgr = new PluginManager(store);
      await mgr.loadFromDatabase();

      expect(mgr.getConnectorForCapability<AgentAdapter>("claude-2", "agent_execution")).toBeNull();
    });
  });

  describe("resolveConfigRuntimeExtras", () => {
    it("resolves a generated-key Gerrit integration to a temp-file key path", () => {
      const store = makeStore();
      const mgr = new PluginManager(store);
      const integration = makeIntegration({
        id: "gerrit-gen",
        provider: "gerrit",
        configJson: JSON.stringify({
          sshHost: "gerrit.test",
          sshUser: "ve",
          sshPort: 29418,
          sshPrivateKeyEnc: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n",
        }),
      });

      const extras = mgr.resolveConfigRuntimeExtras(integration);

      expect(typeof extras["_resolvedSshKeyPath"]).toBe("string");
      expect(extras["_resolvedSshKeyPath"]).toMatch(/ve-ssh-[^/]+\/key-[a-f0-9]{16}\.pem$/);
    });

    it("returns no key path for an agent-mode Gerrit integration (no private key)", () => {
      const store = makeStore();
      const mgr = new PluginManager(store);
      const integration = makeIntegration({
        id: "gerrit-agent",
        provider: "gerrit",
        configJson: JSON.stringify({ sshHost: "gerrit.test", sshUser: "ve", sshPort: 29418 }),
      });

      const extras = mgr.resolveConfigRuntimeExtras(integration);

      expect(extras["_resolvedSshKeyPath"]).toBeUndefined();
    });

    it("returns an empty object for providers without preprocessConfig", () => {
      const store = makeStore();
      const mgr = new PluginManager(store);
      const integration = makeIntegration({
        id: "redmine-1",
        provider: "redmine",
        configJson: JSON.stringify({ baseUrl: "http://r:3000", apiKey: "k", virtualEngineerUserLogin: "ve" }),
      });

      expect(mgr.resolveConfigRuntimeExtras(integration)).toEqual({});
    });
  });
});
