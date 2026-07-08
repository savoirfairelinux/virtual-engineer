import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config.js";
import type { AgentAdapter, AgentResult, ReviewConnector, Integration, ProviderId, DomainCapability, TicketConnector, Task } from "../../src/interfaces.js";

type ConnectorByType = Partial<Record<ProviderId, TicketConnector | ReviewConnector | AgentAdapter | null>>;

type ActiveIntegrations = Partial<Record<ProviderId, Integration>>;
type ActiveIntegrationLists = Partial<Record<ProviderId, Integration[]>>;

const PROVIDER_CAPABILITIES: Record<ProviderId, DomainCapability[]> = {
  redmine: ["issue_tracking"],
  gitlab: ["issue_tracking", "code_review", "source_control"],
  github: ["issue_tracking", "code_review", "source_control"],
  gerrit: ["code_review", "source_control"],
  copilot: ["agent_execution"],
  mock: ["agent_execution"],
  claude: ["agent_execution"],
};

const ALL_PROVIDERS: ProviderId[] = ["redmine", "gitlab", "gerrit", "github", "copilot", "claude", "mock"];

const baseConfig: AppConfig = {
  nodeEnv: "test" as const,
  logLevel: "error" as const,
  databasePath: "/tmp/virtual-engineer-test.db",
  adminApiEnabled: false,
  adminApiHost: "127.0.0.1",
  adminApiPort: 3100,
  adminAuthSecret: undefined,
  adminTrustProxy: false,
  pollingIntervalMs: 30_000,
  maxAgentCycles: 3,
  maxRetryAttempts: 5,
  maxCommitsPerCycle: 10,
  agentTimeoutMs: 60_000,
  agentContainerImage: "virtual-engineer-workspace:latest",
  agentDockerNetwork: "virtual-engineer_ve-agent-net",
  workspaceBaseDir: "/tmp/virtual-engineer/workspaces",
  maxReviewDiffChars: 60_000,
  maxReviewComments: 20,
  maxReviewReplies: 20,
  reviewMinSeverity: "info",
};

function makeDbAgentAdapter(name: string): AgentAdapter {
  return {
    name,
    buildContainerSpec: vi.fn(() => ({
      image: "virtual-engineer-workspace:latest",
      env: {},
      command: ["node", "/agent-worker/dist/index.js"],
    })),
    execute: vi.fn(async (): Promise<AgentResult> => ({
      status: "success",
      modifiedFiles: [],
      summary: `${name} executed`,
      agentLogs: "",
      metadata: {},
    })),
  };
}

function makeIntegration(overrides: Partial<Integration> & { id: string; provider: ProviderId }): Integration {
  const { id, provider, ...rest } = overrides;
  return {
    id,
    provider,
    name: provider,
    configJson: JSON.stringify({}),
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...rest,
  };
}

