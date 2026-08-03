import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { createAdminServer, type AdminServerDependencies } from "../../src/admin/adminServer.js";
import { Router } from "../../src/admin/router.js";
import { registerProjectRoutes, type SkillSource } from "../../src/admin/adminProjectsRoutes.js";
import { makeProjectId, type AgentRecord, type AgentType } from "../../src/interfaces.js";
import { registerBuiltinPlugins } from "../../src/plugins/init.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

function tempDbPath(): string {
  return tempDatabasePath("ve-admin-projects");
}

interface FetchResult { status: number; body: Record<string, unknown> | null; }

async function rest(server: Server, path: string, opts: { method?: string; body?: unknown } = {}): Promise<FetchResult> {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Server not bound");
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const init: RequestInit = { method: opts.method ?? "GET" };
  if (opts.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  if (text) {
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* leave null */ }
  }
  return { status: res.status, body: parsed };
}

function makeDeps(
  store: SqliteStateStore,
  validateSkillSourcesConnection: (sources: SkillSource[]) => Promise<void> = async () => {}
): AdminServerDependencies {
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
    allowUnauthenticatedAdmin: true,
    agentStore: store,
    projectStore: store,
    integrationStore: store,
    config: {
      nodeEnv: "test",
      logLevel: "error",
      maxAgentCycles: 3,
      maxRetryAttempts: 5,
      pollingIntervalMs: 30000,
    },
    polling: { isRunning: () => false, getIntervals: () => ({ intervalMs: 30000 }) },
    providers: [],
    projectRoutes: { validateSkillSourcesConnection },
  };
}

async function makeAgent(store: SqliteStateStore, type: AgentType = "coding"): Promise<AgentRecord> {
  return store.createAgent({
    name: `${type}-bot`, type, modelConfigJson: "{}", enabled: true,
    systemPromptId: "system_generic_code", instructionsPromptId: "instructions_generic_code",
  });
}

async function seedIntegration(store: SqliteStateStore, id: string, provider: "redmine" | "gerrit" | "github" = "redmine"): Promise<void> {
  await store.upsertIntegration({ id, provider, name: id, configJson: "{}", enabled: true });
}

