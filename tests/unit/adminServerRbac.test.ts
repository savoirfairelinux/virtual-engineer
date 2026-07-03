import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { StateStore } from "../../src/interfaces.js";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { createAdminServer } from "../../src/admin/adminServer.js";
import { defaultRoleForMethod, roleSatisfies } from "../../src/admin/router.js";

const SECRET = "rbac-test-secret";

function hmacToken(secret: string = SECRET): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(timestamp.toString()).digest("hex");
  return `${timestamp}.${signature}`;
}

function tempDbPath(): string {
  return join(tmpdir(), `ve-rbac-${randomUUID()}.db`);
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

describe("role helpers", () => {
  it("defaults every method to operator (fail-closed; viewer access is opt-in)", () => {
    expect(defaultRoleForMethod("GET")).toBe("operator");
    expect(defaultRoleForMethod("head")).toBe("operator");
    expect(defaultRoleForMethod("POST")).toBe("operator");
    expect(defaultRoleForMethod("PUT")).toBe("operator");
    expect(defaultRoleForMethod("PATCH")).toBe("operator");
    expect(defaultRoleForMethod("DELETE")).toBe("operator");
  });

  it("orders roles admin > operator > viewer", () => {
    expect(roleSatisfies("admin", "admin")).toBe(true);
    expect(roleSatisfies("admin", "viewer")).toBe(true);
    expect(roleSatisfies("operator", "operator")).toBe(true);
    expect(roleSatisfies("operator", "admin")).toBe(false);
    expect(roleSatisfies("viewer", "operator")).toBe(false);
    expect(roleSatisfies("viewer", "viewer")).toBe(true);
  });
});

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
        headers: { authorization: `Bearer ${hmacToken()}`, "content-type": "application/json" },
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

  it("accepts legacy HMAC tokens everywhere while zero users exist", async () => {
    for (const path of ["/api/admin/status", "/api/admin/tasks", "/api/admin/prompts"]) {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { authorization: `Bearer ${hmacToken()}` },
      });
      expect(response.status).toBe(200);
    }

    // Mutations work too (bootstrap actor is treated as admin).
    const create = await fetch(`${baseUrl}/api/admin/prompts`, {
      method: "POST",
      headers: { authorization: `Bearer ${hmacToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ label: "Bootstrap Prompt", content: "hello" }),
    });
    expect(create.status).toBe(201);
  });

  it("rejects legacy HMAC tokens on normal routes once a user exists", async () => {
    const admin = await setupAndLogin("root", "password123", "admin");

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
    const admin = await setupAndLogin("root", "password123", "admin");
    const viewer = await setupAndLogin("vera", "password123", "viewer", admin);

    const me = await fetch(`${baseUrl}/api/admin/auth/me`, {
      headers: { authorization: `Bearer ${viewer.token}` },
    });
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toEqual({ id: viewer.user.id, username: "vera", role: "viewer" });
  });

  it("gives viewers access only to overview/tasks reads and 403 everywhere else", async () => {
    const admin = await setupAndLogin("root", "password123", "admin");
    const viewer = await setupAndLogin("vera", "password123", "viewer", admin);
    const headers = { authorization: `Bearer ${viewer.token}` };

    // Allowed: overview + tasks reads.
    for (const path of ["/api/admin/status", "/api/admin/tasks", "/api/admin/overview"]) {
      const response = await fetch(`${baseUrl}${path}`, { headers });
      expect(response.status, `viewer GET ${path}`).toBe(200);
    }

    // Forbidden: config-area reads now require operator.
    for (const path of ["/api/admin/prompts", "/api/admin/integrations", "/api/admin/agents", "/api/admin/projects"]) {
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
    await expect(mutate.json()).resolves.toEqual({ error: "forbidden", requiredRole: "operator" });
  });

  it("lets operators manage integrations/webhooks but 403s on user-management and audit", async () => {
    const admin = await setupAndLogin("root", "password123", "admin");
    const operator = await setupAndLogin("oscar", "password123", "operator", admin);

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
    await expect(operatorUsers.json()).resolves.toEqual({ error: "forbidden", requiredRole: "admin" });

    const operatorAudit = await fetch(`${baseUrl}/api/admin/audit`, {
      headers: { authorization: `Bearer ${operator.token}` },
    });
    expect(operatorAudit.status).toBe(403);
    await expect(operatorAudit.json()).resolves.toEqual({ error: "forbidden", requiredRole: "admin" });

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
      const response = await fetch(`${legacyBase}/api/admin/status`, {
        headers: { authorization: `Bearer ${hmacToken()}` },
      });
      expect(response.status).toBe(200);

      // Session auth is unavailable → setup-status reports no setup needed.
      const setupStatus = await fetch(`${legacyBase}/api/admin/auth/setup-status`);
      await expect(setupStatus.json()).resolves.toEqual({ needsSetup: false });
    } finally {
      await closeServer(legacyServer);
    }
  });
});