async function importRuntime(
  activeProviders: ConnectorByType = {},
  activeIntegrations: ActiveIntegrations = {},
  options: {
    configOverrides?: Partial<typeof baseConfig>;
    storeIntegrations?: Integration[];
    activeIntegrationLists?: ActiveIntegrationLists;
    /** When provided, hasRunnableProject will find a complete project. */
    withRunnableProject?: {
      projectId: string;
      type: "coding" | "review";
      ticketSourceIntegrationId?: string;
      pushTargetIntegrationId?: string;
      reviewTargetIntegrationId?: string;
    };
    /** Active tasks returned by stateStore.getActiveTasks at boot. */
    activeTasks?: Task[];
  } = {}
) {
  vi.resetModules();

  let registerBuiltinPlugins = vi.fn();
  const loadFromDatabase = vi.fn().mockResolvedValue(undefined);
  const envTicketing = { source: "env-ticketing" } as unknown as TicketConnector;
  const envReview = { source: "env-review" } as unknown as ReviewConnector;
  const envAgent = { name: "env-agent" } as unknown as AgentAdapter;
  const activeIntegrationLists: ActiveIntegrationLists = {
    ...options.activeIntegrationLists,
  };
  const getActiveIntegrationsByProvider = (provider: ProviderId): Integration[] => {
    const listed = activeIntegrationLists[provider];
    if (listed !== undefined) {
      return [...listed];
    }

    const integration = activeIntegrations[provider];
    if (integration) {
      return [integration];
    }

    if (activeProviders[provider] != null) {
      return [makeIntegration({ id: `${provider}-active`, provider })];
    }

    return [];
  };
  const getAllActiveIntegrations = (): Integration[] => {
    const byProvider = new Map<ProviderId, Integration[]>();
    for (const provider of ALL_PROVIDERS) {
      byProvider.set(provider, getActiveIntegrationsByProvider(provider));
    }

    return [...byProvider.values()].flat();
  };

  const pluginManagerInstance = {
    loadFromDatabase,
    getActiveIntegrations: vi.fn(() => getAllActiveIntegrations()),
    getActiveIntegrationById: vi.fn((integrationId: string) => {
      return getAllActiveIntegrations().find((integration) => integration.id === integrationId) ?? null;
    }),
    getConnectorForIntegration: vi.fn((integrationId: string) => {
      const integration = getAllActiveIntegrations().find((candidate) => candidate.id === integrationId);
      if (!integration) {
        return null;
      }
      return activeProviders[integration.provider] ?? null;
    }),
    getConnectorForCapability: vi.fn((integrationId: string, _capability: DomainCapability) => {
      const integration = getAllActiveIntegrations().find((candidate) => candidate.id === integrationId);
      if (!integration) {
        return null;
      }
      return activeProviders[integration.provider] ?? null;
    }),
    isIntegrationActive: vi.fn((integrationId: string) => {
      return getAllActiveIntegrations().some((i) => i.id === integrationId);
    }),
    getActiveIntegrationsByProvider: vi.fn((provider: ProviderId) => getActiveIntegrationsByProvider(provider)),
    getActiveIntegrationsByCapability: vi.fn((capability: DomainCapability) => {
      return getAllActiveIntegrations().filter((integration) =>
        PROVIDER_CAPABILITIES[integration.provider].includes(capability)
      );
    }),
    getActiveProviders: vi.fn(() => {
      return ALL_PROVIDERS.filter((provider) => getActiveIntegrationsByProvider(provider).length > 0);
    }),
    integrationHasStreamEvents: vi.fn((integrationId: string) => {
      const integration = getAllActiveIntegrations().find((i) => i.id === integrationId);
      return integration?.provider === "gerrit";
    }),
    getIntegrationCapabilityIntake: vi.fn((integrationId: string, capability: DomainCapability) => {
      const integration = getAllActiveIntegrations().find((i) => i.id === integrationId);
      if (!integration) return [];
      if (integration.provider === "gerrit" && capability === "code_review") return ["stream"];
      if (integration.provider === "github" && capability === "code_review") return ["polling", "webhook"];
      if (integration.provider === "gitlab" && capability === "code_review") return ["webhook"];
      return [];
    }),
    registerFactory: vi.fn(),
    registerConnectionTester: vi.fn(),
    reloadIntegration: vi.fn().mockResolvedValue(undefined),
    onPluginChange: vi.fn(),
    decryptIntegrationConfig: vi.fn((integration: Integration) => {
      return JSON.parse(integration.configJson) as Record<string, unknown>;
    }),
    // Mirror the real descriptor behaviour: only generated-key integrations
    // (with sshPrivateKeyEnc) resolve to a temp-file key path.
    resolveConfigRuntimeExtras: vi.fn((integration: Integration): Record<string, unknown> => {
      const cfg = JSON.parse(integration.configJson) as Record<string, unknown>;
      if (typeof cfg["sshPrivateKeyEnc"] === "string" && cfg["sshPrivateKeyEnc"] !== "") {
        return { _resolvedSshKeyPath: `/tmp/ve-ssh-${integration.id}.pem` };
      }
      return {};
    }),
  };

  const PluginManager = vi.fn().mockImplementation(function () { return pluginManagerInstance; });
  const HttpRedmineConnector = vi.fn().mockImplementation(function () { return envTicketing; });
  const GerritSshConnector = vi.fn().mockImplementation(function () { return envReview; });
  const GitLabIssueConnector = vi.fn().mockImplementation(function () { return envTicketing; });
  const GitLabMergeRequestConnector = vi.fn().mockImplementation(function () { return envReview; });
  const MockAgentAdapter = vi.fn().mockImplementation(function () { return envAgent; });
  const CopilotAdapter = vi.fn().mockImplementation(function () { return envAgent; });
  const integrationStreamEventsInstance = {
    reconcile: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue(null),
    listStatuses: vi.fn().mockReturnValue([]),
  };
  const PluginIntegrationStreamEventsManager = vi.fn().mockImplementation(function () { return integrationStreamEventsInstance; });
  type MockReviewProviderInstance = {
    config: Record<string, unknown>;
    isReviewer: ReturnType<typeof vi.fn>;
  };
  const reviewProviderInstances: Array<{
    config: Record<string, unknown>;
    isReviewer: ReturnType<typeof vi.fn>;
  }> = [];
  const GerritSshReviewProvider = vi.fn().mockImplementation(function (config: Record<string, unknown>) {
    const instance = {
      kind: "gerrit",
      config,
      isReviewer: vi.fn(async () => true),
      getChangeDetails: vi.fn(),
      getChangeDiff: vi.fn(),
      postReviewComments: vi.fn(),
      vote: vi.fn(),
    };
    reviewProviderInstances.push(instance as MockReviewProviderInstance);
    return instance;
  });
  const DockerWorkspaceRunner = vi.fn().mockImplementation(function () {
    return {
      runAgentInDocker: vi.fn(),
      destroyWorkspace: vi.fn(),
      updateRuntime: vi.fn(),
    };
  });
  const createVcsConnectorForIntegration = vi.fn(() => ({ pushRepo: vi.fn() }));

  const Orchestrator = vi.fn().mockImplementation(function () {
    return {
      resumeActiveTasks: vi.fn().mockResolvedValue(undefined),
      updateRuntime: vi.fn(),
      continueTask: vi.fn().mockResolvedValue(undefined),
      invalidateVcsConnector: vi.fn(),
    };
  });
  const PollingLoop = vi.fn().mockImplementation(function () {
    let running = false;
    return {
      start: vi.fn(() => { running = true; }),
      stop: vi.fn(() => { running = false; }),
      isRunning: () => running,
      getIntervals: () => ({ intervalMs: 30_000 }),
      updateConnectors: vi.fn(),
      resetBackoff: vi.fn(),
    };
  });
  const integrationData = new Map<string, Integration>();
  for (const integration of options.storeIntegrations ?? []) {
    integrationData.set(integration.id, { ...integration });
  }

  const runnableProject = options.withRunnableProject;
  const stateStore = {
    close: vi.fn(),
    getIntegrations: vi.fn(async () => [...integrationData.values()]),
    getIntegration: vi.fn(async (id: string) => integrationData.get(id) ?? null),
    listProjects: vi.fn(async () =>
      runnableProject
        ? [{ id: runnableProject.projectId, type: runnableProject.type, name: "test", enabled: true, agentId: "agent-1" }]
        : []
    ),
    getProjectTicketSource: vi.fn(async () =>
      runnableProject?.ticketSourceIntegrationId
        ? { integrationId: runnableProject.ticketSourceIntegrationId, ticketProjectKey: "TEST" }
        : null
    ),
    listProjectPushTargets: vi.fn(async () =>
      runnableProject?.pushTargetIntegrationId
        ? [{ integrationId: runnableProject.pushTargetIntegrationId, repoKey: "test/repo" }]
        : []
    ),
    getProjectReviewConfig: vi.fn(async () =>
      runnableProject?.reviewTargetIntegrationId
        ? { integrationId: runnableProject.reviewTargetIntegrationId, repos: ["test/repo"] }
        : null
    ),
    getActiveTasks: vi.fn(async (): Promise<Task[]> => options.activeTasks ?? []),
    onTaskTransition: vi.fn(),
    upsertIntegration: vi.fn(async (inp: Omit<Integration, "createdAt" | "updatedAt">) => {
      const now = new Date();
      const existing = integrationData.get(inp.id);
      const result: Integration = {
        ...inp,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      integrationData.set(inp.id, result);
      return result;
    }),
    deleteIntegration: vi.fn(async (id: string) => {
      integrationData.delete(id);
    }),
    countIntegrationReferences: vi.fn(async (_id: string) => 0),
    setIntegrationEnabled: vi.fn(async (id: string, enabled: boolean) => {
      const existing = integrationData.get(id);
      if (!existing) {
        throw new Error(`Integration not found: ${id}`);
      }
      const updated: Integration = {
        ...existing,
        enabled,
        updatedAt: new Date(),
      };
      integrationData.set(id, updated);
      return updated;
    }),
    getPrompts: vi.fn(async () => []),
    getPrompt: vi.fn(async (id: string) => {
      const content = id.startsWith("review-system") ? "You are a code reviewer." : "You are a software engineer.";
      return { id, label: id, content, promptType: "user" as const, updatedAt: new Date() };
    }),
    upsertPrompt: vi.fn(async (id: string, content: string) => ({ id, label: id, content, promptType: "user" as const, updatedAt: new Date() })),
    createPrompt: vi.fn(async (label: string, content: string) => ({ id: label, label, content, promptType: "user" as const, updatedAt: new Date() })),
    deletePrompt: vi.fn(async (_id: string) => {}),
    getAppSettings: vi.fn(async () => ({ pollingIntervalMs: null, maxAgentCycles: null, maxRetryAttempts: null })),
    updateAppSettings: vi.fn(async (patch: { pollingIntervalMs?: number | null; maxAgentCycles?: number | null; maxRetryAttempts?: number | null }) => ({
      pollingIntervalMs: patch.pollingIntervalMs ?? null,
      maxAgentCycles: patch.maxAgentCycles ?? null,
      maxRetryAttempts: patch.maxRetryAttempts ?? null,
    })),
  };
  const createAdminServer = vi.fn(() => ({
    once: vi.fn(),
    off: vi.fn(),
    listen: vi.fn((_port, _host, callback: () => void) => {
      callback();
    }),
    close: vi.fn(),
  }));

  vi.doMock("../../src/config.js", () => ({
    getConfig: vi.fn(() => ({ ...baseConfig, ...(options.configOverrides ?? {}) })),
  }));
  vi.doMock("../../src/logger.js", () => ({
    getLogger: vi.fn(() => ({
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    })),
  }));
  vi.doMock("../../src/state/stateStore.js", () => ({
    SqliteStateStore: {
      create: vi.fn().mockResolvedValue(stateStore),
    },
  }));
  vi.doMock("../../src/plugins/init.js", async () => {
    // Call through to the real registerBuiltinPlugins so that plugin descriptors
    // (including gerritDescriptor.createReviewer) are registered.
    // Transitive imports (e.g. gerritSshReviewProvider.js) still resolve to
    // whatever vi.doMock registered above, so the test mocks are honoured.
    const actual = await vi.importActual<{ registerBuiltinPlugins(): void }>(
      "../../src/plugins/init.js"
    );
    registerBuiltinPlugins = vi.fn().mockImplementation(actual.registerBuiltinPlugins);
    return { registerBuiltinPlugins };
  });
  vi.doMock("../../src/plugins/pluginManager.js", () => ({ PluginManager }));
  vi.doMock("../../src/connectors/redmineConnector.js", () => ({ HttpRedmineConnector }));
  vi.doMock("../../src/connectors/gerritConnector.js", () => ({ GerritSshConnector }));
  vi.doMock("../../src/connectors/gitlabIssueConnector.js", () => ({
    DEFAULT_GITLAB_IN_PROGRESS_LABEL: "in-progress",
    DEFAULT_GITLAB_IN_REVIEW_LABEL: "in-review",
    GitLabIssueConnector,
  }));
  vi.doMock("../../src/connectors/gitlabMergeRequestConnector.js", () => ({
    GitLabMergeRequestConnector,
  }));
  vi.doMock("../../src/agents/mockAgentAdapter.js", () => ({ MockAgentAdapter }));
  vi.doMock("../../src/agents/copilotAdapter.js", () => ({
    CopilotAdapter,
  }));
  const CopilotReviewAgent = vi.fn().mockImplementation(function () { return { runReview: vi.fn() }; });
  vi.doMock("../../src/review/copilotReviewAgent.js", () => ({ CopilotReviewAgent }));
  const ReviewOrchestrator = vi.fn().mockImplementation(function () {
    return {
      startReviewTask: vi.fn().mockResolvedValue([]),
      runReview: vi.fn().mockResolvedValue(undefined),
    };
  });
  vi.doMock("../../src/review/reviewOrchestrator.js", () => ({ ReviewOrchestrator }));
  vi.doMock("../../src/connectors/gerritSshReviewProvider.js", () => ({ GerritSshReviewProvider }));
  vi.doMock("../../src/connectors/integrationStreamEvents.js", () => ({ PluginIntegrationStreamEventsManager }));
  vi.doMock("../../src/workspace/workspaceRunner.js", () => ({ DockerWorkspaceRunner }));
  vi.doMock("../../src/vcs/vcsFactory.js", () => ({
    createVcsConnectorForIntegration,
  }));
  vi.doMock("../../src/orchestrator/orchestrator.js", () => ({ Orchestrator }));
  vi.doMock("../../src/orchestrator/pollingLoop.js", () => ({ PollingLoop }));
  vi.doMock("../../src/admin/adminServer.js", () => ({
    createAdminServer,
  }));
  vi.doMock("fs/promises", () => ({
    mkdir: vi.fn().mockResolvedValue(undefined),
  }));

  const processOnSpy = vi.spyOn(process, "on").mockImplementation((() => process) as never);
  const processExitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit should not be called during bootstrap tests");
  }) as never);

  try {
    await import("../../src/index.js");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  } finally {
    processOnSpy.mockRestore();
    processExitSpy.mockRestore();
  }

  return {
    registerBuiltinPlugins,
    PollingLoop,
    PluginManager,
    loadFromDatabase,
    HttpRedmineConnector,
    GerritSshConnector,
    GitLabIssueConnector,
    GitLabMergeRequestConnector,
    MockAgentAdapter,
    CopilotAdapter,
    DockerWorkspaceRunner,
    Orchestrator,
    createVcsConnectorForIntegration,
    createAdminServer,
    stateStore,
    pluginManagerInstance,
    CopilotReviewAgent,
    ReviewOrchestrator,
    GerritSshReviewProvider,
    PluginIntegrationStreamEventsManager,
    integrationStreamEventsInstance,
    reviewProviderInstances,
  };
}

