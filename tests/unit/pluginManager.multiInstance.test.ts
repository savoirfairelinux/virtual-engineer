import { describe, it, expect, beforeEach, vi } from "vitest";
import { PluginManager } from "../../src/plugins/pluginManager.js";
import { registerBuiltinPlugins } from "../../src/plugins/init.js";
import type {
  AgentAdapter,
  AgentResult,
  IntegrationStore,
  Integration,
  ProviderId,
  DomainCapability,
  TaskContext,
} from "../../src/interfaces.js";

const PROVIDER_CAPABILITY: Record<ProviderId, DomainCapability> = {
  redmine: "issue_tracking",
  gerrit: "code_review",
  gitlab: "issue_tracking",
  github: "issue_tracking",
  mock: "agent_execution",
  copilot: "agent_execution",
};

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

function makeIntegration(overrides: Partial<Integration> & { id: string; provider: ProviderId }): Integration {
  return {
    name: overrides.id,
    configJson: "{}",
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeAgentInstance(name: string): AgentAdapter {
  return {
    name,
    buildContainerSpec: vi.fn(() => ({
      image: "x:latest",
      env: {},
      command: [],
    })),
    execute: vi.fn(async (_c: TaskContext): Promise<AgentResult> => ({
      status: "success",
      modifiedFiles: [],
      summary: "",
      agentLogs: "",
      metadata: {},
    })),
  };
}

describe("PluginManager — Phase 4 multi-instance", () => {
  beforeEach(() => {
    registerBuiltinPlugins();
  });

  it("getConnectorForIntegration returns the resolved instance for any active integration id", async () => {
    const store = makeStore([
      makeIntegration({
        id: "redmine-a",
        provider: "redmine",
        configJson: JSON.stringify({ baseUrl: "http://r-a:3000", apiKey: "k", virtualEngineerUserLogin: "ve" }),
      }),
      makeIntegration({
        id: "copilot-a",
        provider: "copilot",
        configJson: JSON.stringify({ apiKey: "tok" }),
      }),
    ]);

    const copilotInstance = makeAgentInstance("copilot-instance");

    const mgr = new PluginManager(store);
    // Factories are honoured only for agent_execution providers (e.g. copilot).
    mgr.registerFactory("copilot", vi.fn(() => copilotInstance));

    await mgr.loadFromDatabase();

    // Issue-tracking connector is built from the descriptor (no factory needed).
    expect(mgr.getConnectorForIntegration("redmine-a")).not.toBeNull();
    // Agent-execution provider resolves to the registered factory instance.
    expect(mgr.getConnectorForIntegration("copilot-a")).toBe(copilotInstance);
    expect(mgr.getConnectorForIntegration("does-not-exist")).toBeNull();
  });

  it("keeps multiple integrations of the same category active simultaneously", async () => {
    // Two ticketing integrations: one redmine + one gitlab-issue.
    const store = makeStore([
      makeIntegration({
        id: "redmine-1",
        provider: "redmine",
        configJson: JSON.stringify({ baseUrl: "http://r:3000", apiKey: "k", virtualEngineerUserLogin: "ve" }),
      }),
      makeIntegration({
        id: "gitlab-1",
        provider: "gitlab",
        configJson: JSON.stringify({ baseUrl: "https://gl", projectId: "1", token: "t", inProgressLabel: "In Progress", inReviewLabel: "In Review" }),
      }),
    ]);

    const mgr = new PluginManager(store);

    await mgr.loadFromDatabase();

    // No auto-disable: both stay enabled in the store.
    expect(store.setIntegrationEnabled).not.toHaveBeenCalled();
    // Both resolvable by id (built from their descriptors).
    expect(mgr.getConnectorForIntegration("redmine-1")).not.toBeNull();
    expect(mgr.getConnectorForIntegration("gitlab-1")).not.toBeNull();
    // Per-type lookup also works.
    expect(activeConnector(mgr, "redmine")).not.toBeNull();
    expect(activeConnector(mgr, "gitlab")).not.toBeNull();
  });

  it("keeps multiple Gerrit integrations of the same type addressable by integration id", async () => {
    const store = makeStore([
      makeIntegration({
        id: "gerrit-a",
        provider: "gerrit",
        configJson: JSON.stringify({
          sshHost: "gerrit-a.example.com",
          sshPort: 29418,
          sshUser: "ve",
          sshKeyPath: "/keys/a",
        }),
      }),
      makeIntegration({
        id: "gerrit-b",
        provider: "gerrit",
        configJson: JSON.stringify({
          sshHost: "gerrit-b.example.com",
          sshPort: 29418,
          sshUser: "ve",
          sshKeyPath: "/keys/b",
        }),
      }),
    ]);

    const mgr = new PluginManager(store);

    await mgr.loadFromDatabase();

    // Each Gerrit integration builds its own code_review connector instance.
    const connectorA = mgr.getConnectorForIntegration("gerrit-a");
    const connectorB = mgr.getConnectorForIntegration("gerrit-b");
    expect(connectorA).not.toBeNull();
    expect(connectorB).not.toBeNull();
    expect(connectorA).not.toBe(connectorB);
    expect(mgr.isIntegrationActive("gerrit-a")).toBe(true);
    expect(mgr.isIntegrationActive("gerrit-b")).toBe(true);
    expect(mgr.getActiveIntegrationsByProvider("gerrit").map((integration) => integration.id).sort()).toEqual([
      "gerrit-a",
      "gerrit-b",
    ]);
    expect(mgr.getActiveIntegrationsByCapability("code_review").map((integration) => integration.id).sort()).toEqual([
      "gerrit-a",
      "gerrit-b",
    ]);
  });

  it("passes the Integration metadata through to plugin factories", async () => {
    const store = makeStore([
      makeIntegration({
        id: "copilot-a",
        provider: "copilot",
        configJson: JSON.stringify({ apiKey: "tok-a" }),
      }),
      makeIntegration({
        id: "copilot-b",
        provider: "copilot",
        configJson: JSON.stringify({ apiKey: "tok-b" }),
      }),
    ]);

    const factory = vi.fn((_config: unknown, integration: Integration) => makeAgentInstance(`agent-${integration.id}`));

    const mgr = new PluginManager(store);
    mgr.registerFactory("copilot", factory);

    await mgr.loadFromDatabase();

    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls.map((call) => (call[1] as Integration).id).sort()).toEqual([
      "copilot-a",
      "copilot-b",
    ]);
  });

  it("drops integration-level Copilot model from factory config", async () => {
    const store = makeStore([
      makeIntegration({
        id: "copilot-configured",
        provider: "copilot",
        configJson: JSON.stringify({
          sessionToken: "tok-a",
          model: "gpt-5.4",
        }),
      }),
    ]);

    const factory = vi.fn((_config: unknown, _integration: Integration) => makeAgentInstance("copilot-configured"));

    const mgr = new PluginManager(store);
    mgr.registerFactory("copilot", factory);

    await mgr.loadFromDatabase();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      sessionToken: "tok-a",
    }));
    // model should be undefined (transformed away)
    expect((factory.mock.calls[0]?.[0] as Record<string, unknown>)?.["model"]).toBeUndefined();
  });

  it("getActiveIntegrationsByCategory returns all active integrations in that category", async () => {
    const store = makeStore([
      makeIntegration({
        id: "redmine-1",
        provider: "redmine",
        configJson: JSON.stringify({ baseUrl: "http://r:3000", apiKey: "k", virtualEngineerUserLogin: "ve" }),
      }),
      makeIntegration({
        id: "gitlab-1",
        provider: "gitlab",
        configJson: JSON.stringify({ baseUrl: "https://gl", projectId: "1", token: "t", inProgressLabel: "In Progress", inReviewLabel: "In Review" }),
      }),
    ]);

    const mgr = new PluginManager(store);
    mgr.registerFactory("redmine", vi.fn(() => makeAgentInstance("r")));
    mgr.registerFactory("gitlab", vi.fn(() => makeAgentInstance("g")));

    await mgr.loadFromDatabase();

    const issues = mgr.getActiveIntegrationsByCapability("issue_tracking");
    const ids = issues.map((i) => i.id).sort();
    expect(ids).toEqual(["gitlab-1", "redmine-1"]);
  });
});
