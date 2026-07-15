import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import type { Server } from "node:http";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { createAdminServer, type AdminServerDependencies } from "../../src/admin/adminServer.js";
import { Router } from "../../src/admin/router.js";
import { registerProjectRoutes } from "../../src/admin/adminProjectsRoutes.js";
import { makeProjectId, type AgentRecord, type AgentType } from "../../src/interfaces.js";

function tempDbPath(): string {
  return join(tmpdir(), `ve-admin-projects-${randomUUID()}.db`);
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

function makeDeps(store: SqliteStateStore): AdminServerDependencies {
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
  };
}

async function makeAgent(store: SqliteStateStore, type: AgentType = "coding"): Promise<AgentRecord> {
  return store.createAgent({ name: `${type}-bot`, type, modelConfigJson: "{}", enabled: true });
}

async function seedIntegration(store: SqliteStateStore, id: string, provider: "redmine" | "gerrit" = "redmine"): Promise<void> {
  await store.upsertIntegration({ id, provider, name: id, configJson: "{}", enabled: true });
}

describe("Admin API — Project routes (/api/admin/projects)", () => {
  let store: SqliteStateStore;
  let server: Server;

  beforeEach(async () => {
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

    expect(scoped?.meta).toMatchObject({ permission: "project.write", resourceParam: "id" });
    expect(scoped?.params["id"]).toBe("project-1");
    expect(global?.meta).toMatchObject({ permission: "project.write" });
    expect(global?.meta.resourceParam).toBeUndefined();
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
          sshKnownHostsPath: "/tmp/virtual-engineer-missing-known-hosts",
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

  it("POST / persists skillDiscoveryEnabled for coding projects", async () => {
    const agent = await makeAgent(store, "coding");
    await seedIntegration(store, "redmine-1", "redmine");
    await seedIntegration(store, "gerrit-1", "gerrit");
    const base = {
      type: "coding",
      agentId: agent.id,
      pushTargets: [
        { integrationId: "gerrit-1", repoKey: "superproject", cloneUrl: "ssh://g/super", targetBranch: "main", role: "primary", commitOrder: 1, localPath: "." },
      ],
    };
    const on = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: { ...base, name: "WithSkills", ticketSource: { integrationId: "redmine-1", ticketProjectKey: "A" }, skillDiscoveryEnabled: true },
    });
    expect(on.status).toBe(201);
    expect((on.body?.["project"] as Record<string, unknown>)["skillDiscoveryEnabled"]).toBe(true);

    const off = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: { ...base, name: "NoSkills", ticketSource: { integrationId: "redmine-1", ticketProjectKey: "B" }, skillSources: [] },
    });
    expect(off.status).toBe(201);
    expect((off.body?.["project"] as Record<string, unknown>)["skillDiscoveryEnabled"]).toBe(false);
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
        skillSources: [{ source: "ssh://skills.example.com/org/agent-skills", skills: ["skill-a", "skill-b", "skill-a"], sshUser: "git-user", sshPort: 29418, sshKeyPath: "/home/ve/.ssh/id_ed25519", sshKnownHostsPath: "/home/ve/.ssh/known_hosts" }],
        ticketSource: { integrationId: "redmine-1", ticketProjectKey: "SKILLS" },
        pushTargets: [
          { integrationId: "gerrit-1", repoKey: "superproject", cloneUrl: "ssh://g/super", targetBranch: "main", role: "primary", commitOrder: 1, localPath: "." },
        ],
      },
    });

    expect(r.status).toBe(201);
    const project = r.body?.["project"] as Record<string, unknown>;
    expect(project["skillDiscoveryEnabled"]).toBe(false);
    expect(project["skillSources"]).toEqual([
      { source: "ssh://skills.example.com/org/agent-skills", skills: ["skill-a", "skill-b"], sshUser: "git-user", sshPort: 29418, sshKeyPath: "/home/ve/.ssh/id_ed25519", sshKnownHostsPath: "/home/ve/.ssh/known_hosts" },
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
    expect(project["skillDiscoveryEnabled"]).toBe(false);
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
    expect(project["skillDiscoveryEnabled"]).toBe(false);
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

  it("PUT /:id toggles skillDiscoveryEnabled on a coding project", async () => {
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
    expect((created.body?.["project"] as Record<string, unknown>)["skillDiscoveryEnabled"]).toBe(false);
    const r = await rest(server, `/api/admin/projects/${id}`, {
      method: "PUT",
      body: { skillDiscoveryEnabled: true },
    });
    expect(r.status).toBe(200);
    expect((r.body?.["project"] as Record<string, unknown>)["skillDiscoveryEnabled"]).toBe(true);
  });

  it("PUT /:id toggles skillDiscoveryEnabled on a review project", async () => {
    const agent = await makeAgent(store, "review");
    await seedIntegration(store, "gerrit-1", "gerrit");
    const created = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: { type: "review", name: "RevWithSkills", agentId: agent.id, skillSources: [], reviewConfig: { integrationId: "gerrit-1", repoKeys: ["x"] } },
    });
    const id = (created.body?.["project"] as Record<string, unknown>)["id"] as string;
    expect((created.body?.["project"] as Record<string, unknown>)["skillDiscoveryEnabled"]).toBe(false);
    const r = await rest(server, `/api/admin/projects/${id}`, {
      method: "PUT",
      body: { skillDiscoveryEnabled: true },
    });
    expect(r.status).toBe(200);
    expect((r.body?.["project"] as Record<string, unknown>)["skillDiscoveryEnabled"]).toBe(true);
  });

  it("PUT /:id preserves local skill loading when remote skill sources are configured", async () => {
    const agent = await makeAgent(store, "review");
    await seedIntegration(store, "gerrit-1", "gerrit");
    const created = await rest(server, "/api/admin/projects", {
      method: "POST",
      body: { type: "review", name: "EnableViaSources", agentId: agent.id, skillSources: [], reviewConfig: { integrationId: "gerrit-1", repoKeys: ["x"] } },
    });
    const id = (created.body?.["project"] as Record<string, unknown>)["id"] as string;
    expect((created.body?.["project"] as Record<string, unknown>)["skillDiscoveryEnabled"]).toBe(false);

    const r = await rest(server, `/api/admin/projects/${id}`, {
      method: "PUT",
      body: { skillSources: [{ source: "ssh://skills.example.com/org/agent-skills", skills: ["skill-a"] }] },
    });

    expect(r.status).toBe(200);
    const project = r.body?.["project"] as Record<string, unknown>;
    expect(project["skillDiscoveryEnabled"]).toBe(false);
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