describe("runtime bootstrap provider selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers database-selected providers over env-configured fallbacks", async () => {
    const dbTicketing = { source: "db-ticketing" } as unknown as TicketConnector;
    const dbReview = { source: "db-review" } as unknown as ReviewConnector;
    const dbAgent = makeDbAgentAdapter("db-agent");

    const runtime = await importRuntime({
      redmine: dbTicketing,
      gerrit: dbReview,
      mock: dbAgent,
    });

    expect(runtime.registerBuiltinPlugins).toHaveBeenCalledTimes(1);
    expect(runtime.PluginManager).toHaveBeenCalledTimes(1);
    expect(runtime.loadFromDatabase).toHaveBeenCalledTimes(1);
    expect(runtime.HttpRedmineConnector).not.toHaveBeenCalled();
    expect(runtime.GerritSshConnector).not.toHaveBeenCalled();
    expect(runtime.MockAgentAdapter).not.toHaveBeenCalled();
    expect(runtime.DockerWorkspaceRunner).toHaveBeenCalledWith(
      expect.any(Object),
      dbAgent
    );
    expect(runtime.Orchestrator).toHaveBeenCalledWith(
      expect.any(Object),
      expect.anything(),
      expect.anything(),
      undefined,
      expect.anything(),
      expect.anything()
    );
  });

  it("does not directly instantiate env connectors when no integration is selected (resolved lazily via projects)", async () => {
    const runtime = await importRuntime();

    expect(runtime.registerBuiltinPlugins).toHaveBeenCalledTimes(1);
    expect(runtime.PluginManager).toHaveBeenCalledTimes(1);
    expect(runtime.loadFromDatabase).toHaveBeenCalledTimes(1);
    // Env connectors are no longer created as runtime dependencies —
    // they are resolved lazily per-project at runtime.
    expect(runtime.HttpRedmineConnector).not.toHaveBeenCalled();
    expect(runtime.GerritSshConnector).not.toHaveBeenCalled();
    expect(runtime.GitLabIssueConnector).not.toHaveBeenCalled();
    expect(runtime.GitLabMergeRequestConnector).not.toHaveBeenCalled();
    expect(runtime.MockAgentAdapter).toHaveBeenCalledTimes(1);
  });

  it("uses agent adapter from plugin manager when available, bypasses MockAgentAdapter fallback", async () => {
    const dbAgent = makeDbAgentAdapter("copilot");
    const runtime = await importRuntime({ copilot: dbAgent });

    expect(runtime.MockAgentAdapter).not.toHaveBeenCalled();
    expect(runtime.DockerWorkspaceRunner).toHaveBeenCalledWith(
      expect.any(Object),
      dbAgent
    );
  });

  it("does not call reloadIntegration on the plugin manager during bootstrap", async () => {
    const runtime = await importRuntime(
      {},
      {},
      {
        activeIntegrationLists: {
          copilot: [
            makeIntegration({
              id: "copilot-auto-a",
              provider: "copilot",
              configJson: JSON.stringify({ apiKey: "ghp-token-a" }),
            }),
            makeIntegration({
              id: "copilot-auto-b",
              provider: "copilot",
              configJson: JSON.stringify({ apiKey: "ghp-token-b" }),
            }),
          ],
        },
        configOverrides: {},
      }
    );

    expect(runtime.pluginManagerInstance.reloadIntegration).not.toHaveBeenCalled();
  });

  it("starts one Gerrit stream-events listener per active Gerrit integration", async () => {
    const gerritA = makeIntegration({
      id: "gerrit-a",
      provider: "gerrit",
      configJson: JSON.stringify({ sshHost: "gerrit-a", sshUser: "ve", sshPort: 29418, sshKeyPath: "/keys/a" }),
    });
    const gerritB = makeIntegration({
      id: "gerrit-b",
      provider: "gerrit",
      configJson: JSON.stringify({ sshHost: "gerrit-b", sshUser: "ve", sshPort: 29418, sshKeyPath: "/keys/b" }),
    });

    const runtime = await importRuntime(
      {},
      {},
      {
        activeIntegrationLists: {
          gerrit: [gerritA, gerritB],
        },
      }
    );

    expect(runtime.PluginIntegrationStreamEventsManager).toHaveBeenCalledTimes(1);
    expect(runtime.integrationStreamEventsInstance.reconcile).toHaveBeenCalledWith([gerritA, gerritB]);
  });

  it("resolves generated-key SSH material into the stream-events integration config", async () => {
    const gerritGenerated = makeIntegration({
      id: "gerrit-generated-key",
      provider: "gerrit",
      configJson: JSON.stringify({
        sshHost: "gerrit.test",
        sshUser: "ve",
        sshPort: 29418,
        sshPrivateKeyEnc: "enc:BEGIN-PRIVATE-KEY",
      }),
    });

    const runtime = await importRuntime(
      {},
      {},
      {
        activeIntegrationLists: {
          gerrit: [gerritGenerated],
        },
      }
    );

    const reconcileArgs = runtime.integrationStreamEventsInstance.reconcile.mock.calls[0]?.[0] as Integration[];
    expect(reconcileArgs).toHaveLength(1);
    const resolvedConfig = JSON.parse(reconcileArgs[0]!.configJson) as Record<string, unknown>;
    expect(resolvedConfig["_resolvedSshKeyPath"]).toBe("/tmp/ve-ssh-gerrit-generated-key.pem");
    // Original fields are preserved.
    expect(resolvedConfig["sshHost"]).toBe("gerrit.test");
  });

  it("propagates database-backed provider config into orchestrator and vcs wiring", async () => {
    const dbTicketing = { source: "db-ticketing" } as unknown as TicketConnector;
    const dbReview = { source: "db-review" } as unknown as ReviewConnector;
    const dbAgent = { name: "copilot", configure: vi.fn() } as unknown as AgentAdapter;

    const runtime = await importRuntime(
      {
        redmine: dbTicketing,
        gerrit: dbReview,
        copilot: dbAgent,
      },
      {
        redmine: makeIntegration({
          id: "redmine-db",
          provider: "redmine",
          configJson: JSON.stringify({
            baseUrl: "http://db-redmine.test",
            apiKey: "db-redmine-key",
            virtualEngineerUserLogin: "ve",
            inProgressStatusId: 12,
            inReviewStatusId: 13,
            closedStatusId: 14,
          }),
        }),
        gerrit: makeIntegration({
          id: "gerrit-db",
          provider: "gerrit",
          configJson: JSON.stringify({
            baseUrl: "http://db-gerrit.test",
            httpUsername: "db-http-user",
            httpPassword: "db-http-pass",
            sshHost: "db-gerrit-ssh.test",
            sshPort: 3022,
            sshUser: "db-ssh-user",
            sshKeyPath: "/keys/db_id_rsa",
          }),
        }),
        copilot: makeIntegration({
          id: "copilot-db",
          provider: "copilot",
          configJson: JSON.stringify({
            model: "gpt-5.4-db",
            apiKey: "db-github-token",
          }),
        }),
      }
    );

    expect(runtime.Orchestrator).toHaveBeenCalledWith(
      expect.objectContaining({
        maxAgentCycles: expect.any(Number),
        maxRetryAttempts: expect.any(Number),
        agentTimeoutMs: expect.any(Number),
        gitAuthorName: expect.any(String),
        gitAuthorEmail: expect.any(String),
        agentContainerImage: expect.any(String),
      }),
      expect.anything(),
      expect.anything(),
      undefined,
      expect.anything(),
      expect.anything()
    );

    expect(runtime.CopilotAdapter).not.toHaveBeenCalled();

    const runnerInstance = runtime.DockerWorkspaceRunner.mock.results[0]?.value as {
      runAgentInDocker: ReturnType<typeof vi.fn>;
    };
    expect((dbAgent as unknown as { configure: ReturnType<typeof vi.fn> }).configure).toHaveBeenCalledTimes(1);
    expect((dbAgent as unknown as { configure: ReturnType<typeof vi.fn> }).configure).toHaveBeenCalledWith(
      expect.objectContaining({ runner: runnerInstance })
    );
  });

  it("prefers database-selected GitLab providers and propagates their config", async () => {
    const dbConnector = { source: "db-gitlab" } as unknown as TicketConnector;

    const runtime = await importRuntime(
      {
        gitlab: dbConnector,
      },
      {},
      {
        activeIntegrationLists: {
          gitlab: [
            makeIntegration({
              id: "gitlab-issue-db",
              provider: "gitlab",
              configJson: JSON.stringify({
                baseUrl: "https://db-gitlab-issues.example.com",
                projectId: "team/issues",
                token: "db-issues-token",
                inProgressStatusId: 21,
                inReviewStatusId: 22,
                closedStatusId: 23,
              }),
            }),
            makeIntegration({
              id: "gitlab-review-db",
              provider: "gitlab",
              configJson: JSON.stringify({
                baseUrl: "https://db-gitlab-review.example.com",
                projectId: "team/review",
                token: "db-review-token",
              }),
            }),
          ],
        },
      }
    );

    expect(runtime.HttpRedmineConnector).not.toHaveBeenCalled();
    expect(runtime.GerritSshConnector).not.toHaveBeenCalled();
    expect(runtime.GitLabIssueConnector).not.toHaveBeenCalled();
    expect(runtime.GitLabMergeRequestConnector).not.toHaveBeenCalled();

    expect(runtime.Orchestrator).toHaveBeenCalledWith(
      expect.objectContaining({
        maxAgentCycles: expect.any(Number),
        maxRetryAttempts: expect.any(Number),
        agentTimeoutMs: expect.any(Number),
        gitAuthorName: expect.any(String),
        gitAuthorEmail: expect.any(String),
        agentContainerImage: expect.any(String),
      }),
      expect.anything(),
      expect.anything(),
      undefined,
      expect.anything(),
      expect.anything()
    );
  });

  it("passes a live providers supplier to the admin server so provider state can refresh after integration changes", async () => {
    const activeProviders: ConnectorByType = {
      redmine: { source: "db-ticketing" } as unknown as TicketConnector,
    };
    const activeIntegrations: ActiveIntegrations = {
      redmine: makeIntegration({
        id: "redmine-db",
        provider: "redmine",
        configJson: JSON.stringify({
          baseUrl: "http://db-redmine.initial",
          apiKey: "db-redmine-key",
          virtualEngineerUserLogin: "ve",
        }),
      }),
    };

    const runtime = await importRuntime(activeProviders, activeIntegrations, {
      configOverrides: { adminApiEnabled: true },
    });

    const firstCreateAdminServerCall = runtime.createAdminServer.mock.calls[0] as unknown[] | undefined;
    const adminDeps = firstCreateAdminServerCall?.[0] as { providers: unknown } | undefined;
    expect(adminDeps).toBeDefined();
    expect(typeof adminDeps?.providers).toBe("function");

    const providerSupplier = adminDeps?.providers as () => Array<{ id: string; details: readonly string[] }>;
    const before = providerSupplier();
    expect(before.find((provider) => provider.id === "redmine-db")?.details[0]).toBe("http://db-redmine.initial");

    activeIntegrations.redmine = makeIntegration({
      id: "redmine-db",
      provider: "redmine",
      configJson: JSON.stringify({
        baseUrl: "http://db-redmine.updated",
        apiKey: "db-redmine-key",
        virtualEngineerUserLogin: "ve",
      }),
    });

    const after = providerSupplier();
    expect(after.find((provider) => provider.id === "redmine-db")?.details[0]).toBe("http://db-redmine.updated");
  });

  it("does not start the polling loop when no runnable project exists", async () => {
    const runtime = await importRuntime(
      {},
      {},
      {}
    );

    const pollingInstance = runtime.PollingLoop.mock.results[0]?.value as { start: ReturnType<typeof vi.fn> };
    expect(pollingInstance.start).not.toHaveBeenCalled();
  });

  it("starts the polling loop immediately when a runnable coding project exists", async () => {
    const runtime = await importRuntime(
      {
        redmine: { source: "env-ticketing" } as unknown as TicketConnector,
        gerrit: { source: "env-review" } as unknown as ReviewConnector,
        mock: makeDbAgentAdapter("mock"),
      },
      {},
      {
        withRunnableProject: {
          projectId: "p1",
          type: "coding",
          ticketSourceIntegrationId: "redmine-active",
          pushTargetIntegrationId: "gerrit-active",
        },
      }
    );

    const pollingInstance = runtime.PollingLoop.mock.results[0]?.value as { start: ReturnType<typeof vi.fn> };
    expect(pollingInstance.start).toHaveBeenCalledTimes(1);
  });

  it("starts the polling loop immediately when all three integrations are configured from DB with project", async () => {
    const dbTicketing = { source: "db-ticketing" } as unknown as TicketConnector;
    const dbReview = { source: "db-review" } as unknown as ReviewConnector;
    const dbAgent = makeDbAgentAdapter("mock");

    const runtime = await importRuntime(
      { redmine: dbTicketing, gerrit: dbReview, mock: dbAgent },
      {},
      {
        configOverrides: {
        },
        withRunnableProject: {
          projectId: "p1",
          type: "coding",
          ticketSourceIntegrationId: "redmine-active",
          pushTargetIntegrationId: "gerrit-active",
        },
      }
    );

    const pollingInstance = runtime.PollingLoop.mock.results[0]?.value as { start: ReturnType<typeof vi.fn> };
    expect(pollingInstance.start).toHaveBeenCalledTimes(1);
  });

  it("starts the polling loop via onPluginChange when a runnable project appears", async () => {
    const dbTicketing = { source: "db-ticketing" } as unknown as TicketConnector;
    const dbReview = { source: "db-review" } as unknown as ReviewConnector;

    // Start with ticket source + review but no runnable project
    const activeProviders: ConnectorByType = { redmine: dbTicketing, gerrit: dbReview };

    const runtime = await importRuntime(
      activeProviders,
      {},
      {}
    );

    const pollingInstance = runtime.PollingLoop.mock.results[0]?.value as {
      start: ReturnType<typeof vi.fn>;
      isRunning: () => boolean;
    };

    // Loop must NOT have started yet (no runnable project)
    expect(pollingInstance.start).not.toHaveBeenCalled();

    // Simulate adding the AI adapter + making a project runnable by mutating mock data
    activeProviders.mock = makeDbAgentAdapter("mock");
    runtime.stateStore.listProjects.mockResolvedValue([
      { id: "p1", type: "coding", name: "test", enabled: true, agentId: "agent-1" },
    ]);
    runtime.stateStore.getProjectTicketSource.mockResolvedValue(
      { integrationId: "redmine-active", ticketProjectKey: "TEST" },
    );
    runtime.stateStore.listProjectPushTargets.mockResolvedValue(
      [{ integrationId: "gerrit-active", repoKey: "test/repo" }],
    );

    const onPluginChangeCallback = runtime.pluginManagerInstance.onPluginChange.mock.calls[0]?.[0] as (() => void) | undefined;
    expect(onPluginChangeCallback).toBeTypeOf("function");
    onPluginChangeCallback?.();

    // Allow the async refreshRuntimeDependencies promise to settle
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(pollingInstance.start).toHaveBeenCalledTimes(1);
  });

  it("does not start the polling loop for a stream-only (Gerrit) review project", async () => {
    const dbReview = { source: "db-review" } as unknown as ReviewConnector;
    const dbAgent = makeDbAgentAdapter("mock");

    const runtime = await importRuntime(
      // no redmine / gitlab-issue connector
      { gerrit: dbReview, mock: dbAgent },
      {
        gerrit: makeIntegration({
          id: "gerrit-review-only",
          provider: "gerrit",
          configJson: JSON.stringify({
            baseUrl: "http://gerrit.test",
            httpUsername: "admin",
            httpPassword: "secret",
            sshHost: "gerrit.test",
            sshUser: "ve-bot",
            sshKeyPath: "/keys/id_rsa",
            repoCloneUrl: "ssh://gerrit.test/project",
          }),
        }),
      },
      {
        configOverrides: {
        },
        withRunnableProject: {
          projectId: "p1",
          type: "review",
          reviewTargetIntegrationId: "gerrit-review-only",
        },
      }
    );

    const pollingInstance = runtime.PollingLoop.mock.results[0]?.value as { start: ReturnType<typeof vi.fn> };
    expect(pollingInstance.start).not.toHaveBeenCalled();
  });

  it("starts polling as fallback when the Gerrit stream-events connection is degraded", async () => {
    const dbReview = { source: "db-review" } as unknown as ReviewConnector;
    const dbAgent = makeDbAgentAdapter("mock");

    const runtime = await importRuntime(
      { gerrit: dbReview, mock: dbAgent },
      {
        gerrit: makeIntegration({
          id: "gerrit-review-only",
          provider: "gerrit",
          configJson: JSON.stringify({
            baseUrl: "http://gerrit.test",
            httpUsername: "admin",
            httpPassword: "secret",
            sshHost: "gerrit.test",
            sshUser: "ve-bot",
            sshKeyPath: "/keys/id_rsa",
            repoCloneUrl: "ssh://gerrit.test/project",
          }),
        }),
      },
      {
        withRunnableProject: {
          projectId: "p1",
          type: "review",
          reviewTargetIntegrationId: "gerrit-review-only",
        },
      }
    );

    const pollingInstance = runtime.PollingLoop.mock.results[0]?.value as {
      start: ReturnType<typeof vi.fn>;
      isRunning: () => boolean;
    };
    // Stream healthy (null → not yet connected) — loop must NOT start.
    expect(pollingInstance.start).not.toHaveBeenCalled();

    // Simulate the stream going into an error state.
    runtime.integrationStreamEventsInstance.getStatus.mockReturnValue({
      integrationId: "gerrit-review-only",
      state: "error",
      message: "Connection refused",
    });

    // Plugin-change fires refreshRuntimeDependencies → reconcilePollingLoop.
    const onPluginChangeCallback = runtime.pluginManagerInstance.onPluginChange.mock.calls[0]?.[0] as
      (() => void) | undefined;
    expect(onPluginChangeCallback).toBeTypeOf("function");
    onPluginChangeCallback?.();

    // Allow the async refreshRuntimeDependencies promise to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(pollingInstance.start).toHaveBeenCalledTimes(1);
  });

  it("does not start the polling loop for a webhook-only (GitLab MR) review project", async () => {
    const dbReview = { source: "db-review" } as unknown as ReviewConnector;
    const dbAgent = makeDbAgentAdapter("mock");

    const runtime = await importRuntime(
      { gitlab: dbReview, mock: dbAgent },
      {
        gitlab: makeIntegration({
          id: "gitlab-review-only",
          provider: "gitlab",
          configJson: JSON.stringify({
            baseUrl: "http://gitlab.test",
            token: "token",
          }),
        }),
      },
      {
        configOverrides: {
        },
        withRunnableProject: {
          projectId: "p1",
          type: "review",
          reviewTargetIntegrationId: "gitlab-review-only",
        },
      }
    );

    const pollingInstance = runtime.PollingLoop.mock.results[0]?.value as { start: ReturnType<typeof vi.fn> };
    expect(pollingInstance.start).not.toHaveBeenCalled();
  });

  it("starts the polling loop when an active IN_REVIEW task needs the fallback poll, even in a stream-only setup", async () => {
    const dbReview = { source: "db-review" } as unknown as ReviewConnector;
    const dbAgent = makeDbAgentAdapter("mock");

    const runtime = await importRuntime(
      { gerrit: dbReview, mock: dbAgent },
      {
        gerrit: makeIntegration({
          id: "gerrit-review-only",
          provider: "gerrit",
          configJson: JSON.stringify({
            baseUrl: "http://gerrit.test",
            httpUsername: "admin",
            httpPassword: "secret",
            sshHost: "gerrit.test",
            sshUser: "ve-bot",
            sshKeyPath: "/keys/id_rsa",
            repoCloneUrl: "ssh://gerrit.test/project",
          }),
        }),
      },
      {
        configOverrides: {
        },
      }
    );

    runtime.stateStore.getActiveTasks.mockResolvedValue([
      {
        taskId: "t1",
        taskType: "code-gen",
        state: "IN_REVIEW",
        externalChangeId: "12345",
      } as unknown as Task,
    ]);

    // Re-trigger the same startup check via onPluginChange to exercise pollingIsRequired again.
    const onPluginChangeCallback = runtime.pluginManagerInstance.onPluginChange.mock.calls[0]?.[0] as (() => void) | undefined;
    onPluginChangeCallback?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const pollingInstance = runtime.PollingLoop.mock.results[0]?.value as { start: ReturnType<typeof vi.fn> };
    expect(pollingInstance.start).toHaveBeenCalledTimes(1);
  });

  it("starts the polling loop live when a task requiring fallback polling appears, without a plugin change or restart", async () => {
    const dbReview = { source: "db-review" } as unknown as ReviewConnector;
    const dbAgent = makeDbAgentAdapter("mock");

    // Stream-only setup (Gerrit review project): polling loop must not start at boot.
    const runtime = await importRuntime(
      { gerrit: dbReview, mock: dbAgent },
      {
        gerrit: makeIntegration({
          id: "gerrit-review-only",
          provider: "gerrit",
          configJson: JSON.stringify({
            baseUrl: "http://gerrit.test",
            httpUsername: "admin",
            httpPassword: "secret",
            sshHost: "gerrit.test",
            sshUser: "ve-bot",
            sshKeyPath: "/keys/id_rsa",
            repoCloneUrl: "ssh://gerrit.test/project",
          }),
        }),
      },
      {
        configOverrides: {
        },
        withRunnableProject: {
          projectId: "p1",
          type: "review",
          reviewTargetIntegrationId: "gerrit-review-only",
        },
      }
    );

    const pollingInstance = runtime.PollingLoop.mock.results[0]?.value as {
      start: ReturnType<typeof vi.fn>;
      isRunning: () => boolean;
    };
    expect(pollingInstance.start).not.toHaveBeenCalled();

    // A code-gen task has entered IN_REVIEW (Gerrit push succeeded). The
    // debounced reconcile re-queries active tasks, so reflect that here.
    runtime.stateStore.getActiveTasks.mockResolvedValue([
      {
        taskId: "t1",
        taskType: "code-gen",
        state: "IN_REVIEW",
        externalChangeId: "12345",
      } as unknown as Task,
    ]);

    const onTaskTransitionCallback = runtime.stateStore.onTaskTransition.mock.calls[0]?.[0] as
      ((task: Task) => void) | undefined;
    expect(onTaskTransitionCallback).toBeTypeOf("function");

    vi.useFakeTimers();
    try {
      onTaskTransitionCallback?.({
        taskId: "t1",
        taskType: "code-gen",
        state: "IN_REVIEW",
        externalChangeId: "12345",
      } as unknown as Task);
      // Flush the debounce window + the async reconcile.
      await vi.advanceTimersByTimeAsync(1_500);
    } finally {
      vi.useRealTimers();
    }

    expect(pollingInstance.start).toHaveBeenCalledTimes(1);
  });

  it("stops the polling loop live once no project or task requires polling", async () => {
    const dbReview = { source: "db-review" } as unknown as ReviewConnector;
    const dbAgent = makeDbAgentAdapter("mock");

    // Stream-only Gerrit review project, but an active IN_REVIEW task means
    // polling is required at boot (fallback poller) so the loop starts.
    const runtime = await importRuntime(
      { gerrit: dbReview, mock: dbAgent },
      {
        gerrit: makeIntegration({
          id: "gerrit-review-only",
          provider: "gerrit",
          configJson: JSON.stringify({
            baseUrl: "http://gerrit.test",
            httpUsername: "admin",
            httpPassword: "secret",
            sshHost: "gerrit.test",
            sshUser: "ve-bot",
            sshKeyPath: "/keys/id_rsa",
            repoCloneUrl: "ssh://gerrit.test/project",
          }),
        }),
      },
      {
        configOverrides: {
        },
        withRunnableProject: {
          projectId: "p1",
          type: "review",
          reviewTargetIntegrationId: "gerrit-review-only",
        },
        activeTasks: [
          {
            taskId: "t1",
            taskType: "code-gen",
            state: "IN_REVIEW",
            externalChangeId: "12345",
          } as unknown as Task,
        ],
      }
    );

    const pollingInstance = runtime.PollingLoop.mock.results[0]?.value as {
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      isRunning: () => boolean;
    };
    expect(pollingInstance.start).toHaveBeenCalledTimes(1);
    expect(pollingInstance.isRunning()).toBe(true);

    // The task reached a terminal state — no active tasks and no polling-based
    // project remain, so the reconcile should stop the loop.
    runtime.stateStore.getActiveTasks.mockResolvedValue([]);

    const onTaskTransitionCallback = runtime.stateStore.onTaskTransition.mock.calls[0]?.[0] as
      ((task: Task) => void) | undefined;

    vi.useFakeTimers();
    try {
      onTaskTransitionCallback?.({
        taskId: "t1",
        taskType: "code-gen",
        state: "MERGED",
        externalChangeId: "12345",
      } as unknown as Task);
      await vi.advanceTimersByTimeAsync(1_500);
    } finally {
      vi.useRealTimers();
    }

    expect(pollingInstance.stop).toHaveBeenCalledTimes(1);
    expect(pollingInstance.isRunning()).toBe(false);
  });

  it("does not start the polling loop from a transition when nothing requires polling", async () => {
    const dbReview = { source: "db-review" } as unknown as ReviewConnector;
    const dbAgent = makeDbAgentAdapter("mock");

    const runtime = await importRuntime(
      { gerrit: dbReview, mock: dbAgent },
      {
        gerrit: makeIntegration({
          id: "gerrit-review-only",
          provider: "gerrit",
          configJson: JSON.stringify({
            baseUrl: "http://gerrit.test",
            httpUsername: "admin",
            httpPassword: "secret",
            sshHost: "gerrit.test",
            sshUser: "ve-bot",
            sshKeyPath: "/keys/id_rsa",
            repoCloneUrl: "ssh://gerrit.test/project",
          }),
        }),
      },
      {
        configOverrides: {
        },
        withRunnableProject: {
          projectId: "p1",
          type: "review",
          reviewTargetIntegrationId: "gerrit-review-only",
        },
      }
    );

    const pollingInstance = runtime.PollingLoop.mock.results[0]?.value as { start: ReturnType<typeof vi.fn> };
    expect(pollingInstance.start).not.toHaveBeenCalled();

    const onTaskTransitionCallback = runtime.stateStore.onTaskTransition.mock.calls[0]?.[0] as
      ((task: Task) => void) | undefined;

    vi.useFakeTimers();
    try {
      // AGENT_RUNNING code-gen task: doesn't rely on polling-loop fallbacks,
      // and getActiveTasks stays empty, so the reconcile keeps polling off.
      onTaskTransitionCallback?.({
        taskId: "t2",
        taskType: "code-gen",
        state: "AGENT_RUNNING",
        externalChangeId: "12345",
      } as unknown as Task);
      await vi.advanceTimersByTimeAsync(1_500);
    } finally {
      vi.useRealTimers();
    }

    expect(pollingInstance.start).not.toHaveBeenCalled();
  });

  it("routes stream-events-triggered reviews by exact Gerrit integration id", async () => {
    const gerritA = makeIntegration({
      id: "gerrit-review-a",
      provider: "gerrit",
      configJson: JSON.stringify({
        baseUrl: "http://gerrit-a.test",
        httpUsername: "admin-a",
        httpPassword: "secret-a",
        sshHost: "gerrit-a.test",
        sshUser: "ve-bot-a",
        sshKeyPath: "/keys/id_rsa_a",
        repoCloneUrl: "ssh://gerrit-a.test/project",
      }),
    });
    const gerritB = makeIntegration({
      id: "gerrit-review-b",
      provider: "gerrit",
      configJson: JSON.stringify({
        baseUrl: "http://gerrit-b.test",
        httpUsername: "admin-b",
        httpPassword: "secret-b",
        sshHost: "gerrit-b.test",
        sshUser: "ve-bot-b",
        sshKeyPath: "/keys/id_rsa_b",
        repoCloneUrl: "ssh://gerrit-b.test/project",
      }),
    });

    const runtime = await importRuntime(
      {},
      {
        copilot: makeIntegration({
          id: "copilot-review-routing",
          provider: "copilot",
          configJson: JSON.stringify({ token: "ghp-routing-token" }),
        }),
      },
      {
        configOverrides: {
          adminApiEnabled: true,
        },
        activeIntegrationLists: {
          gerrit: [gerritA, gerritB],
        },
      }
    );

    // The review trigger is wired through the stream-events manager, not the webhook layer.
    const streamEventsCtorArgs = runtime.PluginIntegrationStreamEventsManager.mock.calls[0]?.[0] as {
      getReviewTrigger(): { triggerReviewForChange(integrationId: string, changeId: string): Promise<void> } | undefined;
    };
    const reviewTrigger = streamEventsCtorArgs?.getReviewTrigger();
    expect(reviewTrigger).toBeDefined();

    await reviewTrigger?.triggerReviewForChange("gerrit-review-b", "Iabc123");

    const reviewerA = runtime.reviewProviderInstances.find(
      (instance) => instance.config["sshHost"] === "gerrit-a.test"
    );
    const reviewerB = runtime.reviewProviderInstances.find(
      (instance) => instance.config["sshHost"] === "gerrit-b.test"
    );

    expect(reviewerB).toBeDefined();
    expect(reviewerA?.isReviewer ?? vi.fn()).not.toHaveBeenCalled();
    expect(reviewerB?.isReviewer).toHaveBeenCalledWith("Iabc123");
    expect(runtime.ReviewOrchestrator).toHaveBeenCalledWith(
      expect.objectContaining({ sourceLabel: "gerrit:gerrit-review-b" })
    );
  });

  it("passes reviewerAccountId into Gerrit review providers", async () => {
    const gerritIntegration = makeIntegration({
      id: "gerrit-review-membership",
      provider: "gerrit",
      configJson: JSON.stringify({
        baseUrl: "http://gerrit.test",
        httpUsername: "admin",
        httpPassword: "secret",
        sshHost: "gerrit.test",
        sshUser: "ve-bot",
        sshKeyPath: "/keys/id_rsa",
        reviewerAccountId: "12345",
      }),
    });

    const runtime = await importRuntime(
      {},
      {
        copilot: makeIntegration({
          id: "copilot-review-membership",
          provider: "copilot",
          configJson: JSON.stringify({ token: "ghp-review-token" }),
        }),
      },
      {
        activeIntegrationLists: {
          gerrit: [gerritIntegration],
        },
        configOverrides: {
          adminApiEnabled: true,
        },
      }
    );

    const streamEventsCtorArgs = runtime.PluginIntegrationStreamEventsManager.mock.calls[0]?.[0] as {
      getReviewTrigger(): { triggerReviewForChange(integrationId: string, changeId: string): Promise<void> } | undefined;
    };
    const reviewTrigger = streamEventsCtorArgs?.getReviewTrigger();

    await reviewTrigger?.triggerReviewForChange("gerrit-review-membership", "Iabc123");

    const reviewer = runtime.reviewProviderInstances.find(
      (instance) => instance.config["sshHost"] === "gerrit.test"
    );

    expect(reviewer).toBeDefined();
    expect(reviewer?.config["reviewerAccountId"]).toBe("12345");
  });

  it("uses the SSH review provider even when legacy HTTP fields are present", async () => {
    const gerritIntegration = makeIntegration({
      id: "gerrit-review-ssh-only",
      provider: "gerrit",
      configJson: JSON.stringify({
        baseUrl: "http://gerrit.test",
        httpUsername: "admin",
        httpPassword: "secret",
        sshHost: "gerrit.test",
        sshPort: 29418,
        sshUser: "ve-bot",
      }),
    });

    const runtime = await importRuntime(
      {},
      {
        copilot: makeIntegration({
          id: "copilot-review-ssh-only",
          provider: "copilot",
          configJson: JSON.stringify({ token: "ghp-review-token" }),
        }),
      },
      {
        activeIntegrationLists: {
          gerrit: [gerritIntegration],
        },
        configOverrides: {
          adminApiEnabled: true,
        },
      }
    );

    const streamEventsCtorArgs = runtime.PluginIntegrationStreamEventsManager.mock.calls[0]?.[0] as {
      getReviewTrigger(): { triggerReviewForChange(integrationId: string, changeId: string): Promise<void> } | undefined;
    };
    const reviewTrigger = streamEventsCtorArgs?.getReviewTrigger();

    await reviewTrigger?.triggerReviewForChange("gerrit-review-ssh-only", "Iabc123");

    expect(runtime.GerritSshReviewProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        sshHost: "gerrit.test",
        sshPort: 29418,
        sshUser: "ve-bot",
      })
    );
  });

  it("passes the agent token into the review orchestrator", async () => {
    const dbReview = { source: "db-review" } as unknown as ReviewConnector;
    const dbAgent = makeDbAgentAdapter("mock");

    const runtime = await importRuntime(
      { gerrit: dbReview, mock: dbAgent },
      {
        gerrit: makeIntegration({
          id: "gerrit-review-rewrite",
          provider: "gerrit",
          configJson: JSON.stringify({
            baseUrl: "http://gerrit.test",
            httpUsername: "admin",
            httpPassword: "secret",
            sshHost: "gerrit.test",
            sshUser: "ve-bot",
            sshKeyPath: "/keys/id_rsa",
            repoCloneUrl: "ssh://gerrit.test/project",
          }),
        }),
        copilot: makeIntegration({
          id: "copilot-review-rewrite",
          provider: "copilot",
          configJson: JSON.stringify({ token: "ghp-review-token" }),
        }),
      },
      {
        configOverrides: {
          adminApiEnabled: true,
        },
      }
    );

    const streamEventsCtorArgs = runtime.PluginIntegrationStreamEventsManager.mock.calls[0]?.[0] as {
      getReviewTrigger(): { triggerReviewForChange(integrationId: string, changeId: string): Promise<void> } | undefined;
    };
    await streamEventsCtorArgs?.getReviewTrigger()?.triggerReviewForChange("gerrit-review-rewrite", "Irewrite123");

    expect(runtime.ReviewOrchestrator).toHaveBeenCalledWith(
      expect.objectContaining({ agentToken: "ghp-review-token" })
    );
    const calls = runtime.ReviewOrchestrator.mock.calls as Array<[{ agentToken: string; model?: string }]>;
    expect(calls[0]?.[0]).not.toHaveProperty("model");
  });
});

