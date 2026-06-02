import { execFile } from "child_process";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import { createAdminServer } from "../../src/admin/adminServer.js";
import type { AdminServerDependencies } from "../../src/admin/adminServer.js";
import type { Integration, IntegrationStore } from "../../src/interfaces.js";
import { registerBuiltinPlugins } from "../../src/plugins/init.js";
import { PluginManager } from "../../src/plugins/pluginManager.js";
import { jsonResponse, errorResponse } from "./helpers/fixtures.js";
import { fetchAvailableModelsWithPat } from "../../src/agents/copilotModelsService.js";

vi.mock("child_process", () => ({ execFile: vi.fn() }));

// Partially mock copilotModelsService: keep exchange + HTTP-based fetch real
// (they use globalThis.fetch which is mocked per-test), but replace the SDK-
// based PAT function with a vi.fn() to avoid spawning the copilot CLI process.
vi.mock("../../src/agents/copilotModelsService.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/agents/copilotModelsService.js")>();
  return { ...actual, fetchAvailableModelsWithPat: vi.fn() };
});

type ExecFileCallback = (error: Error | null, result: { stdout: string; stderr: string }) => void;

function getExecFileMock(): ReturnType<typeof vi.fn> {
  return execFile as unknown as ReturnType<typeof vi.fn>;
}

interface DiscoveryStore extends IntegrationStore {
  setIntegrationDiscoveredResources(id: string, json: string): Promise<void>;
  getIntegrationDiscoveredResources(id: string): Promise<{ json: string | null; at: Date | null }>;
}

function makeIntegrationStore(initial: Integration[] = []): DiscoveryStore {
  const data = new Map<string, Integration>();
  for (const i of initial) data.set(i.id, { ...i });

  return {
    getIntegrations: async () => [...data.values()],
    getIntegration: async (id) => data.get(id) ?? null,
    upsertIntegration: async (inp) => {
      const now = new Date();
      const existing = data.get(inp.id);
      const next: Integration = {
        ...inp,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        discoveredResourcesJson:
          inp.discoveredResourcesJson ?? existing?.discoveredResourcesJson ?? null,
        discoveredAt: inp.discoveredAt ?? existing?.discoveredAt ?? null,
      };
      data.set(inp.id, next);
      return next;
    },
    deleteIntegration: async (id) => { data.delete(id); },
    setIntegrationEnabled: async (id, enabled) => {
      const existing = data.get(id);
      if (!existing) throw new Error(`not found: ${id}`);
      existing.enabled = enabled;
      existing.updatedAt = new Date();
      return existing;
    },
    setIntegrationDiscoveredResources: async (id, json) => {
      const existing = data.get(id);
      if (!existing) throw new Error(`not found: ${id}`);
      existing.discoveredResourcesJson = json;
      existing.discoveredAt = new Date();
      existing.updatedAt = new Date();
    },
    getIntegrationDiscoveredResources: async (id) => {
      const existing = data.get(id);
      if (!existing) return { json: null, at: null };
      return {
        json: existing.discoveredResourcesJson ?? null,
        at: existing.discoveredAt ?? null,
      };
    },
    clearIntegrationDiscoveredResources: async (id) => {
      const existing = data.get(id);
      if (!existing) return;
      existing.discoveredResourcesJson = null;
      existing.discoveredAt = null;
      existing.updatedAt = new Date();
    },
    countIntegrationReferences: async () => 0,
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
      pauseTask: vi.fn(async () => { throw new Error("nope"); }),
      resumeTask: vi.fn(async () => { throw new Error("nope"); }),
      retryTask: vi.fn(async () => { throw new Error("nope"); }),
      abandonTask: vi.fn(async () => { throw new Error("nope"); }),
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
    polling: {
      isRunning: () => false,
      getIntervals: () => ({ intervalMs: 30000 }),
    },
    providers: [],
    ...overrides,
  };
}

async function listenServer(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("not bound");
  return `http://127.0.0.1:${addr.port}`;
}

async function postJson(baseUrl: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, { method: "POST" });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