describe("Admin API — Project routes (/api/admin/projects)", () => {
  let store: SqliteStateStore;
  let server: Server;

  beforeEach(async () => {
    registerBuiltinPlugins();
    store = await SqliteStateStore.create(tempDbPath());
    const deps = makeDeps(store);
    server = createAdminServer(deps);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    store.close();
  });

  it("registers project-scoped skill source listing for edits", () => {
    const router = new Router();
    registerProjectRoutes(router, {});

    const scoped = router.match("POST", "/api/admin/projects/project-1/skill-sources/list");
    const global = router.match("POST", "/api/admin/projects/skill-sources/list");
    const resolver = router.match("POST", "/api/admin/projects/resolve-repositories");
    const scanner = router.match("POST", "/api/admin/projects/scan-push-targets");

    expect(scoped?.meta).toMatchObject({ permission: "project.write", resourceParam: "id" });
    expect(scoped?.params["id"]).toBe("project-1");
    expect(global?.meta).toMatchObject({ permission: "project.write" });
    expect(global?.meta.resourceParam).toBeUndefined();
    expect(resolver?.meta).toMatchObject({ permission: "integration.read" });
    expect(scanner?.meta).toMatchObject({ permission: "integration.read" });
  });

  it("POST /scan-push-targets reads manifests and resolves detected repositories", async () => {
    await store.upsertIntegration({
      id: "gitlab-1",
      provider: "gitlab",
      name: "Primary GitLab",
      configJson: JSON.stringify({
        baseUrl: "https://gitlab.test",
        gitlabMode: "self-hosted",
        authMode: "pat",
        token: "test-token",
      }),
      enabled: true,
    });
    await store.setIntegrationDiscoveredResources("gitlab-1", JSON.stringify({
      discoveredAt: new Date().toISOString(),
      repositories: [
        { key: "platform/root", name: "root", cloneUrlHttp: "https://gitlab.test/platform/root.git", defaultBranch: "main" },
        { key: "platform/runtime", name: "runtime", cloneUrlHttp: "https://gitlab.test/platform/runtime.git", defaultBranch: "stable" },
      ],
    }));
    const realFetch = globalThis.fetch.bind(globalThis);
    const providerFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { path: ".gitmodules", type: "blob" },
        { path: "README.md", type: "blob" },
      ]), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(`
[submodule "runtime"]
  path = libs/runtime
  url = ../runtime.git
  branch = stable
`, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return url.startsWith("http://127.0.0.1:")
        ? realFetch(input as Parameters<typeof fetch>[0], init)
        : providerFetch(input, init);
    });

    try {
      const result = await rest(server, "/api/admin/projects/scan-push-targets", {
        method: "POST",
        body: {
          integrationId: "gitlab-1",
          repoKey: "platform/root",
          cloneUrl: "https://gitlab.test/platform/root.git",
          revision: "main",
        },
      });

      expect(result.status).toBe(200);
      expect(result.body?.["manifestFiles"]).toEqual([".gitmodules"]);
      expect(result.body?.["repositories"]).toEqual([{
        cloneUrl: "https://gitlab.test/platform/runtime.git",
        localPath: "libs/runtime",
        revision: "stable",
        relation: "gitlink",
        sourcePath: ".gitmodules",
        origin: "fork_pushable",
        resolution: {
          cloneUrl: "https://gitlab.test/platform/runtime.git",
          localPath: "libs/runtime",
          status: "matched",
          match: {
            integrationId: "gitlab-1",
            integrationName: "Primary GitLab",
            provider: "gitlab",
            repoKey: "platform/runtime",
            enabled: true,
          },
          candidates: [],
        },
      }]);
      expect(providerFetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("POST /scan-push-targets follows matched gitlinks to discover Jami contrib dependencies", async () => {
    await store.upsertIntegration({
      id: "gitlab-1",
      provider: "gitlab",
      name: "Jami GitLab",
      configJson: JSON.stringify({ baseUrl: "https://git.jami.net", gitlabMode: "self-hosted", authMode: "pat", token: "test-token" }),
      enabled: true,
    });
    await store.upsertIntegration({
      id: "github-1",
      provider: "github",
      name: "GitHub",
      configJson: JSON.stringify({ mode: "github.com", token: "test-token" }),
      enabled: true,
    });
    await store.setIntegrationDiscoveredResources("gitlab-1", JSON.stringify({
      discoveredAt: new Date().toISOString(),
      repositories: [
        { key: "savoirfairelinux/jami-client-qt", name: "jami-client-qt", cloneUrlHttp: "https://git.jami.net/savoirfairelinux/jami-client-qt.git" },
        { key: "savoirfairelinux/jami-daemon", name: "jami-daemon", cloneUrlHttp: "https://git.jami.net/savoirfairelinux/jami-daemon.git" },
      ],
    }));
    await store.setIntegrationDiscoveredResources("github-1", JSON.stringify({
      discoveredAt: new Date().toISOString(),
      repositories: [
        { key: "savoirfairelinux/opendht", name: "opendht", cloneUrlHttp: "https://github.com/savoirfairelinux/opendht.git" },
        { key: "google/googletest", name: "googletest", cloneUrlHttp: "https://github.com/google/googletest.git" },
      ],
    }));
    const realFetch = globalThis.fetch.bind(globalThis);
    const providerFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ path: ".gitmodules", type: "blob" }]), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(`
[submodule "daemon"]
  path = daemon
  url = ../jami-daemon.git
`, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { path: "contrib/src/opendht/package.json", type: "blob" },
        { path: "tests/CMakeLists.txt", type: "blob" },
      ]), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "opendht",
        version: "4.2.0",
        url: "https://github.com/savoirfairelinux/opendht/archive/v__VERSION__.tar.gz",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(`
FetchContent_Declare(googletest
  URL https://github.com/google/googletest/archive/refs/tags/release-1.11.0.zip
)
`, { status: 200 }));
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return url.startsWith("http://127.0.0.1:")
        ? realFetch(input as Parameters<typeof fetch>[0], init)
        : providerFetch(input, init);
    });

    try {
      const result = await rest(server, "/api/admin/projects/scan-push-targets", {
        method: "POST",
        body: {
          integrationId: "gitlab-1",
          repoKey: "savoirfairelinux/jami-client-qt",
          cloneUrl: "https://git.jami.net/savoirfairelinux/jami-client-qt.git",
          revision: "main",
        },
      });

      expect(result.status).toBe(200);
      expect(result.body?.["manifestFiles"]).toEqual([
        ".gitmodules",
        "daemon/contrib/src/opendht/package.json",
        "daemon/tests/CMakeLists.txt",
      ]);
      expect(result.body?.["repositories"]).toEqual(expect.arrayContaining([
        expect.objectContaining({ localPath: "daemon", sourcePath: ".gitmodules" }),
        expect.objectContaining({
          cloneUrl: "https://github.com/savoirfairelinux/opendht.git",
          localPath: "daemon/opendht",
          sourcePath: "daemon/contrib/src/opendht/package.json",
          resolution: expect.objectContaining({ status: "matched" }),
        }),
        expect.objectContaining({
          cloneUrl: "https://github.com/google/googletest.git",
          localPath: "daemon/googletest",
          sourcePath: "daemon/tests/CMakeLists.txt",
          resolution: expect.objectContaining({ status: "matched" }),
        }),
      ]));
      expect(providerFetch).toHaveBeenCalledTimes(5);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stores and reads back project vendor components", async () => {
    const agent = await makeAgent(store);
    const project = await store.createProject({ name: "P", type: "coding", agentId: agent.id });

    const saved = await rest(server, `/api/admin/projects/${project.id}/vendor-components`, {
      method: "PUT",
      body: {
        components: [
          { sourcePath: "kas/config.yaml", localPath: "layers/poky", cloneUrl: "https://git.yoctoproject.org/git/poky", origin: "patch_required", note: "apply .bbappend" },
          { sourcePath: "daemon/contrib/src/fmt/package.json", origin: "internal" },
        ],
      },
    });

    expect(saved.status).toBe(200);
    const read = await rest(server, `/api/admin/projects/${project.id}/vendor-components`);
    expect(read.status).toBe(200);
    expect((read.body?.["components"] as Array<Record<string, unknown>>).map((c) => [c["sourcePath"], c["origin"], c["note"]])).toEqual([
      ["daemon/contrib/src/fmt/package.json", "internal", ""],
      ["kas/config.yaml", "patch_required", "apply .bbappend"],
    ]);
  });

  it("stores blank vendor component metadata as absent rather than empty", async () => {
    const agent = await makeAgent(store);
    const project = await store.createProject({ name: "P", type: "coding", agentId: agent.id });

    const saved = await rest(server, `/api/admin/projects/${project.id}/vendor-components`, {
      method: "PUT",
      body: { components: [{ sourcePath: "kas/config.yaml", localPath: "  ", cloneUrl: "", revision: "", origin: "patch_required" }] },
    });

    expect(saved.status).toBe(200);
    const read = await rest(server, `/api/admin/projects/${project.id}/vendor-components`);
    expect((read.body?.["components"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      localPath: null,
      cloneUrl: null,
      revision: null,
    });
  });

  it("rejects duplicate vendor component source paths", async () => {
    const agent = await makeAgent(store);
    const project = await store.createProject({ name: "P", type: "coding", agentId: agent.id });

    const result = await rest(server, `/api/admin/projects/${project.id}/vendor-components`, {
      method: "PUT",
      body: { components: [{ sourcePath: "a.yaml", origin: "internal" }, { sourcePath: "a.yaml", origin: "internal" }] },
    });

    expect(result.status).toBe(400);
  });

  it("POST /resolve-repositories matches an existing integration by canonical clone URL", async () => {
    await seedIntegration(store, "gerrit-1", "gerrit");
    await store.setIntegrationDiscoveredResources("gerrit-1", JSON.stringify({
      discoveredAt: new Date().toISOString(),
      repositories: [{
        key: "platform/runtime",
        name: "runtime",
        cloneUrlSsh: "ssh://git@gerrit.example.com:29418/platform/runtime.git",
      }],
    }));

    const result = await rest(server, "/api/admin/projects/resolve-repositories", {
      method: "POST",
      body: {
        repositories: [{
          cloneUrl: "https://gerrit.example.com/platform/runtime",
          localPath: "runtime",
        }],
      },
    });

    expect(result.status).toBe(200);
    expect(result.body?.["repositories"]).toEqual([{
      cloneUrl: "https://gerrit.example.com/platform/runtime",
      localPath: "runtime",
      status: "matched",
      match: {
        integrationId: "gerrit-1",
        integrationName: "gerrit-1",
        provider: "gerrit",
        repoKey: "platform/runtime",
        enabled: true,
      },
      candidates: [],
    }]);
  });

  it("POST /resolve-repositories reports ambiguous matches without choosing an integration", async () => {
    for (const integrationId of ["gerrit-a", "gerrit-b"]) {
      await seedIntegration(store, integrationId, "gerrit");
      await store.setIntegrationDiscoveredResources(integrationId, JSON.stringify({
        discoveredAt: new Date().toISOString(),
        repositories: [{
          key: "platform/runtime",
          name: "runtime",
          cloneUrlSsh: "git@gerrit.example.com:platform/runtime.git",
        }],
      }));
    }

    const result = await rest(server, "/api/admin/projects/resolve-repositories", {
      method: "POST",
      body: { repositories: [{ cloneUrl: "https://gerrit.example.com/platform/runtime.git" }] },
    });

    expect(result.status).toBe(200);
    const repositories = result.body?.["repositories"] as Array<Record<string, unknown>>;
    expect(repositories[0]?.["status"]).toBe("ambiguous");
    expect(repositories[0]?.["match"]).toBeNull();
    expect(repositories[0]?.["candidates"]).toEqual([
      expect.objectContaining({ integrationId: "gerrit-a", repoKey: "platform/runtime" }),
      expect.objectContaining({ integrationId: "gerrit-b", repoKey: "platform/runtime" }),
    ]);
  });

  it("POST /resolve-repositories preserves repositories without a known integration", async () => {
    await seedIntegration(store, "gerrit-1", "gerrit");

    const result = await rest(server, "/api/admin/projects/resolve-repositories", {
      method: "POST",
      body: { repositories: [{ cloneUrl: "https://unknown.example.com/team/api", localPath: "api" }] },
    });

    expect(result.status).toBe(200);
    expect(result.body?.["repositories"]).toEqual([{
      cloneUrl: "https://unknown.example.com/team/api",
      localPath: "api",
      status: "unmatched",
      match: null,
      candidates: [],
    }]);
  });

  it("POST /skill-sources/list rejects SSH sources without SSH auth", async () => {
    const originalSshAuthSock = process.env["SSH_AUTH_SOCK"];
    delete process.env["SSH_AUTH_SOCK"];
    try {
      const r = await rest(server, "/api/admin/projects/skill-sources/list", {
        method: "POST",
        body: { source: "ssh://skills.example.com/org/agent-skills" },
      });

      expect(r.status).toBe(400);
      expect(r.body?.["error"]).toMatch(/SSH_AUTH_SOCK/);
    } finally {
      if (originalSshAuthSock === undefined) delete process.env["SSH_AUTH_SOCK"];
      else process.env["SSH_AUTH_SOCK"] = originalSshAuthSock;
    }
  });

  it("POST /skill-sources/list treats unreadable known_hosts as a client error", async () => {
    const originalSshAuthSock = process.env["SSH_AUTH_SOCK"];
    process.env["SSH_AUTH_SOCK"] = "/tmp/ve-test-ssh.sock";
    try {
      const r = await rest(server, "/api/admin/projects/skill-sources/list", {
        method: "POST",
        body: {
          source: "ssh://skills.example.com/org/agent-skills",
          sshKnownHostsPath: "/app/secrets/virtual-engineer-missing-known-hosts",
        },
      });

      expect(r.status).toBe(400);
      expect(r.body?.["error"]).toMatch(/known_hosts path is not readable/);
    } finally {
      if (originalSshAuthSock === undefined) delete process.env["SSH_AUTH_SOCK"];
      else process.env["SSH_AUTH_SOCK"] = originalSshAuthSock;
    }
  });

  it("POST /skill-sources/list rejects empty SSH option strings", async () => {
    const r = await rest(server, "/api/admin/projects/skill-sources/list", {
      method: "POST",
      body: { source: "ssh://skills.example.com/org/agent-skills", sshUser: "  " },
    });

    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/SSH user must not be empty/);
  });

  it("POST /skill-sources/list rejects SSH ports outside the TCP range", async () => {
    const r = await rest(server, "/api/admin/projects/skill-sources/list", {
      method: "POST",
      body: { source: "ssh://skills.example.com/org/agent-skills", sshPort: 294193 },
    });

    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/SSH port must be between 1 and 65535/);
  });

  it("POST /skill-sources/list treats malformed SSH URLs as client errors", async () => {
    const originalSshAuthSock = process.env["SSH_AUTH_SOCK"];
    process.env["SSH_AUTH_SOCK"] = "/tmp/ve-test-ssh.sock";
    try {
      const r = await rest(server, "/api/admin/projects/skill-sources/list", {
        method: "POST",
        body: { source: "ssh://", sshPort: 29418 },
      });

      expect(r.status).toBe(400);
      expect(r.body?.["error"]).toMatch(/Invalid SSH skill source URL/);
    } finally {
      if (originalSshAuthSock === undefined) delete process.env["SSH_AUTH_SOCK"];
      else process.env["SSH_AUTH_SOCK"] = originalSshAuthSock;
    }
  });

  it("POST /skill-sources/list treats conflicting SSH ports as client errors", async () => {
    const originalSshAuthSock = process.env["SSH_AUTH_SOCK"];
    process.env["SSH_AUTH_SOCK"] = "/tmp/ve-test-ssh.sock";
    try {
      const r = await rest(server, "/api/admin/projects/skill-sources/list", {
        method: "POST",
        body: { source: "ssh://skills.example.com:2222/org/agent-skills", sshPort: 29418 },
      });

      expect(r.status).toBe(400);
      expect(r.body?.["error"]).toMatch(/Conflicting SSH ports/);
    } finally {
      if (originalSshAuthSock === undefined) delete process.env["SSH_AUTH_SOCK"];
      else process.env["SSH_AUTH_SOCK"] = originalSshAuthSock;
    }
  });

  it("GET / returns empty initially", async () => {
    const r = await rest(server, "/api/admin/projects");
    expect(r.status).toBe(200);
    expect(r.body?.["projects"]).toEqual([]);
  });

  it("POST / creates a coding project with ticket source and 2 push targets", async () => {
    const agent = await makeAgent(store, "coding");
    await seedIntegration(store, "redmine-1", "redmine");
    await seedIntegration(store, "gerrit-1", "gerrit");
    const r = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "coding",
        name: "App",
        agentId: agent.id,
        ticketSource: { integrationId: "redmine-1", ticketProjectKey: "PLATFORM" },
        pushTargets: [
          { integrationId: "gerrit-1", repoKey: "superproject", cloneUrl: "ssh://g/super", targetBranch: "main", role: "primary", commitOrder: 1, localPath: "." },
          { integrationId: "gerrit-1", repoKey: "core-lib", cloneUrl: "ssh://g/core", targetBranch: "main", role: "submodule", commitOrder: 2, localPath: "libs/core" },
        ],
      },
    });
    expect(r.status).toBe(201);
    const project = r.body?.["project"] as Record<string, unknown>;
    expect(project["name"]).toBe("App");
    expect(project["type"]).toBe("coding");
    expect(project["pushTargetCount"]).toBe(2);
    const pts = project["pushTargets"] as Array<Record<string, unknown>>;
    expect(pts).toHaveLength(2);
    expect(pts[0]?.["commitOrder"]).toBe(1);
    expect(pts[1]?.["commitOrder"]).toBe(2);
    const ts = project["ticketSource"] as Record<string, unknown>;
    expect((ts["integration"] as Record<string, unknown>)["id"]).toBe("redmine-1");
  });

  it("POST / persists vendor components together with the project", async () => {
    const agent = await makeAgent(store, "coding");
    await seedIntegration(store, "redmine-1", "redmine");
    await seedIntegration(store, "gerrit-1", "gerrit");
    const r = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "coding",
        name: "Yocto",
        agentId: agent.id,
        ticketSource: { integrationId: "redmine-1", ticketProjectKey: "PLATFORM" },
        pushTargets: [
          { integrationId: "gerrit-1", repoKey: "superproject", cloneUrl: "ssh://g/super", targetBranch: "main", role: "primary", commitOrder: 1, localPath: "." },
        ],
        vendorComponents: [
          { sourcePath: "kas/config.yaml", localPath: "layers/poky", cloneUrl: "https://git.yoctoproject.org/git/poky", origin: "patch_required", note: "apply .bbappend" },
        ],
      },
    });

    expect(r.status).toBe(201);
    const projectId = (r.body?.["project"] as Record<string, unknown>)["id"] as string;
    const stored = await store.listProjectVendorComponents(makeProjectId(projectId));
    expect(stored.map((c) => [c.sourcePath, c.origin, c.note])).toEqual([
      ["kas/config.yaml", "patch_required", "apply .bbappend"],
    ]);
  });

  it("POST / rolls back the project when vendor components are invalid", async () => {
    const agent = await makeAgent(store, "coding");
    await seedIntegration(store, "redmine-1", "redmine");
    await seedIntegration(store, "gerrit-1", "gerrit");
    const r = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "coding",
        name: "Yocto",
        agentId: agent.id,
        ticketSource: { integrationId: "redmine-1", ticketProjectKey: "PLATFORM" },
        pushTargets: [
          { integrationId: "gerrit-1", repoKey: "superproject", cloneUrl: "ssh://g/super", targetBranch: "main", role: "primary", commitOrder: 1, localPath: "." },
        ],
        vendorComponents: [
          { sourcePath: "dup.yaml", origin: "internal" },
          { sourcePath: "dup.yaml", origin: "patch_required" },
        ],
      },
    });

    expect(r.status).toBe(400);
    expect(await store.listProjects()).toEqual([]);
  });

  it("POST / normalizes and deduplicates reviewer emails", async () => {
    const agent = await makeAgent(store, "coding");
    await seedIntegration(store, "redmine-1", "redmine");
    await seedIntegration(store, "gerrit-1", "gerrit");

    const r = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "coding",
        name: "Reviewers",
        agentId: agent.id,
        ticketSource: { integrationId: "redmine-1", ticketProjectKey: "REVIEWERS" },
        pushTargets: [{
          integrationId: "gerrit-1",
          repoKey: "app",
          cloneUrl: "ssh://g/app",
          targetBranch: "main",
          role: "primary",
          commitOrder: 1,
          localPath: ".",
          reviewerEmails: [" Alice@Example.com ", "alice@example.com", "BOB@example.com"],
        }],
      },
    });

    expect(r.status).toBe(201);
    const project = r.body?.["project"] as Record<string, unknown>;
    const targets = project["pushTargets"] as Array<Record<string, unknown>>;
    expect(targets[0]?.["reviewerEmails"]).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("POST / rejects more than 20 reviewer emails per push target", async () => {
    const agent = await makeAgent(store, "coding");

    const r = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "coding",
        name: "TooManyReviewers",
        agentId: agent.id,
        ticketSource: { integrationId: "redmine-1", ticketProjectKey: "TOO-MANY" },
        pushTargets: [{
          integrationId: "gerrit-1",
          repoKey: "app",
          cloneUrl: "ssh://g/app",
          targetBranch: "main",
          role: "primary",
          commitOrder: 1,
          localPath: ".",
          reviewerEmails: Array.from({ length: 21 }, (_, index) => `reviewer${index}@example.com`),
        }],
      },
    });

    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/20/);
  });

  it("POST / rejects reviewer emails for GitHub push targets", async () => {
    const agent = await makeAgent(store, "coding");
    await seedIntegration(store, "redmine-1", "redmine");
    await seedIntegration(store, "github-1", "github");

    const r = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "coding",
        name: "GitHubReviewers",
        agentId: agent.id,
        ticketSource: { integrationId: "redmine-1", ticketProjectKey: "GITHUB" },
        pushTargets: [{
          integrationId: "github-1",
          repoKey: "org/app",
          cloneUrl: "https://github.com/org/app.git",
          targetBranch: "main",
          role: "primary",
          commitOrder: 1,
          localPath: ".",
          reviewerEmails: ["alice@example.com"],
        }],
      },
    });

    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/not supported for github/i);
  });

  it("POST / rejects push-target SSH key paths outside approved secret directories", async () => {
    const agent = await makeAgent(store, "coding");
    await seedIntegration(store, "redmine-1", "redmine");
    await seedIntegration(store, "gerrit-1", "gerrit");

    const r = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "coding",
        name: "UnsafeKeyPath",
        agentId: agent.id,
        ticketSource: { integrationId: "redmine-1", ticketProjectKey: "UNSAFE" },
        pushTargets: [
          { integrationId: "gerrit-1", repoKey: "superproject", cloneUrl: "ssh://g/super", targetBranch: "main", role: "primary", commitOrder: 1, localPath: ".", sshKeyPath: "/etc/passwd" },
        ],
      },
    });

    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/SSH key path must be inside an approved secrets directory/);
  });

  it("POST / omits the removed skillDiscoveryEnabled field", async () => {
    const agent = await makeAgent(store, "coding");
    await seedIntegration(store, "redmine-1", "redmine");
    await seedIntegration(store, "gerrit-1", "gerrit");
    const response = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "coding",
        name: "WithSkills",
        agentId: agent.id,
        ticketSource: { integrationId: "redmine-1", ticketProjectKey: "A" },
        pushTargets: [
          { integrationId: "gerrit-1", repoKey: "superproject", cloneUrl: "ssh://g/super", targetBranch: "main", role: "primary", commitOrder: 1, localPath: "." },
        ],
      },
    });

    expect(response.status).toBe(201);
    const project = response.body?.["project"] as Record<string, unknown>;
    expect(project).not.toHaveProperty("skillDiscoveryEnabled");
    expect(project).not.toHaveProperty("localSkillsPath");
  });

  it("POST / rejects the removed skillDiscoveryEnabled field", async () => {
    const agent = await makeAgent(store, "coding");
    await seedIntegration(store, "redmine-1", "redmine");
    await seedIntegration(store, "gerrit-1", "gerrit");
    const response = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "coding",
        name: "LegacySkillsFlag",
        agentId: agent.id,
        skillDiscoveryEnabled: false,
        ticketSource: { integrationId: "redmine-1", ticketProjectKey: "B" },
        pushTargets: [
          { integrationId: "gerrit-1", repoKey: "superproject", cloneUrl: "ssh://g/super", targetBranch: "main", role: "primary", commitOrder: 1, localPath: "." },
        ],
      },
    });

    expect(response.status).toBe(400);
    expect(response.body?.["error"]).toBe(
      "skillDiscoveryEnabled has been removed; omit it from project payloads"
    );
  });

  it("POST / rejects the removed localSkillsPath field", async () => {
    const agent = await makeAgent(store, "coding");
    await seedIntegration(store, "redmine-1", "redmine");
    await seedIntegration(store, "gerrit-1", "gerrit");

    const r = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "coding",
        name: "LegacyLocalSkillsPath",
        agentId: agent.id,
        localSkillsPath: "team/skills",
        ticketSource: { integrationId: "redmine-1", ticketProjectKey: "LOCALSKILLS" },
        pushTargets: [
          { integrationId: "gerrit-1", repoKey: "superproject", cloneUrl: "ssh://g/super", targetBranch: "main", role: "primary", commitOrder: 1, localPath: "." },
        ],
      },
    });

    expect(r.status).toBe(400);
    expect(r.body?.["error"]).toBe(
      "localSkillsPath has been removed; omit it from project payloads"
    );
  });

  it("POST / persists normalized remote skill sources", async () => {
    const agent = await makeAgent(store, "coding");
    await seedIntegration(store, "redmine-1", "redmine");
    await seedIntegration(store, "gerrit-1", "gerrit");

    const r = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "coding",
        name: "WithRemoteSkills",
        agentId: agent.id,
        skillSources: [{ source: "ssh://skills.example.com/org/agent-skills", skills: ["skill-a", "skill-b", "skill-a"], sshUser: "git-user", sshPort: 29418, sshKeyPath: "/app/secrets/id_ed25519", sshKnownHostsPath: "/app/secrets/known_hosts" }],
        ticketSource: { integrationId: "redmine-1", ticketProjectKey: "SKILLS" },
        pushTargets: [
          { integrationId: "gerrit-1", repoKey: "superproject", cloneUrl: "ssh://g/super", targetBranch: "main", role: "primary", commitOrder: 1, localPath: "." },
        ],
      },
    });

    expect(r.status).toBe(201);
    const project = r.body?.["project"] as Record<string, unknown>;
    expect(project["skillSources"]).toEqual([
      { source: "ssh://skills.example.com/org/agent-skills", skills: ["skill-a", "skill-b"], sshUser: "git-user", sshPort: 29418, sshKeyPath: "/app/secrets/id_ed25519", sshKnownHostsPath: "/app/secrets/known_hosts" },
    ]);
    const stored = await store.getProjectById(makeProjectId(String(project["id"])));
    expect(stored?.skillSourcesJson).toBe(JSON.stringify(project["skillSources"]));
  });

  it("POST / defaults omitted remote skill sources to empty", async () => {
    const agent = await makeAgent(store, "review");
    await seedIntegration(store, "gerrit-1", "gerrit");

    const r = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "review",
        name: "DefaultEmptySkills",
        agentId: agent.id,
        reviewConfig: { integrationId: "gerrit-1", repoKeys: ["platform/api"] },
      },
    });

    expect(r.status).toBe(201);
    const project = r.body?.["project"] as Record<string, unknown>;
    expect(project["skillSources"]).toEqual([]);
    const stored = await store.getProjectById(makeProjectId(String(project["id"])));
    expect(stored?.skillSourcesJson).toBe(JSON.stringify(project["skillSources"]));
  });

  it("POST / preserves an explicit empty remote skill source list", async () => {
    const agent = await makeAgent(store, "review");
    await seedIntegration(store, "gerrit-1", "gerrit");

    const r = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "review",
        name: "NoPreloadedSkills",
        agentId: agent.id,
        skillSources: [],
        reviewConfig: { integrationId: "gerrit-1", repoKeys: ["platform/api"] },
      },
    });

    expect(r.status).toBe(201);
    const project = r.body?.["project"] as Record<string, unknown>;
    expect(project["skillSources"]).toEqual([]);
    const stored = await store.getProjectById(makeProjectId(String(project["id"])));
    expect(stored?.skillSourcesJson).toBe("[]");
  });

  it("POST / rejects remote skill sources without skills or installAll", async () => {
    const agent = await makeAgent(store, "review");
    await seedIntegration(store, "gerrit-1", "gerrit");
    const r = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "review",
        name: "BadSkills",
        agentId: agent.id,
        skillSources: [{ source: "ssh://skills.example.com/org/agent-skills", skills: [] }],
        reviewConfig: { integrationId: "gerrit-1", repoKeys: ["platform/api"] },
      },
    });

    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/Select at least one skill/);
  });

  it("POST / rejects empty SSH option strings in remote skill sources", async () => {
    const agent = await makeAgent(store, "review");
    await seedIntegration(store, "gerrit-1", "gerrit");
    const r = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "review",
        name: "BadSshOptions",
        agentId: agent.id,
        skillSources: [{ source: "ssh://skills.example.com/org/agent-skills", skills: ["skill-a"], sshKeyPath: " " }],
        reviewConfig: { integrationId: "gerrit-1", repoKeys: ["platform/api"] },
      },
    });

    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/SSH key path must not be empty/);
  });

  it("POST / rejects traversal in remote skill source SSH paths", async () => {
    const agent = await makeAgent(store, "review");
    await seedIntegration(store, "gerrit-1", "gerrit");
    const r = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "review",
        name: "UnsafeKnownHostsPath",
        agentId: agent.id,
        skillSources: [{ source: "ssh://skills.example.com/org/agent-skills", skills: ["skill-a"], sshKnownHostsPath: "/app/secrets/../../etc/passwd" }],
        reviewConfig: { integrationId: "gerrit-1", repoKeys: ["platform/api"] },
      },
    });

    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/SSH known_hosts path must be inside an approved secrets directory/);
  });

  it("POST / rejects remote skill source ports outside the TCP range", async () => {
    const agent = await makeAgent(store, "review");
    await seedIntegration(store, "gerrit-1", "gerrit");
    const r = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "review",
        name: "BadSshPort",
        agentId: agent.id,
        skillSources: [{ source: "ssh://skills.example.com/org/agent-skills", skills: ["skill-a"], sshPort: 294193 }],
        reviewConfig: { integrationId: "gerrit-1", repoKeys: ["platform/api"] },
      },
    });

    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/SSH port must be between 1 and 65535/);
  });

  it("POST / validates remote skill source connectivity before saving", async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    const validateSkillSourcesConnection = vi.fn(async () => {});
    server = createAdminServer(makeDeps(store, validateSkillSourcesConnection));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const agent = await makeAgent(store, "review");
    await seedIntegration(store, "gerrit-1", "gerrit");

    const r = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "review",
        name: "ValidateRemoteSkills",
        agentId: agent.id,
        skillSources: [{ source: "ssh://skills.example.com/org/agent-skills", skills: ["skill-a"], sshUser: "git-user", sshPort: 29418 }],
        reviewConfig: { integrationId: "gerrit-1", repoKeys: ["platform/api"] },
      },
    });

    expect(r.status).toBe(201);
    expect(validateSkillSourcesConnection).toHaveBeenCalledWith([
      { source: "ssh://skills.example.com/org/agent-skills", skills: ["skill-a"], sshUser: "git-user", sshPort: 29418 },
    ]);
  });

  it("POST / reports the failing remote skill source when connectivity validation fails", async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    const validateSkillSourcesConnection = vi.fn(async () => {
      throw new Error('Skill source #1 "ssh://skills.example.com/org/agent-skills": SSH connection check failed for skill source "ssh://skills.example.com/org/agent-skills": exit code 255; stderr: Permission denied (publickey).');
    });
    server = createAdminServer(makeDeps(store, validateSkillSourcesConnection));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const agent = await makeAgent(store, "review");
    await seedIntegration(store, "gerrit-1", "gerrit");

    const r = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "review",
        name: "BadRemoteSkills",
        agentId: agent.id,
        skillSources: [{ source: "ssh://skills.example.com/org/agent-skills", skills: ["skill-a"] }],
        reviewConfig: { integrationId: "gerrit-1", repoKeys: ["platform/api"] },
      },
    });

    expect(r.status).toBe(400);
    expect(r.body?.["error"]).toMatch(/Failed to validate skill sources before saving/);
    expect(r.body?.["error"]).toMatch(/Skill source #1 "ssh:\/\/skills\.example\.com\/org\/agent-skills"/);
    expect(r.body?.["error"]).toMatch(/Permission denied/);
    expect(await store.listProjects()).toHaveLength(0);
  });

  it("POST / creates a review project with reviewConfig", async () => {
    const agent = await makeAgent(store, "review");
    await seedIntegration(store, "gerrit-1", "gerrit");
    const r = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "review",
        name: "ReviewProj",
        agentId: agent.id,
        reviewConfig: { integrationId: "gerrit-1", repoKeys: ["platform/api"] },
      },
    });
    expect(r.status).toBe(201);
    const project = r.body?.["project"] as Record<string, unknown>;
    expect(project["type"]).toBe("review");
    const rc = project["reviewConfig"] as Record<string, unknown>;
    expect((rc["repos"] as string[])).toContain("platform/api");
  });

  it("POST / returns 409 when ticket source is already claimed by another project", async () => {
    const agent = await makeAgent(store, "coding");
    await seedIntegration(store, "redmine-1");
    await seedIntegration(store, "gerrit-1", "gerrit");
    const body1 = {
      type: "coding", name: "First", agentId: agent.id,
      ticketSource: { integrationId: "redmine-1", ticketProjectKey: "PROJ" },
      pushTargets: [{ integrationId: "gerrit-1", repoKey: "r1", cloneUrl: "ssh://x", targetBranch: "main", role: "primary", commitOrder: 1, localPath: "." }],
    };
    const r1 = await rest(server, "/api/admin/projects", { method: "POST", body: body1 });
    expect(r1.status).toBe(201);
    const body2 = { ...body1, name: "Second" };
    const r2 = await rest(server, "/api/admin/projects", { method: "POST", body: body2 });
    expect(r2.status).toBe(409);
    expect((r2.body?.["message"] as string)).toMatch(/First/);
    expect(r2.body?.["conflictingProjectName"]).toBe("First");
  });

  it("POST / allows multiple review projects to cover the same repo", async () => {
    const agent = await makeAgent(store, "review");
    await seedIntegration(store, "gerrit-1", "gerrit");
    const body1 = {
      type: "review", name: "R1", agentId: agent.id,
      reviewConfig: { integrationId: "gerrit-1", repoKeys: ["platform/api"] },
    };
    expect((await rest(server, "/api/admin/projects", { method: "POST", body: body1 })).status).toBe(201);
    const r = await rest(server, "/api/admin/projects", { method: "POST", body: { ...body1, name: "R2" } });
    expect(r.status).toBe(201);
  });

  it("POST / returns 400 when agent.type mismatches project.type", async () => {
    const codingAgent = await makeAgent(store, "coding");
    await seedIntegration(store, "gerrit-1", "gerrit");
    const r = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "review", name: "Mismatch", agentId: codingAgent.id,
        reviewConfig: { integrationId: "gerrit-1", repoKeys: ["x"] },
      },
    });
    expect(r.status).toBe(400);
    expect(r.body?.["error"]).toMatch(/mismatch/i);
  });

  it("POST / rejects malformed agent override JSON", async () => {
    const agent = await makeAgent(store, "review");
    await seedIntegration(store, "gerrit-1", "gerrit");

    const r = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "review",
        name: "MalformedOverride",
        agentId: agent.id,
        agentOverrideJson: "{not-json",
        reviewConfig: { integrationId: "gerrit-1", repoKeys: ["x"] },
      },
    });

    expect(r.status).toBe(400);
    expect(r.body?.["error"]).toMatch(/override.*JSON/i);
  });

  it("POST / returns 400 when the agent has an unknown review strategy", async () => {
    const agent = await store.createAgent({
      name: "invalid-review-bot",
      type: "review",
      modelConfigJson: JSON.stringify({ providerOptions: { reviewStrategy: "unknown" } }),
      enabled: true,
      systemPromptId: "system_review",
      instructionsPromptId: "instructions_review",
    });
    await seedIntegration(store, "gerrit-1", "gerrit");

    const r = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "review",
        name: "InvalidAgentStrategy",
        agentId: agent.id,
        agentOverrideJson: "{}",
        reviewConfig: { integrationId: "gerrit-1", repoKeys: ["x"] },
      },
    });

    expect(r.status).toBe(400);
    expect(r.body?.["error"]).toBe("Unknown review strategy 'unknown'");
  });

  it("PUT /:id returns 400 when the agent has an unknown review strategy", async () => {
    const agent = await makeAgent(store, "review");
    await seedIntegration(store, "gerrit-1", "gerrit");
    const created = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "review",
        name: "ExistingReviewProject",
        agentId: agent.id,
        reviewConfig: { integrationId: "gerrit-1", repoKeys: ["x"] },
      },
    });
    const projectId = (created.body?.["project"] as { id: string }).id;
    await store.updateAgent(agent.id, {
      modelConfigJson: JSON.stringify({ providerOptions: { reviewStrategy: "unknown" } }),
    });

    const r = await rest(server, `/api/admin/projects/${projectId}`, {
      method: "PUT",
      body: { agentOverrideJson: "{}" },
    });

    expect(r.status).toBe(400);
    expect(r.body?.["error"]).toBe("Unknown review strategy 'unknown'");
  });

  it("POST / rejects project prompt overrides with crossed roles", async () => {
    const agent = await makeAgent(store, "review");
    await seedIntegration(store, "gerrit-1", "gerrit");

    const r = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "review",
        name: "CrossedPrompts",
        agentId: agent.id,
        agentOverrideJson: JSON.stringify({
          systemPromptId: "instructions_generic_code",
          instructionsPromptId: "system_generic_code",
        }),
        reviewConfig: { integrationId: "gerrit-1", repoKeys: ["x"] },
      },
    });

    expect(r.status).toBe(400);
    expect(r.body?.["error"]).toMatch(/not (?:a )?System Prompt/i);
  });

  it("rejects conflicting project overrides for native review agents", async () => {
    const agent = await store.createAgent({
      name: "native-review-bot",
      type: "review",
      modelConfigJson: JSON.stringify({ providerOptions: { reviewStrategy: "copilot_native" } }),
      enabled: true,
      systemPromptId: "system_review",
      instructionsPromptId: "instructions_review",
    });
    await seedIntegration(store, "gerrit-1", "gerrit");
    const createResponse = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "review",
        name: "NativeOverride",
        agentId: agent.id,
        agentOverrideJson: JSON.stringify({ model: "project-model" }),
        reviewConfig: { integrationId: "gerrit-1", repoKeys: ["x"] },
      },
    });

    expect(createResponse.status).toBe(400);
    expect(createResponse.body?.["error"]).toMatch(/native review.*model/i);

    const validCreate = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "review",
        name: "NativeWorkflowOverride",
        agentId: agent.id,
        agentOverrideJson: JSON.stringify({ instructionsPromptId: "instructions_generic_code" }),
        reviewConfig: { integrationId: "gerrit-1", repoKeys: ["x"] },
      },
    });
    expect(validCreate.status).toBe(201);

    const projectId = (validCreate.body?.["project"] as { id: string }).id;
    const updateResponse = await rest(server, `/api/admin/projects/${projectId}`, {
      method: "PUT",
      body: {
        agentOverrideJson: JSON.stringify({
          systemPromptId: "system_generic_code",
          providerOptions: { reviewStrategy: "ve_direct", reasoningEffort: "high" },
        }),
      },
    });
    expect(updateResponse.status).toBe(400);
    expect(updateResponse.body?.["error"]).toMatch(/native review.*systemPromptId/i);
  });

  it("POST / coding requires ticketSource and at least one pushTarget", async () => {
    const agent = await makeAgent(store, "coding");
    const noPush = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: { type: "coding", name: "NoPush", agentId: agent.id, ticketSource: { integrationId: "x", ticketProjectKey: "k" }, pushTargets: [] },
    });
    expect(noPush.status).toBe(400);
    const noTicket = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: { type: "coding", name: "NoTicket", agentId: agent.id, pushTargets: [{ integrationId: "g", repoKey: "r", cloneUrl: "u", targetBranch: "main", role: "primary", commitOrder: 1, localPath: "." }] },
    });
    expect(noTicket.status).toBe(400);
  });

  it("POST / review requires reviewConfig", async () => {
    const agent = await makeAgent(store, "review");
    const r = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: { type: "review", name: "Bad", agentId: agent.id },
    });
    expect(r.status).toBe(400);
  });

  it("PUT /:id replaces push targets atomically", async () => {
    const agent = await makeAgent(store, "coding");
    await seedIntegration(store, "redmine-1");
    await seedIntegration(store, "gerrit-1", "gerrit");
    const created = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "coding", name: "P", agentId: agent.id,
        ticketSource: { integrationId: "redmine-1", ticketProjectKey: "K" },
        pushTargets: [
          { integrationId: "gerrit-1", repoKey: "old1", cloneUrl: "u", targetBranch: "main", role: "primary", commitOrder: 1, localPath: "." },
          { integrationId: "gerrit-1", repoKey: "old2", cloneUrl: "u", targetBranch: "main", role: "submodule", commitOrder: 2, localPath: "x" },
        ],
      },
    });
    const id = (created.body?.["project"] as Record<string, unknown>)["id"] as string;
    const r = await rest(server, `/api/admin/projects/${id}`, {
      method: "PUT",
      body: {
        pushTargets: [
          { integrationId: "gerrit-1", repoKey: "new", cloneUrl: "u", targetBranch: "develop", role: "primary", commitOrder: 1, localPath: "." },
        ],
      },
    });
    expect(r.status).toBe(200);
    const project = r.body?.["project"] as Record<string, unknown>;
    const pts = project["pushTargets"] as Array<Record<string, unknown>>;
    expect(pts).toHaveLength(1);
    expect(pts[0]?.["repoKey"]).toBe("new");
  });

  it("PUT /:id rejects the removed skillDiscoveryEnabled field", async () => {
    const agent = await makeAgent(store, "coding");
    await seedIntegration(store, "redmine-1");
    await seedIntegration(store, "gerrit-1", "gerrit");
    const created = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "coding", name: "Toggle", agentId: agent.id,
        skillSources: [],
        ticketSource: { integrationId: "redmine-1", ticketProjectKey: "K" },
        pushTargets: [{ integrationId: "gerrit-1", repoKey: "r", cloneUrl: "u", targetBranch: "main", role: "primary", commitOrder: 1, localPath: "." }],
      },
    });
    const id = (created.body?.["project"] as Record<string, unknown>)["id"] as string;
    const r = await rest(server, `/api/admin/projects/${id}`, {
      method: "PUT",
      body: { skillDiscoveryEnabled: false },
    });
    expect(r.status).toBe(400);
    expect(r.body?.["error"]).toBe(
      "skillDiscoveryEnabled has been removed; omit it from project payloads"
    );
  });

  it("PUT /:id preserves local skill loading when remote skill sources are configured", async () => {
    const agent = await makeAgent(store, "review");
    await seedIntegration(store, "gerrit-1", "gerrit");
    const created = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: { type: "review", name: "EnableViaSources", agentId: agent.id, skillSources: [], reviewConfig: { integrationId: "gerrit-1", repoKeys: ["x"] } },
    });
    const id = (created.body?.["project"] as Record<string, unknown>)["id"] as string;

    const r = await rest(server, `/api/admin/projects/${id}`, {
      method: "PUT",
      body: {
        type: "review",
        skillSources: [{ source: "ssh://skills.example.com/org/agent-skills", skills: ["skill-a"] }],
      },
    });

    expect(r.status).toBe(200);
    const project = r.body?.["project"] as Record<string, unknown>;
    expect(project).not.toHaveProperty("skillDiscoveryEnabled");
    expect(project["skillSources"]).toEqual([{ source: "ssh://skills.example.com/org/agent-skills", skills: ["skill-a"] }]);
  });

  it("DELETE /:id removes the project (idempotent: 404 second time)", async () => {
    const agent = await makeAgent(store, "review");
    await seedIntegration(store, "gerrit-1", "gerrit");
    const created = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: { type: "review", name: "D", agentId: agent.id, reviewConfig: { integrationId: "gerrit-1", repoKeys: ["x"] } },
    });
    const id = (created.body?.["project"] as Record<string, unknown>)["id"] as string;
    const d1 = await rest(server, `/api/admin/projects/${id}`, { method: "DELETE" });
    expect(d1.status).toBe(204);
    const d2 = await rest(server, `/api/admin/projects/${id}`, { method: "DELETE" });
    expect(d2.status).toBe(404);
  });

  it("GET / returns ticketSource and reviewConfig resolved with integration name", async () => {
    const codingAgent = await makeAgent(store, "coding");
    const reviewAgent = await makeAgent(store, "review");
    await seedIntegration(store, "redmine-1");
    await seedIntegration(store, "gerrit-1", "gerrit");
    await rest(server, "/api/admin/projects", {
      method: "POST",
      body: {
        type: "coding", name: "C", agentId: codingAgent.id,
        ticketSource: { integrationId: "redmine-1", ticketProjectKey: "K" },
        pushTargets: [{ integrationId: "gerrit-1", repoKey: "r", cloneUrl: "u", targetBranch: "main", role: "primary", commitOrder: 1, localPath: "." }],
      },
    });
    await rest(server, "/api/admin/projects", {
      method: "POST",
      body: { type: "review", name: "R", agentId: reviewAgent.id, reviewConfig: { integrationId: "gerrit-1", repoKeys: ["r2"] } },
    });
    const r = await rest(server, "/api/admin/projects");
    const projects = r.body?.["projects"] as Array<Record<string, unknown>>;
    expect(projects).toHaveLength(2);
    const coding = projects.find((p) => p["type"] === "coding")!;
    const codingTs = coding["ticketSource"] as Record<string, unknown>;
    const codingInteg = codingTs["integration"] as Record<string, unknown>;
    expect(codingInteg["name"]).toBe("redmine-1");
    expect(coding["agentName"]).toBe("coding-bot");
    const review = projects.find((p) => p["type"] === "review")!;
    const reviewRc = review["reviewConfig"] as Record<string, unknown>;
    const reviewInteg = reviewRc["integration"] as Record<string, unknown>;
    expect(reviewInteg["provider"]).toBe("gerrit");
  });

  it("PATCH /:id/enable and /disable toggle the flag", async () => {
    const agent = await makeAgent(store, "review");
    await seedIntegration(store, "gerrit-1", "gerrit");
    const created = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: { type: "review", name: "E", agentId: agent.id, reviewConfig: { integrationId: "gerrit-1", repoKeys: ["x"] } },
    });
    const id = (created.body?.["project"] as Record<string, unknown>)["id"] as string;
    expect((await rest(server, `/api/admin/projects/${id}/enable`, { method: "PATCH" })).status).toBe(204);
    expect((await rest(server, `/api/admin/projects/${id}/disable`, { method: "PATCH" })).status).toBe(204);
  });
});