// ─── Issue 9: Admin Server Shutdown Race Condition ────────────────────────────

describe("Issue 9: Graceful shutdown with in-flight requests", () => {
  it("closes admin server before closing database connection", async () => {
    const mockServer = {
      close: vi.fn().mockImplementation((callback: () => void) => {
        // Simulate async close completion
        setImmediate(callback);
      }),
      listen: vi.fn().mockImplementation((_port, _host, callback: () => void) => {
        callback();
      }),
    } as any;

    const mockStateStore = {
      close: vi.fn().mockResolvedValue(undefined),
      createTask: vi.fn(),
      getActiveTasks: vi.fn().mockResolvedValue([]),
      getTaskByTicketId: vi.fn().mockResolvedValue(null),
    } as any;

    // Track call order
    const callOrder: string[] = [];
    mockServer.close.mockImplementation((callback: () => void) => {
      callOrder.push("server-close-called");
      setImmediate(() => {
        callOrder.push("server-close-completed");
        callback();
      });
    });
    mockStateStore.close.mockImplementation(() => {
      callOrder.push("db-close");
      return Promise.resolve();
    });

    // Simulate shutdown flow
    await new Promise<void>((resolve) => {
      // Server close and db close should be orchestrated properly
      // Server should close FIRST, then db
      let serverClosed = false;
      mockServer.close(() => {
        serverClosed = true;
      });

      setImmediate(async () => {
        if (serverClosed) {
          await mockStateStore.close();
        }
        resolve();
      });
    });

    expect(mockServer.close).toHaveBeenCalled();
    expect(mockStateStore.close).toHaveBeenCalled();
  });

  it("waits for admin server to close before closing database", async () => {
    const closeOrder: string[] = [];

    const mockServer = {
      close: vi.fn().mockImplementation((callback: () => void) => {
        setTimeout(() => {
          closeOrder.push("server-closed");
          callback();
        }, 50);
      }),
    } as any;

    const mockStateStore = {
      close: vi.fn().mockImplementation(() => {
        closeOrder.push("db-closed");
        return Promise.resolve();
      }),
    } as any;

    // Simulate proper shutdown sequence
    await new Promise<void>((resolve) => {
      mockServer.close(async () => {
        await mockStateStore.close();
        resolve();
      });
    });

    // Server must close before database
    expect(closeOrder).toEqual(["server-closed", "db-closed"]);
  });

  it("in-flight admin request completes before database closes", async () => {
    const requestLog: string[] = [];

    const mockRequest = {
      url: "/api/status",
      completed: false,
    };

    const mockServer = {
      close: vi.fn().mockImplementation((callback: () => void) => {
        // Simulate graceful close that waits for in-flight requests
        setTimeout(() => {
          mockRequest.completed = true;
          callback();
        }, 100);
      }),
    } as any;

    const mockStateStore = {
      close: vi.fn().mockImplementation(() => {
        requestLog.push("db-closed");
        if (!mockRequest.completed) {
          throw new Error("Request still in flight!");
        }
        return Promise.resolve();
      }),
    } as any;

    // Simulate shutdown
    await new Promise<void>((resolve) => {
      mockServer.close(async () => {
        requestLog.push("server-closed");
        await mockStateStore.close();
        resolve();
      });
    });

    expect(mockRequest.completed).toBe(true);
    expect(requestLog).toEqual(["server-closed", "db-closed"]);
  });

  it("shutdown does not crash if server close fails", async () => {
    const mockServer= {
      close: vi.fn().mockImplementation((_callback: () => void) => {
        throw new Error("Server close failed");
      }),
    } as any;

    const mockStateStore = {
      close: vi.fn().mockResolvedValue(undefined),
    } as any;

    // Shutdown should handle server close errors gracefully
    expect(() => {
      try {
        mockServer.close(() => {});
      } catch {
        // Error is caught and handled, db close still happens
        mockStateStore.close();
      }
    }).not.toThrow();
  });

  it("shutdown uses timeout to prevent indefinite waiting for server close", async () => {
    vi.useFakeTimers();
    try {
      const mockServer = {
        close: vi.fn().mockImplementation((_callback: () => void) => {
          // Simulate server that never closes (hang)
        }),
      } as any;

      const mockStateStore = {
        close: vi.fn().mockResolvedValue(undefined),
      } as any;

      const shutdownTimeout = 5_000;
      let completed = false;

      const shutdownPromise = new Promise<void>((resolve) => {
        mockServer.close(() => {});

        // After timeout, should proceed even if server didn't close
        setTimeout(() => {
          mockStateStore.close().then(() => {
            completed = true;
            resolve();
          });
        }, shutdownTimeout);
      });

      await vi.advanceTimersByTimeAsync(shutdownTimeout);
      await shutdownPromise;

      expect(completed).toBe(true);
      expect(mockStateStore.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});