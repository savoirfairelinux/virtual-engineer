import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { StateStore } from "../../src/interfaces.js";
import { makeTaskId, makeTicketId, makeProjectId } from "../../src/interfaces.js";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { createAdminServer } from "../../src/admin/adminServer.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

const SECRET = "rbac-test-secret";

function hmacToken(secret: string = SECRET): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(timestamp.toString()).digest("hex");
  return `${timestamp}.${signature}`;
}

function tempDbPath(): string {
  return tempDatabasePath("ve-rbac");
}

function makeServer(store: SqliteStateStore): ReturnType<typeof createAdminServer> {
  return createAdminServer({
    stateStore: store,
    integrationStore: store,
    promptStore: store,
    config: {
      nodeEnv: "test",
      logLevel: "info",
      maxAgentCycles: 3,
      maxRetryAttempts: 5,
      pollingIntervalMs: 30_000,
      adminAuthSecret: SECRET,
    },
    polling: {
      isRunning: () => true,
      getIntervals: () => ({ intervalMs: 30_000 }),
    },
    providers: [],
  });
}

async function listen(server: ReturnType<typeof createAdminServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: ReturnType<typeof createAdminServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

interface SessionResponse {
  token: string;
  user: { id: string; username: string; role: string };
}

describe("adminServer RBAC and session auth", () => {
  let store: SqliteStateStore;
  let server: ReturnType<typeof createAdminServer>;
  let baseUrl: string;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
    server = makeServer(store);
    baseUrl = await listen(server);
  });

  afterEach(async () => {
    await closeServer(server);
    store.close();
  });

  async function setupAndLogin(username: string, password: string, role: string, adminSession?: SessionResponse): Promise<SessionResponse> {
    if (!adminSession) {
      const setup = await fetch(`${baseUrl}/api/admin/auth/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      expect(setup.status).toBe(201);
      return (await setup.json()) as SessionResponse;
    }
    const create = await fetch(`${baseUrl}/api/admin/users`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminSession.token}`, "content-type": "application/json" },
      body: JSON.stringify({ username, password, role }),
    });
    expect(create.status).toBe(201);
    const login = await fetch(`${baseUrl}/api/admin/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    expect(login.status).toBe(200);
    return (await login.json()) as SessionResponse;
  }

  it("allows unauthenticated requests while zero users exist (bootstrap mode)", async () => {
    for (const path of ["/api/admin/status", "/api/admin/tasks", "/api/admin/prompts"]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(200);
    }

    // Mutations work too (bootstrap actor is treated as admin).
    const create = await fetch(`${baseUrl}/api/admin/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Bootstrap Prompt", content: "hello" }),
    });
    expect(create.status).toBe(201);
  });

  it("rejects unknown bearer tokens on normal routes once a user exists", async () => {
    const admin = await setupAndLogin("root", "Str0ng-Pass-1x", "admin");

    // Any Bearer token that is not a valid session token is rejected.
    const withHmac = await fetch(`${baseUrl}/api/admin/status`, {
      headers: { authorization: `Bearer ${hmacToken()}` },
    });
    expect(withHmac.status).toBe(401);

    const withSession = await fetch(`${baseUrl}/api/admin/status`, {
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(withSession.status).toBe(200);

    const noToken = await fetch(`${baseUrl}/api/admin/status`);
    expect(noToken.status).toBe(401);
  });

  it("populates the auth context for session-authenticated requests", async () => {
    const admin = await setupAndLogin("root", "Str0ng-Pass-1x", "admin");
    const viewer = await setupAndLogin("vera", "Str0ng-Pass-1x", "viewer", admin);

    const me = await fetch(`${baseUrl}/api/admin/auth/me`, {
      headers: { authorization: `Bearer ${viewer.token}` },
    });
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toMatchObject({ id: viewer.user.id, username: "vera", role: "viewer" });
  });

  it("gives viewers access only to overview/tasks reads and 403 everywhere else", async () => {
    const admin = await setupAndLogin("root", "Str0ng-Pass-1x", "admin");
    const viewer = await setupAndLogin("vera", "Str0ng-Pass-1x", "viewer", admin);
    const headers = { authorization: `Bearer ${viewer.token}` };

    // Allowed: overview + tasks reads.
    for (const path of ["/api/admin/status", "/api/admin/tasks", "/api/admin/overview"]) {
      const response = await fetch(`${baseUrl}${path}`, { headers });
      expect(response.status, `viewer GET ${path}`).toBe(200);
    }

    // Forbidden: config-area reads still gated by the legacy operator role.
    // (Projects are PBAC-gated and readable by viewers via the Viewer policy.)
    for (const path of ["/api/admin/prompts", "/api/admin/integrations", "/api/admin/agents"]) {
      const response = await fetch(`${baseUrl}${path}`, { headers });
      expect(response.status, `viewer GET ${path}`).toBe(403);
    }

    // Forbidden: mutations.
    const mutate = await fetch(`${baseUrl}/api/admin/prompts`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ label: "Nope", content: "nope" }),
    });
    expect(mutate.status).toBe(403);
    await expect(mutate.json()).resolves.toEqual({ error: "forbidden", permission: "prompt.write" });
  });

  it("lets operators manage integrations/webhooks but 403s on user-management and audit", async () => {
    const admin = await setupAndLogin("root", "Str0ng-Pass-1x", "admin");
    const operator = await setupAndLogin("oscar", "Str0ng-Pass-1x", "operator", admin);

    // Operator can perform regular mutations (prompts CRUD).
    const promptCreate = await fetch(`${baseUrl}/api/admin/prompts`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator.token}`, "content-type": "application/json" },
      body: JSON.stringify({ label: "Operator Prompt", content: "hello" }),
    });
    expect(promptCreate.status).toBe(201);

    // Operator now manages integrations — passes RBAC (404: id doesn't exist).
    const integrationPut = await fetch(`${baseUrl}/api/admin/integrations/some-id`, {
      method: "PUT",
      headers: { authorization: `Bearer ${operator.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(integrationPut.status).not.toBe(403);
    expect(integrationPut.status).toBe(404);

    // …and webhook-secret rotation — passes RBAC (404: id doesn't exist).
    const rotate = await fetch(`${baseUrl}/api/admin/integrations/some-id/webhook-secret/rotate`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator.token}` },
    });
    expect(rotate.status).not.toBe(403);
    expect(rotate.status).toBe(404);

    // …but NOT user management or the audit log (admin-only).
    const operatorUsers = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { authorization: `Bearer ${operator.token}` },
    });
    expect(operatorUsers.status).toBe(403);
    await expect(operatorUsers.json()).resolves.toEqual({ error: "forbidden", permission: "user.manage" });

    const operatorAudit = await fetch(`${baseUrl}/api/admin/audit`, {
      headers: { authorization: `Bearer ${operator.token}` },
    });
    expect(operatorAudit.status).toBe(403);
    await expect(operatorAudit.json()).resolves.toEqual({ error: "forbidden", permission: "audit.read" });

    // The admin reaches user management + audit.
    const adminUsers = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(adminUsers.status).toBe(200);

    const adminAudit = await fetch(`${baseUrl}/api/admin/audit`, {
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(adminAudit.status).toBe(200);
  });

  it("keeps working with mock stores that lack the user methods (legacy embedders)", async () => {
    const mockStore = {
      getActiveTasks: async () => [],
      getAllTasks: async () => [],
      getTask: async () => null,
      getAgentCycles: async () => [],
      getAgentCycleEvents: async () => [],
      getStateTransitions: async () => [],
      getChangesForTask: async () => [],
      getChangesForTasks: async () => [],
      pauseTask: async () => null,
      resumeTask: async () => null,
      retryTask: async () => null,
      abandonTask: async () => null,
      deleteTask: async () => undefined,
      deleteTaskGroup: async () => undefined,
      getCostSummary: async () => ({ global: {}, perProject: [] }),
      getModelUsageSummary: async () => ({ models: [] }),
    } as unknown as StateStore;

    const legacyServer = createAdminServer({
      stateStore: mockStore,
      config: {
        nodeEnv: "test",
        logLevel: "info",
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        pollingIntervalMs: 30_000,
        adminAuthSecret: SECRET,
      },
      polling: { isRunning: () => true, getIntervals: () => ({ intervalMs: 30_000 }) },
      providers: [],
    });
    try {
      const legacyBase = await listen(legacyServer);
      const response = await fetch(`${legacyBase}/api/admin/status`);
      expect(response.status).toBe(200);

      // Session auth is unavailable → setup-status reports no setup needed.
      const setupStatus = await fetch(`${legacyBase}/api/admin/auth/setup-status`);
      await expect(setupStatus.json()).resolves.toEqual({ needsSetup: false });
    } finally {
      await closeServer(legacyServer);
    }
  });
});

describe("adminServer PBAC project scoping", () => {
  let store: SqliteStateStore;
  let server: ReturnType<typeof createAdminServer>;
  let baseUrl: string;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
    server = createAdminServer({
      stateStore: store,
      integrationStore: store,
      promptStore: store,
      projectStore: store,
      agentStore: store,
      config: {
        nodeEnv: "test",
        logLevel: "info",
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        pollingIntervalMs: 30_000,
        adminAuthSecret: SECRET,
      },
      polling: { isRunning: () => true, getIntervals: () => ({ intervalMs: 30_000 }) },
      providers: [],
    });
    baseUrl = await listen(server);
  });

  afterEach(async () => {
    await closeServer(server);
    store.close();
  });

  async function setupAdmin(): Promise<SessionResponse> {
    const setup = await fetch(`${baseUrl}/api/admin/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "Str0ng-Pass-1x" }),
    });
    expect(setup.status).toBe(201);
    return (await setup.json()) as SessionResponse;
  }

  async function createUserAndLogin(admin: SessionResponse, username: string, role: string): Promise<SessionResponse> {
    const create = await fetch(`${baseUrl}/api/admin/users`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ username, password: "Str0ng-Pass-1x", role }),
    });
    expect(create.status).toBe(201);
    const login = await fetch(`${baseUrl}/api/admin/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: "Str0ng-Pass-1x" }),
    });
    expect(login.status).toBe(200);
    return (await login.json()) as SessionResponse;
  }

  async function seedTwoProjects(): Promise<{ a: string; b: string }> {
    const agent = await store.createAgent({
      name: "rev-agent", type: "review", modelConfigJson: "{}",
      systemPromptId: "system_generic_code", instructionsPromptId: "instructions_generic_code",
    });
    const a = await store.createProject({ name: "Project A", type: "review", agentId: agent.id });
    const b = await store.createProject({ name: "Project B", type: "review", agentId: agent.id });
    return { a: a.id, b: b.id };
  }

  function authed(token: string): { headers: Record<string, string> } {
    return { headers: { authorization: `Bearer ${token}` } };
  }

  it("auto-binds a new viewer to the Viewer policy (global project.read)", async () => {
    const admin = await setupAdmin();
    await seedTwoProjects();
    const viewer = await createUserAndLogin(admin, "vera", "viewer");

    const list = await fetch(`${baseUrl}/api/admin/projects`, authed(viewer.token));
    expect(list.status).toBe(200);
    const body = (await list.json()) as { projects: Array<{ id: string }> };
    expect(body.projects).toHaveLength(2);
  });

  it("admin (superuser) sees every project", async () => {
    const admin = await setupAdmin();
    await seedTwoProjects();
    const list = await fetch(`${baseUrl}/api/admin/projects`, authed(admin.token));
    const body = (await list.json()) as { projects: Array<{ id: string }> };
    expect(body.projects).toHaveLength(2);
  });

  it("scopes a user to a single project: list filtered, other project forbidden", async () => {
    const admin = await setupAdmin();
    const { a, b } = await seedTwoProjects();
    const user = await createUserAndLogin(admin, "scoped", "viewer");

    // Replace the auto-bound Viewer policy with a project-A-scoped read policy.
    const viewerPolicy = (await store.listPolicies()).find((p) => p.name === "Viewer");
    await store.deleteBinding(viewerPolicy!.id, "user", user.user.id);
    const scoped = await store.createPolicy({ name: "Only-A" });
    await store.setPolicyRules(scoped.id, [{ permission: "project.read", resourceId: a }]);
    await store.createBinding({ policyId: scoped.id, principalType: "user", principalId: user.user.id });

    // List shows only project A.
    const list = await fetch(`${baseUrl}/api/admin/projects`, authed(user.token));
    const body = (await list.json()) as { projects: Array<{ id: string }> };
    expect(body.projects.map((p) => p.id)).toEqual([a]);

    // Direct access to A is allowed, B is forbidden.
    expect((await fetch(`${baseUrl}/api/admin/projects/${a}`, authed(user.token))).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/admin/projects/${b}`, authed(user.token))).status).toBe(403);
  });

  it("denies writes to a read-only scoped user", async () => {
    const admin = await setupAdmin();
    const { a } = await seedTwoProjects();
    const user = await createUserAndLogin(admin, "ro", "viewer");
    const viewerPolicy = (await store.listPolicies()).find((p) => p.name === "Viewer");
    await store.deleteBinding(viewerPolicy!.id, "user", user.user.id);
    const scoped = await store.createPolicy({ name: "RO-A" });
    await store.setPolicyRules(scoped.id, [{ permission: "project.read", resourceId: a }]);
    await store.createBinding({ policyId: scoped.id, principalType: "user", principalId: user.user.id });

    // Deleting project A requires project.delete — not granted → 403.
    const del = await fetch(`${baseUrl}/api/admin/projects/${a}`, { method: "DELETE", ...authed(user.token) });
    expect(del.status).toBe(403);
  });

  it("grants project access via group membership", async () => {
    const admin = await setupAdmin();
    const { a, b } = await seedTwoProjects();
    const user = await createUserAndLogin(admin, "grouped", "viewer");
    const viewerPolicy = (await store.listPolicies()).find((p) => p.name === "Viewer");
    await store.deleteBinding(viewerPolicy!.id, "user", user.user.id);

    const group = await store.createGroup({ name: "Team-B" });
    await store.addUserToGroup(group.id, user.user.id);
    const policy = await store.createPolicy({ name: "Group-B-read" });
    await store.setPolicyRules(policy.id, [{ permission: "project.read", resourceId: b }]);
    await store.createBinding({ policyId: policy.id, principalType: "group", principalId: group.id });

    const list = await fetch(`${baseUrl}/api/admin/projects`, authed(user.token));
    const body = (await list.json()) as { projects: Array<{ id: string }> };
    expect(body.projects.map((p) => p.id)).toEqual([b]);
    expect((await fetch(`${baseUrl}/api/admin/projects/${a}`, authed(user.token))).status).toBe(403);
  });

  it("scope-filters the task list and denies out-of-scope task detail", async () => {
    const admin = await setupAdmin();
    const { a, b } = await seedTwoProjects();
    const taskA = randomUUID();
    const taskB = randomUUID();
    await store.createTask(makeTaskId(taskA), makeTicketId("T-A"), "Task A", "", "redmine", undefined, undefined, undefined, makeProjectId(a));
    await store.createTask(makeTaskId(taskB), makeTicketId("T-B"), "Task B", "", "redmine", undefined, undefined, undefined, makeProjectId(b));

    const user = await createUserAndLogin(admin, "taskscoped", "viewer");
    const viewerPolicy = (await store.listPolicies()).find((p) => p.name === "Viewer");
    await store.deleteBinding(viewerPolicy!.id, "user", user.user.id);
    const scoped = await store.createPolicy({ name: "Task-A-read" });
    await store.setPolicyRules(scoped.id, [{ permission: "task.read", resourceId: a }]);
    await store.createBinding({ policyId: scoped.id, principalType: "user", principalId: user.user.id });

    // Task list is filtered to project A only.
    const list = await fetch(`${baseUrl}/api/admin/tasks`, authed(user.token));
    const body = (await list.json()) as { tasks: Array<{ ticketId: string }> };
    expect(body.tasks.map((t) => t.ticketId)).toEqual(["T-A"]);

    // Detail for the out-of-scope task B is forbidden; A is allowed.
    expect((await fetch(`${baseUrl}/api/admin/tasks/${taskA}`, authed(user.token))).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/admin/tasks/${taskB}`, authed(user.token))).status).toBe(403);
  });
});