async function getJson(baseUrl: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`);
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

async function putJson(
  baseUrl: string,
  path: string,
  payload: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

const REDMINE_INTEGRATION: Integration = {
  id: "int-redmine",
  type: "redmine",
  name: "Redmine Test",
  configJson: JSON.stringify({
    baseUrl: "http://redmine.test",
    apiKey: "secret",
    virtualEngineerUserLogin: "ve",
    closedStatusId: 5,
    inProgressStatusId: 2,
    inReviewStatusId: 4,
  }),
  enabled: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const COPILOT_INTEGRATION: Integration = {
  id: "int-copilot",
  type: "copilot",
  name: "Copilot Test",
  configJson: JSON.stringify({ sessionToken: "enc_secret" }),
  enabled: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_INTEGRATION: Integration = {
  id: "int-mock",
  type: "mock",
  name: "Mock Test",
  configJson: JSON.stringify({ status: "success" }),
  enabled: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const GERRIT_INTEGRATION: Integration = {
  id: "int-gerrit",
  type: "gerrit",
  name: "Gerrit Test",
  configJson: JSON.stringify({
    baseUrl: "http://gerrit.test:8080",
    httpUsername: "admin",
    httpPassword: "secret",
    sshHost: "gerrit.test",
    sshPort: 29418,
    sshUser: "ve",
    sshKeyPath: "/keys/id_rsa",
    repoCloneUrl: "ssh://ve@gerrit.test:29418/demo",
  }),
  enabled: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("Admin API — POST /api/admin/integrations/:id/discover", () => {
  let server: Server;
  let baseUrl: string;
  let store: DiscoveryStore;
  let fetchMock: ReturnType<typeof vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>>;
  let realFetch: typeof fetch;

  beforeEach(async () => {
    registerBuiltinPlugins();
    store = makeIntegrationStore([REDMINE_INTEGRATION, COPILOT_INTEGRATION, GERRIT_INTEGRATION, MOCK_INTEGRATION]);
    const pm = new PluginManager(store);
    server = createAdminServer(makeBaseDeps({ integrationStore: store, pluginManager: pm }));
    baseUrl = await listenServer(server);
    realFetch = globalThis.fetch.bind(globalThis);
    fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();
    vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (u.startsWith(baseUrl)) {
        return realFetch(url as RequestInfo, init);
      }
      return fetchMock(url, init);
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("happy path: persists snapshot and returns counts", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        projects: [
          { id: 1, identifier: "demo", name: "Demo" },
          { id: 2, identifier: "infra", name: "Infrastructure" },
        ],
        total_count: 2,
      })
    );

    const { status, body } = await postJson(baseUrl, "/api/admin/integrations/int-redmine/discover");
    expect(status).toBe(200);
    expect(body["ok"]).toBe(true);
    expect(typeof body["discoveredAt"]).toBe("string");
    expect(body["counts"]).toEqual({ ticketProjects: 2, repositories: 0 });

    const { json } = await store.getIntegrationDiscoveredResources("int-redmine");
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json as string) as Record<string, unknown>;
    expect((parsed["ticketProjects"] as unknown[]).length).toBe(2);
  });

  it("happy path for Gerrit over SSH discovery", async () => {
    getExecFileMock().mockImplementationOnce(
      (_file: unknown, _args: unknown, _options: unknown, callback: ExecFileCallback) => {
        callback(null, {
          stdout: JSON.stringify({
            demo: { state: "ACTIVE", HEAD: "refs/heads/main" },
          }),
          stderr: "",
        });
        return undefined;
      }
    );

    const { status, body } = await postJson(baseUrl, "/api/admin/integrations/int-gerrit/discover");
    expect(status).toBe(200);
    expect(body["counts"]).toEqual({ ticketProjects: 0, repositories: 1 });
  });

  it("returns 400 when descriptor doesn't support discovery (mock)", async () => {
    const { status, body } = await postJson(baseUrl, "/api/admin/integrations/int-mock/discover");
    expect(status).toBe(400);
    expect(String(body["error"])).toContain("does not support");
  });

  it("returns 404 for unknown integration id", async () => {
    const { status } = await postJson(baseUrl, "/api/admin/integrations/no-such/discover");
    expect(status).toBe(404);
  });

  it("returns 502 when discovery throws (e.g. 401 from upstream)", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(401, "unauthorized"));
    const { status, body } = await postJson(baseUrl, "/api/admin/integrations/int-redmine/discover");
    expect(status).toBe(502);
    expect(String(body["error"])).toContain("Discovery failed");
    // Ensure the persisted snapshot was NOT updated
    const { json } = await store.getIntegrationDiscoveredResources("int-redmine");
    expect(json).toBeNull();
  });

  it("GET /api/admin/integrations/:id includes discoveredAt and discoveredResources", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        projects: [{ id: 1, identifier: "x", name: "X" }],
        total_count: 1,
      })
    );
    await postJson(baseUrl, "/api/admin/integrations/int-redmine/discover");

    const { status, body } = await getJson(baseUrl, "/api/admin/integrations/int-redmine");
    expect(status).toBe(200);
    const integration = body["integration"] as Record<string, unknown>;
    expect(integration["discoveredAt"]).toEqual(expect.any(String));
    const resources = integration["discoveredResources"] as Record<string, unknown>;
    expect(resources).not.toBeNull();
    expect((resources["ticketProjects"] as unknown[]).length).toBe(1);
    expect(integration["discoverySupported"]).toBe(true);
  });

  it("GET /api/admin/integrations/:id reports null when never discovered", async () => {
    const { status, body } = await getJson(baseUrl, "/api/admin/integrations/int-redmine");
    expect(status).toBe(200);
    const integration = body["integration"] as Record<string, unknown>;
    expect(integration["discoveredAt"]).toBeNull();
    expect(integration["discoveredResources"]).toBeNull();
    expect(integration["discoverySupported"]).toBe(true);
  });

  it("GET reports discoverySupported=false for mock", async () => {
    const { body } = await getJson(baseUrl, "/api/admin/integrations/int-mock");
    const integration = body["integration"] as Record<string, unknown>;
    expect(integration["discoverySupported"]).toBe(false);
  });

  it("GET reports discoverySupported=false for copilot", async () => {
    const { body } = await getJson(baseUrl, "/api/admin/integrations/int-copilot");
    const integration = body["integration"] as Record<string, unknown>;
    expect(integration["discoverySupported"]).toBe(false);
  });

  it("PUT clears the discovered-resources cache when the config changes", async () => {
    // Given a discovery snapshot from a previous (stale) config
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ projects: [{ id: 1, identifier: "old", name: "Old" }], total_count: 1 })
    );
    await postJson(baseUrl, "/api/admin/integrations/int-redmine/discover");
    expect((await store.getIntegrationDiscoveredResources("int-redmine")).json).not.toBeNull();

    // When the integration config is edited (e.g. a new API key)
    const { status } = await putJson(baseUrl, "/api/admin/integrations/int-redmine", {
      config: { apiKey: "rotated-secret" },
    });
    expect(status).toBe(200);

    // Then the stale snapshot is invalidated so the next discovery uses the new config
    expect((await store.getIntegrationDiscoveredResources("int-redmine")).json).toBeNull();
  });

  it("PUT keeps the discovered-resources cache when the config is unchanged", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ projects: [{ id: 1, identifier: "keep", name: "Keep" }], total_count: 1 })
    );
    await postJson(baseUrl, "/api/admin/integrations/int-redmine/discover");
    expect((await store.getIntegrationDiscoveredResources("int-redmine")).json).not.toBeNull();

    // Editing only the name (no config field) must not wipe discovery
    const { status } = await putJson(baseUrl, "/api/admin/integrations/int-redmine", {
      name: "Renamed Redmine",
    });
    expect(status).toBe(200);

    expect((await store.getIntegrationDiscoveredResources("int-redmine")).json).not.toBeNull();
  });

  it("Copilot PAT mode: discover resolves models using PAT directly", async () => {
    await store.upsertIntegration({
      id: "int-copilot-pat",
      type: "copilot",
      name: "Copilot PAT",
      configJson: JSON.stringify({ authMode: "pat", token: "github_pat_test123" }),
      enabled: false,
    });
    // PAT mode uses SDK (CLI subprocess) — mock it to avoid spawning copilot CLI
    vi.mocked(fetchAvailableModelsWithPat).mockResolvedValueOnce([
      { id: "gpt-4o", name: "GPT-4o", vendor: "Microsoft", version: "gpt-4o", category: "versatile" },
    ]);

    const { status, body } = await postJson(baseUrl, "/api/admin/integrations/int-copilot-pat/discover");
    expect(status).toBe(200);
    expect(body["ok"]).toBe(true);
    expect(body["counts"]).toEqual({ models: 1 });
    // SDK path calls no HTTP fetch
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Copilot PAT mode: discover returns 400 when token is missing", async () => {
    await store.upsertIntegration({
      id: "int-copilot-no-token",
      type: "copilot",
      name: "Copilot no token",
      configJson: JSON.stringify({ authMode: "pat" }),
      enabled: false,
    });

    const { status, body } = await postJson(baseUrl, "/api/admin/integrations/int-copilot-no-token/discover");
    expect(status).toBe(400);
    expect(String(body["error"])).toContain("No PAT");
  });

  it("Copilot OAuth mode: discover returns 400 when sessionToken is missing", async () => {
    await store.upsertIntegration({
      id: "int-copilot-oauth-empty",
      type: "copilot",
      name: "Copilot OAuth no token",
      configJson: JSON.stringify({ authMode: "oauth" }),
      enabled: false,
    });

    const { status, body } = await postJson(baseUrl, "/api/admin/integrations/int-copilot-oauth-empty/discover");
    expect(status).toBe(400);
    expect(String(body["error"])).toContain("OAuth");
  });
});
