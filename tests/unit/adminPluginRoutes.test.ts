import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createAdminServer } from "../../src/admin/adminServer.js";
import type { AdminServerDependencies } from "../../src/admin/adminServer.js";
import type { Server } from "node:http";
import type { AgentAdapter, AgentResult, IntegrationStore, Integration, TaskContext } from "../../src/interfaces.js";
import { registerBuiltinPlugins } from "../../src/plugins/init.js";
import { PluginManager } from "../../src/plugins/pluginManager.js";

const SECRET_MASK = "********";

function makeIntegrationStore(initial: Integration[] = []): IntegrationStore {
  const data = new Map<string, Integration>();
  for (const i of initial) data.set(i.id, { ...i });

  return {
    getIntegrations: vi.fn(async () => [...data.values()]),
    getIntegration: vi.fn(async (id: string) => data.get(id) ?? null),
    upsertIntegration: vi.fn(async (inp: Omit<Integration, "createdAt" | "updatedAt">) => {
      const now = new Date();
      const existing = data.get(inp.id);
      const result: Integration = { ...inp, createdAt: existing?.createdAt ?? now, updatedAt: now };
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

function makeBaseDeps(overrides: Partial<AdminServerDependencies> = {}): AdminServerDependencies {
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
    polling: {
      isRunning: () => false,
      getIntervals: () => ({ intervalMs: 30000 }),
    },
    providers: [],
    ...overrides,
  };
}

async function fetchFromServer(server: Server, path: string, options: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Server not bound");
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const requestInit: RequestInit = {
    method: options.method ?? "GET",
  };
  if (options.body) {
    requestInit.headers = { "content-type": "application/json" };
    requestInit.body = JSON.stringify(options.body);
  }
  const res = await fetch(url, requestInit);
  const body = await res.json() as Record<string, unknown>;
  return { status: res.status, body };
}

function makeMockAgentInstance(name: string): AgentAdapter {
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

describe("Admin API — Plugin & Integration routes", () => {
  let server: Server;
  let integrationStore: IntegrationStore;
  let pluginManager: PluginManager;

  beforeEach(async () => {
    registerBuiltinPlugins();
    integrationStore = makeIntegrationStore();
    pluginManager = new PluginManager(integrationStore);
    pluginManager.registerFactory("redmine", vi.fn(() => makeMockAgentInstance("redmine-mock")));
    pluginManager.registerFactory("gerrit", vi.fn(() => makeMockAgentInstance("gerrit-mock")));
    pluginManager.registerFactory("copilot", vi.fn(() => makeMockAgentInstance("copilot-mock")));
    pluginManager.registerFactory("mock", vi.fn(() => makeMockAgentInstance("mock-mock")));

    const deps = makeBaseDeps({ integrationStore, pluginManager });
    server = createAdminServer(deps);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  });

  describe("GET /api/admin/plugins", () => {
    it("returns all registered plugin types", async () => {
      const { status, body } = await fetchFromServer(server, "/api/admin/plugins");
      expect(status).toBe(200);
      const plugins = body["plugins"] as Array<{ provider: string }>;
      expect(plugins.length).toBeGreaterThanOrEqual(6);
      const providers = plugins.map((p) => p.provider);
      expect(providers).toContain("redmine");
      expect(providers).toContain("gerrit");
      expect(providers).toContain("gitlab");
      expect(providers).toContain("github");
      expect(providers).toContain("copilot");
      expect(providers).toContain("mock");
    });

    it("serializes provider icon metadata (null for unbranded providers)", async () => {
      const { status, body } = await fetchFromServer(server, "/api/admin/plugins");
      expect(status).toBe(200);
      const plugins = body["plugins"] as Array<Record<string, unknown>>;
      const github = plugins.find((p) => p["provider"] === "github");
      const mock = plugins.find((p) => p["provider"] === "mock");
      expect(github?.["icon"]).toEqual({ slug: "github", hex: "181717" });
      expect(mock).toHaveProperty("icon", null);
    });

    it("exposes OAuth metadata for providers that support dashboard auth flows", async () => {
      const { status, body } = await fetchFromServer(server, "/api/admin/plugins");
      expect(status).toBe(200);

      const plugins = body["plugins"] as Array<Record<string, unknown>>;
      const copilot = plugins.find((plugin) => plugin["provider"] === "copilot");
      const redmine = plugins.find((plugin) => plugin["provider"] === "redmine");

      expect(copilot).toMatchObject({
        provider: "copilot",
        capabilities: expect.arrayContaining(["agent_execution", "oauth"]),
        oauth: {
          mode: "device",
          tokenField: "sessionToken",
          providerName: "GitHub",
          startPath: "/api/admin/plugins/copilot/oauth/device-code",
          completePath: "/api/admin/plugins/copilot/oauth/token",
        },
      });
      const gitlab = plugins.find((plugin) => plugin["provider"] === "gitlab");
      expect(gitlab).toMatchObject({
        provider: "gitlab",
        capabilities: expect.arrayContaining(["code_review", "source_control", "discovery"]),
      });
      expect(redmine?.["oauth"]).toBeUndefined();
    });

    it("exposes provider-owned agent configuration fields", async () => {
      const { status, body } = await fetchFromServer(server, "/api/admin/plugins");
      expect(status).toBe(200);
      const plugins = body["plugins"] as Array<Record<string, unknown>>;
      const claude = plugins.find((plugin) => plugin["provider"] === "claude");
      const redmine = plugins.find((plugin) => plugin["provider"] === "redmine");

      expect(claude?.["agentConfigFields"]).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "effort", type: "select" }),
        expect.objectContaining({ key: "maxTurns", type: "number", valueType: "number" }),
      ]));
      expect(redmine?.["agentConfigFields"]).toEqual([]);
    });
  });

  describe("POST /api/admin/integrations", () => {
    it("creates a new integration", async () => {
      const { status, body } = await fetchFromServer(server, "/api/admin/integrations", {
        method: "POST",
        body: {
          provider: "redmine",
          name: "My Redmine",
          config: { baseUrl: "http://redmine:3000", apiKey: "key1", virtualEngineerUserLogin: "ve" },
        },
      });
      expect(status).toBe(201);
      const integration = body["integration"] as Record<string, unknown>;
      expect(integration["provider"]).toBe("redmine");
      expect(integration["name"]).toBe("My Redmine");
      expect(integration["enabled"]).toBe(true);
    });

    it("rejects unknown config fields instead of storing them", async () => {
      const { status } = await fetchFromServer(server, "/api/admin/integrations", {
        method: "POST",
        body: {
          provider: "redmine",
          name: "My Redmine",
          config: {
            baseUrl: "http://redmine:3000",
            apiKey: "key1",
            virtualEngineerUserLogin: "ve",
            unexpectedSecret: "should-not-store",
          },
        },
      });

      expect(status).toBe(400);
    });

    it("rejects request without type", async () => {
      const { status } = await fetchFromServer(server, "/api/admin/integrations", {
        method: "POST",
        body: { name: "Missing type" },
      });
      expect(status).toBe(400);
    });

    it("accepts copilot integration with no sessionToken (optional)", async () => {
      const { status, body } = await fetchFromServer(server, "/api/admin/integrations", {
        method: "POST",
        body: {
          provider: "copilot",
          name: "Copilot No Token",
          config: {},
        },
      });

      expect(status).toBe(201);
      expect(body["integration"]).toBeDefined();
    });
  });

  describe("GET /api/admin/integrations", () => {
    it("lists all integrations", async () => {
      await fetchFromServer(server, "/api/admin/integrations", {
        method: "POST",
        body: { provider: "redmine", name: "R1", config: {} },
      });
      await fetchFromServer(server, "/api/admin/integrations", {
        method: "POST",
        body: { provider: "gerrit", name: "G1", config: {} },
      });

      const { status, body } = await fetchFromServer(server, "/api/admin/integrations");
      expect(status).toBe(200);
      const list = body["integrations"] as Array<Record<string, unknown>>;
      expect(list).toHaveLength(2);
    });

    it("returns category-aware integrations with masked secret fields", async () => {
      await integrationStore.upsertIntegration({
        id: "redmine-prod",
        provider: "redmine",
        name: "Redmine Prod",
        configJson: JSON.stringify({
          baseUrl: "http://redmine:3000",
          apiKey: "redmine-secret",
          virtualEngineerUserLogin: "ve",
        }),
        enabled: true,
      });

      const { status, body } = await fetchFromServer(server, "/api/admin/integrations");
      expect(status).toBe(200);

      const list = body["integrations"] as Array<Record<string, unknown>>;
      const integration = list.find((entry) => entry["id"] === "redmine-prod");

      expect(integration).toMatchObject({
        id: "redmine-prod",
        provider: "redmine",
        domainCapabilities: expect.arrayContaining(["issue_tracking"]),
        capabilities: expect.arrayContaining(["issue_tracking", "discovery"]),
        config: {
          baseUrl: "http://redmine:3000",
          apiKey: SECRET_MASK,
          virtualEngineerUserLogin: "ve",
        },
      });
    });

    it("includes descriptor capabilities on persisted integrations for capability-driven UI selectors", async () => {
      await integrationStore.upsertIntegration({
        id: "gitlab-review",
        provider: "gitlab",
        name: "GitLab Review",
        configJson: JSON.stringify({
          baseUrl: "https://gitlab.example.com",
          projectId: "group/project",
          authMode: "pat",
          token: "glpat-secret",
        }),
        enabled: true,
      });

      const { status, body } = await fetchFromServer(server, "/api/admin/integrations");
      expect(status).toBe(200);

      const list = body["integrations"] as Array<Record<string, unknown>>;
      const integration = list.find((entry) => entry["id"] === "gitlab-review");

      expect(integration).toMatchObject({
        id: "gitlab-review",
        capabilities: expect.arrayContaining(["code_review", "source_control", "discovery", "oauth"]),
      });
    });
  });

  describe("PATCH /api/admin/integrations/:id/enable", () => {
    it("enables a plugin", async () => {
      const { body: createBody } = await fetchFromServer(server, "/api/admin/integrations", {
        method: "POST",
        body: {
          provider: "mock",
          name: "Mock Dev",
          config: {},
        },
      });
      const id = (createBody["integration"] as Record<string, unknown>)["id"] as string;

      const { status, body } = await fetchFromServer(server, `/api/admin/integrations/${id}/enable`, {
        method: "PATCH",
      });
      expect(status).toBe(200);
      const integration = body["integration"] as Record<string, unknown>;
      expect(integration["enabled"]).toBe(true);
    });

    it("keeps both providers in the same category active (Phase 4 multi-instance)", async () => {
      const { body: mockBody } = await fetchFromServer(server, "/api/admin/integrations", {
        method: "POST",
        body: {
          provider: "mock",
          name: "Mock Agent",
          config: { status: "success", simulateDelayMs: 0 },
        },
      });
      const mockId = (mockBody["integration"] as Record<string, unknown>)["id"] as string;

      const { body: copilotBody } = await fetchFromServer(server, "/api/admin/integrations", {
        method: "POST",
        body: {
          provider: "copilot",
          name: "Copilot Agent",
          config: { sessionToken: "enc_tok" },
        },
      });
      const copilotId = (copilotBody["integration"] as Record<string, unknown>)["id"] as string;

      await fetchFromServer(server, `/api/admin/integrations/${mockId}/enable`, {
        method: "PATCH",
      });

      const { status } = await fetchFromServer(server, `/api/admin/integrations/${copilotId}/enable`, {
        method: "PATCH",
      });

      expect(status).toBe(200);
      // Phase 4: enabling a second integration in the same category no longer auto-disables
      // the first — multiple integrations of the same category may be enabled simultaneously
      // and the orchestrator routes by project via getConnectorForIntegration(id).
      await expect(integrationStore.getIntegration(mockId)).resolves.toMatchObject({ enabled: true });
      await expect(integrationStore.getIntegration(copilotId)).resolves.toMatchObject({ enabled: true });
    });
  });

  describe("PATCH /api/admin/integrations/:id/disable", () => {
    it("disables a plugin", async () => {
      const { body: createBody } = await fetchFromServer(server, "/api/admin/integrations", {
        method: "POST",
        body: { provider: "mock", name: "Mock Dev", config: {} },
      });
      const id = (createBody["integration"] as Record<string, unknown>)["id"] as string;

      await fetchFromServer(server, `/api/admin/integrations/${id}/enable`, { method: "PATCH" });
      const { status, body } = await fetchFromServer(server, `/api/admin/integrations/${id}/disable`, {
        method: "PATCH",
      });
      expect(status).toBe(200);
      const integration = body["integration"] as Record<string, unknown>;
      expect(integration["enabled"]).toBe(false);
    });
  });

  describe("POST /api/admin/integrations/:id/test", () => {
    it("returns structured test details for a persisted Copilot integration", async () => {
      pluginManager.registerConnectionTester("copilot", vi.fn(async () => ({
        success: true,
        error: null,
        models: [
          { id: "gpt-4o", name: "GPT-4o" },
          { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
        ],
      })));

      const { body: createBody } = await fetchFromServer(server, "/api/admin/integrations", {
        method: "POST",
        body: { provider: "copilot", name: "Copilot Test", config: { sessionToken: "enc_test" } },
      });
      const id = (createBody["integration"] as Record<string, unknown>)["id"] as string;

      const { status, body } = await fetchFromServer(server, `/api/admin/integrations/${id}/test`, {
        method: "POST",
      });
      expect(status).toBe(200);
      expect(body["success"]).toBe(true);
      expect(body["models"]).toEqual([
        { id: "gpt-4o", name: "GPT-4o" },
        { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
      ]);
    });
  });

  describe("POST /api/admin/integrations/test", () => {
    it("tests unsaved Copilot config without persisting a temporary integration", async () => {
      pluginManager.registerConnectionTester("copilot", vi.fn(async () => ({
        success: true,
        error: null,
        models: [
          { id: "gpt-4o", name: "GPT-4o" },
          { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
        ],
      })));

      const { status, body } = await fetchFromServer(server, "/api/admin/integrations/test", {
        method: "POST",
        body: {
          provider: "copilot",
          config: { sessionToken: "enc_test_token" },
        },
      });

      expect(status).toBe(200);
      expect(body).toEqual({
        success: true,
        error: null,
        models: [
          { id: "gpt-4o", name: "GPT-4o" },
          { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
        ],
      });
      expect(vi.mocked(integrationStore.upsertIntegration)).not.toHaveBeenCalled();
    });

    it("merges persisted secret fields for edit-mode tests without saving changes", async () => {
      await integrationStore.upsertIntegration({
        id: "copilot-edit",
        provider: "copilot",
        name: "Copilot Edit",
        configJson: JSON.stringify({
          sessionToken: "secret-token",
        }),
        enabled: false,
      });

      const tester = vi.fn(async (config: unknown) => {
        expect(config).toEqual({
          authMode: "oauth",
          sessionToken: "secret-token",
        });

        return {
          success: true,
          error: null,
          models: [{ id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" }],
        };
      });
      pluginManager.registerConnectionTester("copilot", tester);

      const { status, body } = await fetchFromServer(server, "/api/admin/integrations/test", {
        method: "POST",
        body: {
          integrationId: "copilot-edit",
          provider: "copilot",
          config: {
            sessionToken: SECRET_MASK,
          },
        },
      });

      expect(status).toBe(200);
      expect(body).toEqual({
        success: true,
        error: null,
        models: [{ id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" }],
      });
      expect(tester).toHaveBeenCalledTimes(1);

      const stored = await integrationStore.getIntegration("copilot-edit");
      expect(JSON.parse(stored?.configJson ?? "{}")).toEqual({
        sessionToken: "secret-token",
      });
    });
  });

  describe("DELETE /api/admin/integrations/:id", () => {
    it("deletes an integration", async () => {
      const { body: createBody } = await fetchFromServer(server, "/api/admin/integrations", {
        method: "POST",
        body: { provider: "mock", name: "To Delete", config: {} },
      });
      const id = (createBody["integration"] as Record<string, unknown>)["id"] as string;

      const { status, body } = await fetchFromServer(server, `/api/admin/integrations/${id}`, {
        method: "DELETE",
      });
      expect(status).toBe(200);
      expect(body["deleted"]).toBe(true);

      // Verify it's gone
      const { status: getStatus } = await fetchFromServer(server, `/api/admin/integrations/${id}`);
      expect(getStatus).toBe(404);
    });

    it("returns 409 when the integration is still referenced by agents or project relations", async () => {
      vi.mocked(integrationStore.countIntegrationReferences).mockResolvedValueOnce(2);

      const { body: createBody } = await fetchFromServer(server, "/api/admin/integrations", {
        method: "POST",
        body: { provider: "mock", name: "In Use", config: {} },
      });
      const id = (createBody["integration"] as Record<string, unknown>)["id"] as string;

      const { status, body } = await fetchFromServer(server, `/api/admin/integrations/${id}`, {
        method: "DELETE",
      });
      expect(status).toBe(409);
      expect(body["error"]).toBe("Conflict");
      expect(body["referenceCount"]).toBe(2);
      // integration should still exist
      const { status: getStatus } = await fetchFromServer(server, `/api/admin/integrations/${id}`);
      expect(getStatus).toBe(200);
    });
  });

  describe("PUT /api/admin/integrations/:id", () => {
    it("updates an integration", async () => {
      const { body: createBody } = await fetchFromServer(server, "/api/admin/integrations", {
        method: "POST",
        body: { provider: "redmine", name: "Old Name", config: {} },
      });
      const id = (createBody["integration"] as Record<string, unknown>)["id"] as string;

      const { status, body } = await fetchFromServer(server, `/api/admin/integrations/${id}`, {
        method: "PUT",
        body: { name: "New Name", config: { baseUrl: "http://new:3000" } },
      });
      expect(status).toBe(200);
      const integration = body["integration"] as Record<string, unknown>;
      expect(integration["name"]).toBe("New Name");
    });

    it("returns 404 for unknown id", async () => {
      const { status } = await fetchFromServer(server, "/api/admin/integrations/nonexistent", {
        method: "PUT",
        body: { name: "X" },
      });
      expect(status).toBe(404);
    });

    it("rejects changing the integration type during update", async () => {
      await integrationStore.upsertIntegration({
        id: "redmine-no-retype",
        provider: "redmine",
        name: "Redmine No Retype",
        configJson: JSON.stringify({
          baseUrl: "http://redmine:3000",
          apiKey: "existing-api-key",
          virtualEngineerUserLogin: "ve",
        }),
        enabled: false,
      });

      const { status } = await fetchFromServer(server, "/api/admin/integrations/redmine-no-retype", {
        method: "PUT",
        body: {
          provider: "gerrit",
        },
      });

      expect(status).toBe(400);

      const stored = await integrationStore.getIntegration("redmine-no-retype");
      expect(stored?.provider).toBe("redmine");
    });

    it("rejects invalid merged config and leaves the stored integration unchanged", async () => {
      await integrationStore.upsertIntegration({
        id: "redmine-invalid",
        provider: "redmine",
        name: "Redmine Invalid",
        configJson: JSON.stringify({
          baseUrl: "http://redmine:3000",
          apiKey: "existing-api-key",
          virtualEngineerUserLogin: "ve",
        }),
        enabled: false,
      });

      const { status } = await fetchFromServer(server, "/api/admin/integrations/redmine-invalid", {
        method: "PUT",
        body: {
          config: {
            baseUrl: "not-a-url",
          },
        },
      });

      expect(status).toBe(400);

      const stored = await integrationStore.getIntegration("redmine-invalid");
      expect(JSON.parse(stored?.configJson ?? "{}") as Record<string, unknown>).toMatchObject({
        baseUrl: "http://redmine:3000",
        apiKey: "existing-api-key",
        virtualEngineerUserLogin: "ve",
      });
    });

    it("preserves stored secrets when updating non-secret fields", async () => {
      await integrationStore.upsertIntegration({
        id: "redmine-edit",
        provider: "redmine",
        name: "Redmine Editable",
        configJson: JSON.stringify({
          baseUrl: "http://redmine:3000",
          apiKey: "existing-api-key",
          virtualEngineerUserLogin: "ve",
        }),
        enabled: false,
      });

      const { status, body } = await fetchFromServer(server, "/api/admin/integrations/redmine-edit", {
        method: "PUT",
        body: {
          name: "Redmine Updated",
          config: {
            baseUrl: "http://redmine.internal:3000",
            virtualEngineerUserLogin: "ve",
          },
        },
      });

      expect(status).toBe(200);
      expect(body["integration"]).toMatchObject({
        id: "redmine-edit",
        domainCapabilities: expect.arrayContaining(["issue_tracking"]),
        config: {
          baseUrl: "http://redmine.internal:3000",
          apiKey: SECRET_MASK,
          virtualEngineerUserLogin: "ve",
        },
      });

      const stored = await integrationStore.getIntegration("redmine-edit");
      expect(JSON.parse(stored?.configJson ?? "{}") as Record<string, unknown>).toMatchObject({
        baseUrl: "http://redmine.internal:3000",
        apiKey: "existing-api-key",
        virtualEngineerUserLogin: "ve",
      });
    });

    it("preserves stored secrets when the UI echoes the secret mask or sends an empty secret", async () => {
      await integrationStore.upsertIntegration({
        id: "redmine-secret-mask",
        provider: "redmine",
        name: "Redmine Secret Mask",
        configJson: JSON.stringify({
          baseUrl: "http://redmine:3000",
          apiKey: "existing-api-key",
          virtualEngineerUserLogin: "ve",
        }),
        enabled: false,
      });

      const { status } = await fetchFromServer(server, "/api/admin/integrations/redmine-secret-mask", {
        method: "PUT",
        body: {
          config: {
            apiKey: SECRET_MASK,
            virtualEngineerUserLogin: "ve",
          },
        },
      });

      expect(status).toBe(200);

      const stored = await integrationStore.getIntegration("redmine-secret-mask");
      expect(JSON.parse(stored?.configJson ?? "{}") as Record<string, unknown>).toMatchObject({
        baseUrl: "http://redmine:3000",
        apiKey: "existing-api-key",
        virtualEngineerUserLogin: "ve",
      });
    });

    it("reloads the provider when updating an enabled integration", async () => {
      await integrationStore.upsertIntegration({
        id: "redmine-enabled",
        provider: "redmine",
        name: "Redmine Enabled",
        configJson: JSON.stringify({
          baseUrl: "http://redmine:3000",
          apiKey: "existing-api-key",
          virtualEngineerUserLogin: "ve",
        }),
        enabled: true,
      });
      await pluginManager.loadFromDatabase();

      const reloadIntegration = vi.fn(async () => undefined);
      Object.assign(pluginManager as object, { reloadIntegration });

      const { status } = await fetchFromServer(server, "/api/admin/integrations/redmine-enabled", {
        method: "PUT",
        body: {
          config: {
            baseUrl: "http://redmine.internal:3000",
            virtualEngineerUserLogin: "ve",
          },
        },
      });

      expect(status).toBe(200);
      expect(reloadIntegration).toHaveBeenCalledWith("redmine-enabled");
    });

    it("updates a secret only when a new value is explicitly provided", async () => {
      await integrationStore.upsertIntegration({
        id: "copilot-edit",
        provider: "copilot",
        name: "Copilot Editable",
        configJson: JSON.stringify({
          sessionToken: "old-token",
        }),
        enabled: false,
      });

      const { status, body } = await fetchFromServer(server, "/api/admin/integrations/copilot-edit", {
        method: "PUT",
        body: {
          config: {
            sessionToken: "new-token",
          },
        },
      });

      expect(status).toBe(200);
      expect(body["integration"]).toMatchObject({
        id: "copilot-edit",
        domainCapabilities: expect.arrayContaining(["agent_execution"]),
        config: {
          sessionToken: SECRET_MASK,
        },
      });

      const stored = await integrationStore.getIntegration("copilot-edit");
      expect(JSON.parse(stored?.configJson ?? "{}") as Record<string, unknown>).toEqual({
        sessionToken: "new-token",
      });
    });
  });
});
