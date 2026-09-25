import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { StateStore } from "../../src/interfaces.js";
import { makeTaskId, makeTicketId, makeProjectId, type AgentLogEvent } from "../../src/interfaces.js";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { createAdminServer } from "../../src/admin/adminServer.js";
import { agentLogBus, clearTaskEventBuffer, pushToTaskBuffer } from "../../src/agents/agentEventBus.js";
import { registerBuiltinPlugins } from "../../src/plugins/init.js";
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
    oAuthAppStore: store,
    promptStore: store,
    agentStore: store,
    projectStore: store,
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

  it("exposes only bootstrap auth routes while zero users exist", async () => {
    const setupStatus = await fetch(`${baseUrl}/api/admin/auth/setup-status`);
    expect(setupStatus.status).toBe(200);
      await expect(setupStatus.json()).resolves.toEqual({
        needsSetup: true,
        credentialEncryptionConfigured: true,
      });

    for (const path of ["/api/admin/status", "/api/admin/tasks", "/api/admin/prompts"]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(401);
    }

    const imageProxy = await fetch(`${baseUrl}/api/admin/img-proxy?url=https://gitlab.example.com/uploads/id/image.png`);
    expect(imageProxy.status).toBe(401);

    const create = await fetch(`${baseUrl}/api/admin/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Bootstrap Prompt", content: "hello", promptType: "instructions" }),
    });
    expect(create.status).toBe(401);
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

  it("rejects the raw session bearer token as the img-proxy ?t= query token", async () => {
    const admin = await setupAndLogin("root", "Str0ng-Pass-1x", "admin");

    const imageProxy = await fetch(
      `${baseUrl}/api/admin/img-proxy?url=https://gitlab.example.com/uploads/id/image.png&t=${admin.token}`
    );
    expect(imageProxy.status).toBe(401);
  });

  it("requires authentication to mint an image-proxy token", async () => {
    const noToken = await fetch(`${baseUrl}/api/admin/img-proxy/token`);
    expect(noToken.status).toBe(401);
  });

  it("mints a single-use image-proxy token that authorizes img-proxy exactly once", async () => {
    const admin = await setupAndLogin("root", "Str0ng-Pass-1x", "admin");

    const mint = await fetch(`${baseUrl}/api/admin/img-proxy/token`, {
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(mint.status).toBe(200);
    expect(mint.headers.get("cache-control")).toBe("no-store");
    const { token } = (await mint.json()) as { token: string; expiresAt: number };
    expect(token).not.toBe(admin.token);

    // No GitLab integration is configured in this test server, so a request
    // that passes auth still fails proxy-target validation (400) rather than
    // being rejected for auth (401) — this distinguishes the two failure modes.
    const firstUse = await fetch(
      `${baseUrl}/api/admin/img-proxy?url=https://gitlab.example.com/uploads/id/image.png&t=${token}`
    );
    expect(firstUse.status).toBe(400);

    const reuse = await fetch(
      `${baseUrl}/api/admin/img-proxy?url=https://gitlab.example.com/uploads/id/image.png&t=${token}`
    );
    expect(reuse.status).toBe(401);
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

  it("lets viewers read legacy resources but forbids mutations", async () => {
    const admin = await setupAndLogin("root", "Str0ng-Pass-1x", "admin");
    const viewer = await setupAndLogin("vera", "Str0ng-Pass-1x", "viewer", admin);
    const headers = { authorization: `Bearer ${viewer.token}` };

    for (const path of [
      "/api/admin/status",
      "/api/admin/tasks",
      "/api/admin/overview",
      "/api/admin/prompts",
      "/api/admin/integrations",
      "/api/admin/agents",
    ]) {
      const response = await fetch(`${baseUrl}${path}`, { headers });
      expect(response.status, `viewer GET ${path}`).toBe(200);
    }

    // Forbidden: mutations.
    const mutate = await fetch(`${baseUrl}/api/admin/prompts`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ label: "Nope", content: "nope" }),
    });
    expect(mutate.status).toBe(403);
    await expect(mutate.json()).resolves.toEqual({ error: "forbidden", permission: "prompt.create" });
  });

  it("lets operators create resources but denies arbitrary integration and admin access", async () => {
    const admin = await setupAndLogin("root", "Str0ng-Pass-1x", "admin");
    const operator = await setupAndLogin("oscar", "Str0ng-Pass-1x", "operator", admin);

    // Operator can perform regular mutations (prompts CRUD).
    const promptCreate = await fetch(`${baseUrl}/api/admin/prompts`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator.token}`, "content-type": "application/json" },
      body: JSON.stringify({ label: "Operator Prompt", content: "hello", promptType: "instructions" }),
    });
    expect(promptCreate.status).toBe(201);

    const integrationPut = await fetch(`${baseUrl}/api/admin/integrations/some-id`, {
      method: "PUT",
      headers: { authorization: `Bearer ${operator.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(integrationPut.status).toBe(403);

    const rotate = await fetch(`${baseUrl}/api/admin/integrations/some-id/webhook-secret/rotate`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator.token}` },
    });
    expect(rotate.status).toBe(403);

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
      allowUnauthenticatedAdmin: true,
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
      await expect(setupStatus.json()).resolves.toEqual({
        needsSetup: false,
        credentialEncryptionConfigured: false,
      });
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
      oAuthAppStore: store,
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
      concurrency: {
        snapshot: () => ({
          global: 2,
          perProject: { "concurrency-project": 1 },
          perAgent: { "concurrency-agent": 1 },
        }),
      },
      providers: [
        {
          id: "admin-api",
          name: "Admin API",
          category: "runtime",
          domainCapabilities: [],
          intake: {},
          enabled: true,
          configured: true,
          status: "ready",
          details: ["runtime"],
        },
        {
          id: "private-provider-summary",
          name: "Private Provider Summary",
          category: "ticketing",
          domainCapabilities: ["issue_tracking"],
          intake: { issue_tracking: ["polling"] },
          enabled: true,
          configured: true,
          status: "ready",
          details: ["private detail"],
        },
      ],
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
    const owner = (await store.listUsers()).find((user) => user.role === "admin");
    const agent = await store.createAgent({
      name: "rev-agent", type: "review", modelConfigJson: "{}",
      systemPromptId: "system_generic_code", instructionsPromptId: "instructions_generic_code",
      ownerUserId: owner?.id ?? null,
    });
    const a = await store.createProject({
      name: "Project A", type: "review", agentId: agent.id, ownerUserId: owner?.id ?? null,
    });
    const b = await store.createProject({
      name: "Project B", type: "review", agentId: agent.id, ownerUserId: owner?.id ?? null,
    });
    return { a: a.id, b: b.id };
  }

  function authed(token: string): { headers: Record<string, string> } {
    return { headers: { authorization: `Bearer ${token}` } };
  }

  it("keeps built-in prompts read-only even for administrators", async () => {
    const admin = await setupAdmin();
    const original = await store.getPrompt("system_generic_code");
    const response = await fetch(`${baseUrl}/api/admin/prompts/system_generic_code`, {
      method: "PUT",
      headers: { ...authed(admin.token).headers, "content-type": "application/json" },
      body: JSON.stringify({ content: "global replacement" }),
    });
    expect(response.status).toBe(409);
    expect((await store.getPrompt("system_generic_code"))?.content).toBe(original?.content);
  });

  it("creates private independent copies of a shared template with the same label", async () => {
    const admin = await setupAdmin();
    const owner = await createUserAndLogin(admin, "copy-owner", "operator");
    const peer = await createUserAndLogin(admin, "copy-peer", "operator");
    const template = await store.getPrompt("system_generic_code");
    const copies: Array<{ id: string; ownerUserId: string }> = [];
    for (const session of [owner, peer]) {
      const response = await fetch(`${baseUrl}/api/admin/prompts`, {
        method: "POST",
        headers: { ...authed(session.token).headers, "content-type": "application/json" },
        body: JSON.stringify({ label: template!.label, content: template!.content, promptType: "system" }),
      });
      expect(response.status).toBe(201);
      const body = await response.json() as { prompt: { id: string; ownerUserId: string } };
      expect(body.prompt.ownerUserId).toBe(session.user.id);
      copies.push(body.prompt);
    }
    expect(copies[0]!.id).not.toBe(copies[1]!.id);
    const update = await fetch(`${baseUrl}/api/admin/prompts/${copies[0]!.id}`, {
      method: "PUT",
      headers: { ...authed(owner.token).headers, "content-type": "application/json" },
      body: JSON.stringify({ content: "private customization" }),
    });
    expect(update.status).toBe(200);
    expect((await store.getPrompt(copies[1]!.id))?.content).toBe(template!.content);
    expect((await store.getPrompt(template!.id))?.content).toBe(template!.content);
    expect((await fetch(`${baseUrl}/api/admin/prompts/${copies[0]!.id}`, authed(peer.token))).status).toBe(403);
  });

  it("makes demoted viewers read-only despite ownership and explicit policy grants", async () => {
    const admin = await setupAdmin();
    const operator = await createUserAndLogin(admin, "demoted-owner", "operator");
    const prompt = await store.createPrompt("Owned before demotion", "original", "instructions", operator.user.id);
    const policy = await store.createPolicy({ name: "Explicit write grant" });
    await store.setPolicyRules(policy.id, [{ permission: "prompt.write", resourceId: prompt.id }]);
    await store.createBinding({ policyId: policy.id, principalType: "user", principalId: operator.user.id });
    const demotion = await fetch(`${baseUrl}/api/admin/users/${operator.user.id}`, {
      method: "PUT",
      headers: { ...authed(admin.token).headers, "content-type": "application/json" },
      body: JSON.stringify({ role: "viewer" }),
    });
    expect(demotion.status).toBe(200);
    expect((await fetch(`${baseUrl}/api/admin/prompts/${prompt.id}`, authed(operator.token))).status).toBe(200);
    for (const [method, path, body] of [
      ["PUT", `/api/admin/prompts/${prompt.id}`, { content: "changed" }],
      ["POST", "/api/admin/prompts", { label: "New prompt", content: "new", promptType: "instructions" }],
      ["DELETE", `/api/admin/prompts/${prompt.id}`, {}],
      ["PUT", "/api/admin/settings", { maxAgentCycles: 2 }],
    ] as const) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { ...authed(operator.token).headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
    expect((await store.getPrompt(prompt.id))?.content).toBe("original");
    const bindings = await store.listBindingsForPrincipal("user", operator.user.id);
    expect(bindings.some(binding => binding.policyId === "builtin:operator")).toBe(false);
    expect(bindings.some(binding => binding.policyId === "builtin:viewer")).toBe(true);
    expect(bindings.some(binding => binding.policyId === policy.id)).toBe(true);
  });

  it("grants the operator creation bundle when promoting a viewer", async () => {
    const admin = await setupAdmin();
    const viewer = await createUserAndLogin(admin, "promoted-viewer", "viewer");
    const promotion = await fetch(`${baseUrl}/api/admin/users/${viewer.user.id}`, {
      method: "PUT",
      headers: { ...authed(admin.token).headers, "content-type": "application/json" },
      body: JSON.stringify({ role: "operator" }),
    });
    expect(promotion.status).toBe(200);
    const create = await fetch(`${baseUrl}/api/admin/prompts`, {
      method: "POST",
      headers: { ...authed(viewer.token).headers, "content-type": "application/json" },
      body: JSON.stringify({ label: "After promotion", content: "new", promptType: "instructions" }),
    });
    expect(create.status).toBe(201);
  });

  it("denies global settings writes to the default operator", async () => {
    const admin = await setupAdmin();
    const operator = await createUserAndLogin(admin, "settings-operator", "operator");
    const response = await fetch(`${baseUrl}/api/admin/settings`, {
      method: "PUT",
      headers: { ...authed(operator.token).headers, "content-type": "application/json" },
      body: JSON.stringify({ maxAgentCycles: 2 }),
    });
    expect(response.status).toBe(403);
  });

  it("isolates owned prompts and allows scoped group sharing", async () => {
    const admin = await setupAdmin();
    const owner = await createUserAndLogin(admin, "prompt-owner", "operator");
    const peer = await createUserAndLogin(admin, "prompt-peer", "operator");

    const create = await fetch(`${baseUrl}/api/admin/prompts`, {
      method: "POST",
      headers: {
        ...authed(owner.token).headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        label: "Private Prompt",
        content: "owner only",
        promptType: "instructions",
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      prompt: { id: string; ownerUserId: string | null };
    };
    expect(created.prompt.ownerUserId).toBe(owner.user.id);

    const ownerList = await fetch(`${baseUrl}/api/admin/prompts`, authed(owner.token));
    const ownerBody = (await ownerList.json()) as { prompts: Array<{ id: string }> };
    expect(ownerBody.prompts.some((prompt) => prompt.id === created.prompt.id)).toBe(true);

    const peerList = await fetch(`${baseUrl}/api/admin/prompts`, authed(peer.token));
    const peerBody = (await peerList.json()) as { prompts: Array<{ id: string }> };
    expect(peerBody.prompts.some((prompt) => prompt.id === created.prompt.id)).toBe(false);
    expect((await fetch(
      `${baseUrl}/api/admin/prompts/${created.prompt.id}`,
      authed(peer.token)
    )).status).toBe(403);

    const group = await store.createGroup({ name: "Prompt readers" });
    await store.addUserToGroup(group.id, peer.user.id);
    const policy = await store.createPolicy({ name: "Private prompt readers" });
    await store.setPolicyRules(policy.id, [{
      permission: "prompt.read",
      resourceId: created.prompt.id,
    }]);
    await store.createBinding({
      policyId: policy.id,
      principalType: "group",
      principalId: group.id,
    });

    const sharedList = await fetch(`${baseUrl}/api/admin/prompts`, authed(peer.token));
    const sharedBody = (await sharedList.json()) as { prompts: Array<{ id: string }> };
    expect(sharedBody.prompts.some((prompt) => prompt.id === created.prompt.id)).toBe(true);
    expect((await fetch(
      `${baseUrl}/api/admin/prompts/${created.prompt.id}`,
      authed(peer.token)
    )).status).toBe(200);
  });

  it("isolates owned agents and integrations unless shared with a group", async () => {
    const admin = await setupAdmin();
    const owner = await createUserAndLogin(admin, "resource-owner", "operator");
    const peer = await createUserAndLogin(admin, "resource-peer", "operator");
    const integration = await store.upsertIntegration({
      id: "private-integration",
      provider: "redmine",
      name: "Private integration",
      configJson: "{}",
      enabled: true,
      ownerUserId: owner.user.id,
    });
    const agent = await store.createAgent({
      name: "Private agent",
      type: "coding",
      modelConfigJson: "{}",
      integrationId: integration.id,
      systemPromptId: "system_generic_code",
      instructionsPromptId: "instructions_generic_code",
      ownerUserId: owner.user.id,
    });

    const ownerAgents = await fetch(`${baseUrl}/api/admin/agents`, authed(owner.token));
    const ownerAgentBody = (await ownerAgents.json()) as { agents: Array<{ id: string }> };
    expect(ownerAgentBody.agents.some((candidate) => candidate.id === agent.id)).toBe(true);
    const ownerIntegrations = await fetch(`${baseUrl}/api/admin/integrations`, authed(owner.token));
    const ownerIntegrationBody = (await ownerIntegrations.json()) as { integrations: Array<{ id: string }> };
    expect(ownerIntegrationBody.integrations.some((candidate) => candidate.id === integration.id)).toBe(true);

    const peerAgents = await fetch(`${baseUrl}/api/admin/agents`, authed(peer.token));
    const peerAgentBody = (await peerAgents.json()) as { agents: Array<{ id: string }> };
    expect(peerAgentBody.agents.some((candidate) => candidate.id === agent.id)).toBe(false);
    const peerIntegrations = await fetch(`${baseUrl}/api/admin/integrations`, authed(peer.token));
    const peerIntegrationBody = (await peerIntegrations.json()) as { integrations: Array<{ id: string }> };
    expect(peerIntegrationBody.integrations.some((candidate) => candidate.id === integration.id)).toBe(false);
    expect((await fetch(`${baseUrl}/api/admin/agents/${agent.id}`, authed(peer.token))).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/admin/integrations/${integration.id}`, authed(peer.token))).status).toBe(403);
    expect((await fetch(
      `${baseUrl}/api/admin/integrations/${integration.id}/models/discover`,
      { ...authed(peer.token), method: "POST" },
    )).status).toBe(403);
    expect((await fetch(
      `${baseUrl}/api/admin/integrations/${integration.id}/discover`,
      { ...authed(peer.token), method: "POST" },
    )).status).toBe(403);

    const group = await store.createGroup({ name: "Resource readers" });
    await store.addUserToGroup(group.id, peer.user.id);
    const policy = await store.createPolicy({ name: "Private resource readers" });
    await store.setPolicyRules(policy.id, [
      { permission: "agent.read", resourceId: agent.id },
      { permission: "integration.read", resourceId: integration.id },
    ]);
    await store.createBinding({
      policyId: policy.id,
      principalType: "group",
      principalId: group.id,
    });

    expect((await fetch(`${baseUrl}/api/admin/agents/${agent.id}`, authed(peer.token))).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/admin/integrations/${integration.id}`, authed(peer.token))).status).toBe(200);
    expect((await fetch(
      `${baseUrl}/api/admin/integrations/${integration.id}/models/discover`,
      { ...authed(peer.token), method: "POST" },
    )).status).toBe(400);
    expect((await fetch(
      `${baseUrl}/api/admin/integrations/${integration.id}/discover`,
      { ...authed(peer.token), method: "POST" },
    )).status).toBe(403);
  });

  it("does not let integration.create overwrite another owner's integration id", async () => {
    registerBuiltinPlugins();
    const admin = await setupAdmin();
    const owner = await createUserAndLogin(admin, "overwrite-owner", "operator");
    const peer = await createUserAndLogin(admin, "overwrite-peer", "operator");
    await store.upsertIntegration({
      id: "protected-integration",
      provider: "redmine",
      name: "Protected integration",
      configJson: "{}",
      enabled: true,
      ownerUserId: owner.user.id,
    });

    const response = await fetch(`${baseUrl}/api/admin/integrations`, {
      method: "POST",
      headers: {
        ...authed(peer.token).headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "protected-integration",
        provider: "redmine",
        name: "Overwritten",
        config: {},
      }),
    });

    expect(response.status).toBe(409);
    await expect(store.getIntegration("protected-integration")).resolves.toMatchObject({
      name: "Protected integration",
      ownerUserId: owner.user.id,
    });
  });

  it("does not expose private project counts through a shared agent", async () => {
    const admin = await setupAdmin();
    const owner = await createUserAndLogin(admin, "agent-count-owner", "operator");
    const peer = await createUserAndLogin(admin, "agent-count-peer", "viewer");
    const integration = await store.upsertIntegration({
      id: "agent-count-private-integration",
      provider: "copilot",
      name: "Private linked integration",
      configJson: "{}",
      enabled: true,
      ownerUserId: owner.user.id,
    });
    const agent = await store.createAgent({
      name: "Shared agent only",
      type: "coding",
      modelConfigJson: "{}",
      integrationId: integration.id,
      systemPromptId: "system_generic_code",
      instructionsPromptId: "instructions_generic_code",
      ownerUserId: owner.user.id,
    });
    await store.createProject({
      name: "Hidden agent project",
      type: "coding",
      agentId: agent.id,
      ownerUserId: owner.user.id,
    });
    const group = await store.createGroup({ name: "Agent-only readers" });
    await store.addUserToGroup(group.id, peer.user.id);
    const policy = await store.createPolicy({ name: "Shared agent read" });
    await store.setPolicyRules(policy.id, [{ permission: "agent.read", resourceId: agent.id }]);
    await store.createBinding({ policyId: policy.id, principalType: "group", principalId: group.id });

    const response = await fetch(`${baseUrl}/api/admin/agents/${agent.id}`, authed(peer.token));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      agent: { projectCount: 0, integrationId: null },
    });
    expect((await fetch(
      `${baseUrl}/api/admin/agents/${agent.id}/available-models`,
      authed(peer.token)
    )).status).toBe(403);
  });

  it("returns a generic conflict when a hidden project references an owned agent", async () => {
    const admin = await setupAdmin();
    const owner = await createUserAndLogin(admin, "agent-delete-owner", "operator");
    const projectOwner = await createUserAndLogin(admin, "hidden-project-owner", "operator");
    const agent = await store.createAgent({
      name: "Agent with hidden reference",
      type: "coding",
      modelConfigJson: "{}",
      systemPromptId: "system_generic_code",
      instructionsPromptId: "instructions_generic_code",
      ownerUserId: owner.user.id,
    });
    await store.createProject({
      name: "Hidden referencing project",
      type: "coding",
      agentId: agent.id,
      ownerUserId: projectOwner.user.id,
    });

    const response = await fetch(`${baseUrl}/api/admin/agents/${agent.id}`, {
      method: "DELETE",
      ...authed(owner.token),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Conflict",
      message: "Agent is referenced by one or more projects and cannot be deleted",
    });
    await expect(store.getAgentById(agent.id)).resolves.not.toBeNull();
  });

  it("rejects cross-owner prompt references when creating an agent", async () => {
    const admin = await setupAdmin();
    const owner = await createUserAndLogin(admin, "reference-owner", "operator");
    const peer = await createUserAndLogin(admin, "reference-peer", "operator");
    const systemPrompt = await store.createPrompt(
      "Private System Prompt",
      "private system",
      "system",
      owner.user.id
    );
    const instructionsPrompt = await store.createPrompt(
      "Private Instructions Prompt",
      "private instructions",
      "instructions",
      owner.user.id
    );

    const response = await fetch(`${baseUrl}/api/admin/agents`, {
      method: "POST",
      headers: {
        ...authed(peer.token).headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Cross-owner agent",
        type: "coding",
        modelConfig: {},
        systemPromptId: systemPrompt.id,
        instructionsPromptId: instructionsPrompt.id,
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "forbidden",
      permission: "prompt.read",
    });
  });

  it("rejects cross-owner agent references when creating a project", async () => {
    registerBuiltinPlugins();
    const admin = await setupAdmin();
    const owner = await createUserAndLogin(admin, "project-ref-owner", "operator");
    const peer = await createUserAndLogin(admin, "project-ref-peer", "operator");
    const executionIntegration = await store.upsertIntegration({
      id: "private-review-engine",
      provider: "copilot",
      name: "Private review engine",
      configJson: "{}",
      enabled: true,
      ownerUserId: owner.user.id,
    });
    const reviewIntegration = await store.upsertIntegration({
      id: "private-gerrit",
      provider: "gerrit",
      name: "Private Gerrit",
      configJson: "{}",
      enabled: true,
      ownerUserId: owner.user.id,
    });
    const agent = await store.createAgent({
      name: "Private review agent",
      type: "review",
      modelConfigJson: "{}",
      integrationId: executionIntegration.id,
      systemPromptId: "system_review",
      instructionsPromptId: "instructions_review",
      ownerUserId: owner.user.id,
    });

    const response = await fetch(`${baseUrl}/api/admin/projects`, {
      method: "POST",
      headers: {
        ...authed(peer.token).headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "review",
        name: "Cross-owner project",
        agentId: agent.id,
        reviewConfig: {
          integrationId: reviewIntegration.id,
          repoKeys: ["org/repo"],
        },
      }),
    });

    const responseBody = await response.json();
    expect(responseBody).toEqual({
      error: "forbidden",
      permission: "agent.read",
    });
    expect(response.status).toBe(403);
  });

  it("scopes webhook management to the integration owner", async () => {
    const admin = await setupAdmin();
    const owner = await createUserAndLogin(admin, "webhook-owner", "operator");
    const peer = await createUserAndLogin(admin, "webhook-peer", "operator");
    const integration = await store.upsertIntegration({
      id: "webhook-private",
      provider: "redmine",
      name: "Private webhook",
      configJson: "{}",
      enabled: true,
      ownerUserId: owner.user.id,
    });

    expect((await fetch(
      `${baseUrl}/api/admin/integrations/${integration.id}/webhook-secret/rotate`,
      { method: "POST", ...authed(peer.token) }
    )).status).toBe(403);

    const ownerResponse = await fetch(
      `${baseUrl}/api/admin/integrations/${integration.id}/webhook-secret/rotate`,
      { method: "POST", ...authed(owner.token) }
    );
    expect(ownerResponse.status).toBe(200);
  });

  it("rejects OAuth flows against another user's integration", async () => {
    registerBuiltinPlugins();
    const admin = await setupAdmin();
    const owner = await createUserAndLogin(admin, "oauth-flow-owner", "operator");
    const peer = await createUserAndLogin(admin, "oauth-flow-peer", "operator");
    const integration = await store.upsertIntegration({
      id: "private-oauth-flow",
      provider: "copilot",
      name: "Private OAuth flow",
      configJson: "{}",
      enabled: true,
      ownerUserId: owner.user.id,
    });

    const response = await fetch(`${baseUrl}/api/admin/plugins/copilot/oauth/device-code`, {
      method: "POST",
      headers: {
        ...authed(peer.token).headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({ integrationId: integration.id, config: {} }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "forbidden",
      permission: "integration.write",
    });
  });

  it("rejects user bindings on dynamic system policies", async () => {
    const admin = await setupAdmin();
    const user = await createUserAndLogin(admin, "unsafe-binding-user", "viewer");
    const resourceOwner = (await store.listPolicies()).find((policy) => policy.name === "Resource Owner");
    expect(resourceOwner).toBeDefined();

    const response = await fetch(
      `${baseUrl}/api/admin/policies/${resourceOwner!.id}/bindings`,
      {
        method: "POST",
        headers: {
          ...authed(admin.token).headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({ principalType: "user", principalId: user.user.id }),
      }
    );

    expect(response.status).toBe(409);
  });

  it("rejects deleting a user who still owns resources without partial cleanup", async () => {
    const admin = await setupAdmin();
    const owner = await createUserAndLogin(admin, "delete-owner", "operator");
    await store.createPrompt("Delete-owned Prompt", "private", "instructions", owner.user.id);
    const bindingsBefore = await store.listBindingsForPrincipal("user", owner.user.id);

    const response = await fetch(`${baseUrl}/api/admin/users/${owner.user.id}`, {
      method: "DELETE",
      ...authed(admin.token),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "User still owns resources; delete or reassign them first",
    });
    await expect(store.getUserById(owner.user.id)).resolves.not.toBeNull();
    await expect(store.listBindingsForPrincipal("user", owner.user.id)).resolves.toEqual(bindingsBefore);
  });

  it("isolates OAuth apps by owner and supports scoped group reads", async () => {
    const admin = await setupAdmin();
    const owner = await createUserAndLogin(admin, "oauth-app-owner", "operator");
    const peer = await createUserAndLogin(admin, "oauth-app-peer", "operator");

    const create = await fetch(`${baseUrl}/api/admin/oauth-apps`, {
      method: "POST",
      headers: {
        ...authed(owner.token).headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "gitlab",
        baseUrl: "https://gitlab.example.com/",
        clientId: "private-client",
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      app: { provider: string; baseUrl: string; ownerUserId: string | null };
    };
    expect(created.app.ownerUserId).toBe(owner.user.id);

    const peerList = await fetch(`${baseUrl}/api/admin/oauth-apps`, authed(peer.token));
    const peerBody = (await peerList.json()) as { apps: Array<{ baseUrl: string }> };
    expect(peerBody.apps).toEqual([]);

    const resolveBeforeShare = await fetch(`${baseUrl}/api/admin/oauth-apps/resolve`, {
      method: "POST",
      headers: {
        ...authed(peer.token).headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({ provider: "gitlab", baseUrl: created.app.baseUrl }),
    });
    expect(resolveBeforeShare.status).toBe(403);

    const group = await store.createGroup({ name: "OAuth readers" });
    await store.addUserToGroup(group.id, peer.user.id);
    const policy = await store.createPolicy({ name: "Scoped OAuth reader" });
    await store.setPolicyRules(policy.id, [{
      permission: "oauth.read",
      resourceId: `gitlab|${created.app.baseUrl}`,
    }]);
    await store.createBinding({
      policyId: policy.id,
      principalType: "group",
      principalId: group.id,
    });

    const sharedList = await fetch(`${baseUrl}/api/admin/oauth-apps`, authed(peer.token));
    const sharedBody = (await sharedList.json()) as { apps: Array<{ baseUrl: string }> };
    expect(sharedBody.apps).toEqual([expect.objectContaining({ baseUrl: created.app.baseUrl })]);
  });

  it.each(["operator", "viewer"])("lets delegated %s groups read tasks with role-bounded delegation", async (role) => {
    const admin = await setupAdmin();
    const owner = await createUserAndLogin(admin, "task-owner", "operator");
    const delegate = await createUserAndLogin(admin, "task-delegate", role);
    const agent = await store.createAgent({
      name: "Task owner agent",
      type: "coding",
      modelConfigJson: "{}",
      systemPromptId: "system_generic_code",
      instructionsPromptId: "instructions_generic_code",
      ownerUserId: owner.user.id,
    });
    const project = await store.createProject({
      name: "Task owner project",
      type: "coding",
      agentId: agent.id,
      ownerUserId: owner.user.id,
    });
    const taskId = randomUUID();
    await store.createTask(
      makeTaskId(taskId),
      makeTicketId("OWN-1"),
      "Owned task",
      "",
      "redmine",
      undefined,
      undefined,
      undefined,
      project.id
    );

    const ownerList = await fetch(`${baseUrl}/api/admin/tasks`, authed(owner.token));
    const ownerBody = (await ownerList.json()) as { tasks: Array<{ ticketId: string }> };
    expect(ownerBody.tasks.map((task) => task.ticketId)).toContain("OWN-1");

    const delegateBefore = await fetch(`${baseUrl}/api/admin/tasks`, authed(delegate.token));
    const delegateBeforeBody = (await delegateBefore.json()) as { tasks: Array<{ ticketId: string }> };
    expect(delegateBeforeBody.tasks.map((task) => task.ticketId)).not.toContain("OWN-1");

    const group = await store.createGroup({ name: "Delegated project owners" });
    await store.addUserToGroup(group.id, delegate.user.id);
    const delegateAccess = await fetch(
      `${baseUrl}/api/admin/projects/${project.id}/access/groups/${group.id}`,
      {
        method: "PUT",
        headers: {
          ...authed(owner.token).headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          permissions: ["project.read", "project.owner", "task.read"],
        }),
      }
    );
    expect(delegateAccess.status).toBe(200);

    const accessList = await fetch(
      `${baseUrl}/api/admin/projects/${project.id}/access`,
      authed(owner.token)
    );
    expect(accessList.status).toBe(200);
    await expect(accessList.json()).resolves.toEqual({
      grants: [expect.objectContaining({
        groupId: group.id,
        permissions: ["project.owner", "project.read", "task.read"],
      })],
      availableGroups: [expect.objectContaining({ id: group.id, name: group.name })],
    });

    const delegateAfter = await fetch(`${baseUrl}/api/admin/tasks`, authed(delegate.token));
    const delegateAfterBody = (await delegateAfter.json()) as { tasks: Array<{ ticketId: string }> };
    expect(delegateAfterBody.tasks.map((task) => task.ticketId)).toContain("OWN-1");
    expect((await fetch(`${baseUrl}/api/admin/tasks/${taskId}`, authed(delegate.token))).status).toBe(200);

    const downstreamGroup = await store.createGroup({ name: "Downstream project readers" });
    const redelegate = await fetch(
      `${baseUrl}/api/admin/projects/${project.id}/access/groups/${downstreamGroup.id}`,
      {
        method: "PUT",
        headers: {
          ...authed(delegate.token).headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({ permissions: ["project.read", "task.read"] }),
      }
    );
    expect(redelegate.status).toBe(role === "viewer" ? 403 : 200);

    const revoke = await fetch(
      `${baseUrl}/api/admin/projects/${project.id}/access/groups/${group.id}`,
      { method: "DELETE", ...authed(owner.token) }
    );
    expect(revoke.status).toBe(204);
    expect((await fetch(`${baseUrl}/api/admin/tasks/${taskId}`, authed(delegate.token))).status).toBe(403);
  });

  it("automatically shares linked resources with project groups and keeps old links after agent changes", async () => {
    const admin = await setupAdmin();
    const member = await createUserAndLogin(admin, "linked-resource-member", "operator");
    registerBuiltinPlugins();

    const oldAgentIntegration = await store.upsertIntegration({
      id: "snapshot-agent-old",
      provider: "copilot",
      name: "Old agent integration",
      configJson: "{}",
      enabled: true,
      ownerUserId: admin.user.id,
    });
    const ticketIntegration = await store.upsertIntegration({
      id: "snapshot-ticket",
      provider: "redmine",
      name: "Ticket integration",
      configJson: "{}",
      enabled: true,
      ownerUserId: admin.user.id,
    });
    const pushIntegration = await store.upsertIntegration({
      id: "snapshot-push",
      provider: "gerrit",
      name: "Push integration",
      configJson: "{}",
      enabled: true,
      ownerUserId: admin.user.id,
    });
    const oldSystemPrompt = await store.createPrompt("Old system", "old system", "system", admin.user.id);
    const oldInstructionsPrompt = await store.createPrompt("Old instructions", "old instructions", "instructions", admin.user.id);
    const oldAgent = await store.createAgent({
      name: "Old linked agent",
      type: "coding",
      modelConfigJson: "{}",
      integrationId: oldAgentIntegration.id,
      systemPromptId: oldSystemPrompt.id,
      instructionsPromptId: oldInstructionsPrompt.id,
      enabled: true,
      ownerUserId: admin.user.id,
    });
    const project = await store.createProject({
      name: "Linked resource project",
      type: "coding",
      agentId: oldAgent.id,
      ownerUserId: admin.user.id,
    });
    await store.setProjectTicketSource(project.id, { integrationId: ticketIntegration.id, ticketProjectKey: "JAMI" });
    await store.replaceProjectPushTargets(project.id, [{
      integrationId: pushIntegration.id,
      repoKey: "jami/client",
      cloneUrl: "ssh://gerrit.example.com/jami/client",
      targetBranch: "main",
      role: "primary",
      commitOrder: 1,
      localPath: ".",
    }]);

    const group = await store.createGroup({ name: "Linked resource readers" });
    await store.addUserToGroup(group.id, member.user.id);
    const access = await fetch(`${baseUrl}/api/admin/projects/${project.id}/access/groups/${group.id}`, {
      method: "PUT",
      headers: { ...authed(admin.token).headers, "content-type": "application/json" },
      body: JSON.stringify({ permissions: ["project.read", "task.read"] }),
    });
    expect(access.status).toBe(200);

    const policyId = `project-access:${project.id}:group:${group.id}`;
    const oldLinkedRules = await store.listPolicyRules(policyId);
    const expectedOldResources = [
      ["agent.read", oldAgent.id], ["agent.write", oldAgent.id],
      ["integration.read", oldAgentIntegration.id], ["integration.write", oldAgentIntegration.id],
      ["integration.read", ticketIntegration.id], ["integration.write", ticketIntegration.id],
      ["integration.read", pushIntegration.id], ["integration.write", pushIntegration.id],
      ["prompt.read", oldSystemPrompt.id], ["prompt.write", oldSystemPrompt.id],
      ["prompt.read", oldInstructionsPrompt.id], ["prompt.write", oldInstructionsPrompt.id],
    ];
    expect(oldLinkedRules).toEqual(expect.arrayContaining(expectedOldResources.map(([permission, resourceId]) =>
      expect.objectContaining({ permission, resourceId })
    )));

    for (const path of [
      `/api/admin/agents/${oldAgent.id}`,
      `/api/admin/integrations/${oldAgentIntegration.id}`,
      `/api/admin/integrations/${ticketIntegration.id}`,
      `/api/admin/integrations/${pushIntegration.id}`,
      `/api/admin/prompts/${oldSystemPrompt.id}`,
      `/api/admin/prompts/${oldInstructionsPrompt.id}`,
    ]) {
      expect((await fetch(`${baseUrl}${path}`, authed(member.token))).status).toBe(200);
    }
    const agentEdit = await fetch(`${baseUrl}/api/admin/agents/${oldAgent.id}`, {
      method: "PUT",
      headers: { ...authed(member.token).headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Edited linked agent" }),
    });
    expect(agentEdit.status).toBe(200);
    const promptEdit = await fetch(`${baseUrl}/api/admin/prompts/${oldSystemPrompt.id}`, {
      method: "PUT",
      headers: { ...authed(member.token).headers, "content-type": "application/json" },
      body: JSON.stringify({ content: "Updated by linked-resource group member" }),
    });
    expect(promptEdit.status).toBe(200);

    const newAgentIntegration = await store.upsertIntegration({
      id: "snapshot-agent-new",
      provider: "copilot",
      name: "New agent integration",
      configJson: "{}",
      enabled: true,
      ownerUserId: admin.user.id,
    });
    const newSystemPrompt = await store.createPrompt("New system", "new system", "system", admin.user.id);
    const newInstructionsPrompt = await store.createPrompt("New instructions", "new instructions", "instructions", admin.user.id);
    const newAgent = await store.createAgent({
      name: "New linked agent",
      type: "coding",
      modelConfigJson: "{}",
      integrationId: newAgentIntegration.id,
      systemPromptId: newSystemPrompt.id,
      instructionsPromptId: newInstructionsPrompt.id,
      enabled: true,
      ownerUserId: admin.user.id,
    });
    const update = await fetch(`${baseUrl}/api/admin/projects/${project.id}`, {
      method: "PUT",
      headers: { ...authed(admin.token).headers, "content-type": "application/json" },
      body: JSON.stringify({ agentId: newAgent.id }),
    });
    expect(update.status).toBe(200);

    const allLinkedRules = await store.listPolicyRules(policyId);
    const expectedAllResources = [
      ...expectedOldResources,
      ["agent.read", newAgent.id], ["agent.write", newAgent.id],
      ["integration.read", newAgentIntegration.id], ["integration.write", newAgentIntegration.id],
      ["prompt.read", newSystemPrompt.id], ["prompt.write", newSystemPrompt.id],
      ["prompt.read", newInstructionsPrompt.id], ["prompt.write", newInstructionsPrompt.id],
    ];
    expect(allLinkedRules).toEqual(expect.arrayContaining(expectedAllResources.map(([permission, resourceId]) =>
      expect.objectContaining({ permission, resourceId })
    )));
    for (const path of [
      `/api/admin/agents/${newAgent.id}`,
      `/api/admin/integrations/${newAgentIntegration.id}`,
      `/api/admin/prompts/${newSystemPrompt.id}`,
      `/api/admin/prompts/${newInstructionsPrompt.id}`,
    ]) {
      expect((await fetch(`${baseUrl}${path}`, authed(member.token))).status).toBe(200);
    }
  });

  it("fails closed when a task project owner cannot be resolved", async () => {
    const admin = await setupAdmin();
    const owner = await createUserAndLogin(admin, "unresolved-task-owner", "operator");
    const peer = await createUserAndLogin(admin, "unresolved-task-peer", "viewer");
    const agent = await store.createAgent({
      name: "Unresolved task agent",
      type: "coding",
      modelConfigJson: "{}",
      systemPromptId: "system_generic_code",
      instructionsPromptId: "instructions_generic_code",
      ownerUserId: owner.user.id,
    });
    const project = await store.createProject({
      name: "Unresolved task project",
      type: "coding",
      agentId: agent.id,
      ownerUserId: owner.user.id,
    });
    const taskId = randomUUID();
    await store.createTask(
      makeTaskId(taskId),
      makeTicketId("UNRESOLVED-1"),
      "Unresolved owner task",
      "",
      "redmine",
      undefined,
      undefined,
      undefined,
      project.id
    );
    vi.spyOn(store, "getProjectById").mockResolvedValue(null);

    const response = await fetch(`${baseUrl}/api/admin/tasks/${taskId}`, authed(peer.token));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "forbidden",
      permission: "task.read",
    });
  });

  it("does not reveal private agents through legacy prompt usage", async () => {
    const admin = await setupAdmin();
    const owner = await createUserAndLogin(admin, "usage-owner", "operator");
    const peer = await createUserAndLogin(admin, "usage-peer", "viewer");
    await store.createAgent({
      name: "Hidden prompt consumer",
      type: "coding",
      modelConfigJson: "{}",
      systemPromptId: "system_generic_code",
      instructionsPromptId: "instructions_generic_code",
      feedbackInstructionsPromptId: "system_generic_code",
      ownerUserId: owner.user.id,
    });

    const ownerList = await fetch(`${baseUrl}/api/admin/prompts`, authed(owner.token));
    expect(ownerList.status).toBe(200);
    const ownerListBody = await ownerList.json() as { prompts: Array<{ id: string; usedByCount?: number }> };
    expect(ownerListBody.prompts.find((prompt) => prompt.id === "system_generic_code")?.usedByCount).toBe(1);

    const response = await fetch(
      `${baseUrl}/api/admin/prompts/system_generic_code/usage`,
      authed(peer.token)
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      promptId: "system_generic_code",
      agents: [],
    });

    const peerList = await fetch(`${baseUrl}/api/admin/prompts`, authed(peer.token));
    expect(peerList.status).toBe(200);
    const peerListBody = await peerList.json() as { prompts: Array<{ id: string; usedByCount?: number }> };
    expect(peerListBody.prompts.find((prompt) => prompt.id === "system_generic_code")?.usedByCount).toBe(0);
  });

  it("filters overview and concurrency data to visible resources", async () => {
    const admin = await setupAdmin();
    const owner = await createUserAndLogin(admin, "metrics-owner", "operator");
    const peer = await createUserAndLogin(admin, "metrics-peer", "viewer");
    const agent = await store.createAgent({
      id: "concurrency-agent",
      name: "Private metrics agent",
      type: "coding",
      modelConfigJson: "{}",
      systemPromptId: "system_generic_code",
      instructionsPromptId: "instructions_generic_code",
      ownerUserId: owner.user.id,
    });
    const project = await store.createProject({
      id: "concurrency-project",
      name: "Private metrics project",
      type: "coding",
      agentId: agent.id,
      ownerUserId: owner.user.id,
    });
    await store.createTask(
      makeTaskId(randomUUID()),
      makeTicketId("METRIC-1"),
      "Private metric task",
      "",
      "redmine",
      undefined,
      undefined,
      undefined,
      project.id
    );

    const overview = await fetch(`${baseUrl}/api/admin/overview`, authed(peer.token));
    const overviewBody = (await overview.json()) as { stats: { activeTasks: number } };
    expect(overviewBody.stats.activeTasks).toBe(0);

    const concurrency = await fetch(`${baseUrl}/api/admin/concurrency`, authed(peer.token));
    const concurrencyBody = (await concurrency.json()) as {
      snapshot: { perProject: Record<string, number>; perAgent: Record<string, number> };
    };
    expect(concurrencyBody.snapshot.perProject).toEqual({});
    expect(concurrencyBody.snapshot.perAgent).toEqual({});
  });

  it("filters provider summaries backed by private integrations", async () => {
    const admin = await setupAdmin();
    const owner = await createUserAndLogin(admin, "provider-owner", "operator");
    const peer = await createUserAndLogin(admin, "provider-peer", "viewer");
    await store.upsertIntegration({
      id: "private-provider-summary",
      provider: "redmine",
      name: "Private Provider Summary",
      configJson: "{}",
      enabled: true,
      ownerUserId: owner.user.id,
    });

    const peerResponse = await fetch(`${baseUrl}/api/admin/providers`, authed(peer.token));
    const peerBody = (await peerResponse.json()) as { providers: Array<{ id: string }> };
    expect(peerBody.providers.map((provider) => provider.id)).toEqual(["admin-api"]);

    const ownerResponse = await fetch(`${baseUrl}/api/admin/providers`, authed(owner.token));
    const ownerBody = (await ownerResponse.json()) as { providers: Array<{ id: string }> };
    expect(ownerBody.providers.map((provider) => provider.id)).toEqual([
      "admin-api",
      "private-provider-summary",
    ]);
  });

  it("shares linked metadata without exposing integration configuration", async () => {
    const admin = await setupAdmin();
    const owner = await createUserAndLogin(admin, "project-mask-owner", "operator");
    const peer = await createUserAndLogin(admin, "project-mask-peer", "viewer");
    const integration = await store.upsertIntegration({
      id: "masked-redmine",
      provider: "redmine",
      name: "Secret Redmine",
      configJson: "{}",
      enabled: true,
      ownerUserId: owner.user.id,
    });
    const agent = await store.createAgent({
      name: "Secret agent name",
      type: "coding",
      modelConfigJson: "{}",
      systemPromptId: "system_generic_code",
      instructionsPromptId: "instructions_generic_code",
      ownerUserId: owner.user.id,
    });
    const project = await store.createProject({
      name: "Shared shell project",
      type: "coding",
      agentId: agent.id,
      ownerUserId: owner.user.id,
    });
    await store.setProjectTicketSource(project.id, {
      integrationId: integration.id,
      ticketProjectKey: "PRIVATE",
    });
    const group = await store.createGroup({ name: "Project-only readers" });
    await store.addUserToGroup(group.id, peer.user.id);
    const grant = await fetch(
      `${baseUrl}/api/admin/projects/${project.id}/access/groups/${group.id}`,
      {
        method: "PUT",
        headers: {
          ...authed(owner.token).headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({ permissions: ["project.read"] }),
      }
    );
    expect(grant.status).toBe(200);

    const detail = await fetch(`${baseUrl}/api/admin/projects/${project.id}`, authed(peer.token));
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      project: {
        ownerUserId: string;
        agentId: string | null;
        agentName: string | null;
        ticketSource: {
          integration: { id: string; name: string; provider: string } | null;
          ticketProjectKey: string;
        } | null;
      };
    };
    expect(body.project).toMatchObject({
      ownerUserId: owner.user.id,
      agentId: agent.id,
      agentName: "Secret agent name",
      ticketSource: {
        integration: { id: integration.id, name: "Secret Redmine", provider: "redmine" },
        ticketProjectKey: "PRIVATE",
      },
    });
    expect(body.project.ticketSource?.integration).not.toHaveProperty("configJson");
  });

  it("does not expose another user's projects to a new viewer", async () => {
    const admin = await setupAdmin();
    await seedTwoProjects();
    const viewer = await createUserAndLogin(admin, "vera", "viewer");

    const list = await fetch(`${baseUrl}/api/admin/projects`, authed(viewer.token));
    expect(list.status).toBe(200);
    const body = (await list.json()) as { projects: Array<{ id: string }> };
    expect(body.projects).toHaveLength(0);
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
    for (const taskId of [taskA, taskB]) {
      await store.saveAgentCycle(makeTaskId(taskId), 1, {
        status: "failed", modifiedFiles: [], summary: "Invalid worker JSON", agentLogs: "masked output",
        metadata: { workerOutput: { stdout: `diagnostic-${taskId}`, exitCode: 0 } },
      });
    }
    const ownCycles = await fetch(`${baseUrl}/api/admin/tasks/${taskA}/cycles`, authed(user.token));
    expect(ownCycles.status).toBe(200);
    expect(await ownCycles.text()).toContain(`diagnostic-${taskA}`);
    const otherCycles = await fetch(`${baseUrl}/api/admin/tasks/${taskB}/cycles`, authed(user.token));
    expect(otherCycles.status).toBe(403);
    expect(await otherCycles.text()).not.toContain(`diagnostic-${taskB}`);
  });

  it("scope-filters the global live-log stream by task project", async () => {
    const admin = await setupAdmin();
    const { a, b } = await seedTwoProjects();
    const taskA = randomUUID();
    const taskB = randomUUID();
    const orphanTask = randomUUID();
    await store.createTask(makeTaskId(taskA), makeTicketId("T-A"), "Task A", "", "redmine", undefined, undefined, undefined, makeProjectId(a));
    await store.createTask(makeTaskId(taskB), makeTicketId("T-B"), "Task B", "", "redmine", undefined, undefined, undefined, makeProjectId(b));
    // Project-less (orphaned) task: nobody may receive its events on the global stream.
    await store.createTask(makeTaskId(orphanTask), makeTicketId("T-ORPHAN"), "Orphan", "", "redmine");

    const user = await createUserAndLogin(admin, "streamscoped", "viewer");
    const viewerPolicy = (await store.listPolicies()).find((p) => p.name === "Viewer");
    await store.deleteBinding(viewerPolicy!.id, "user", user.user.id);
    const scoped = await store.createPolicy({ name: "Stream-A-read" });
    await store.setPolicyRules(scoped.id, [{ permission: "task.read", resourceId: a }]);
    await store.createBinding({ policyId: scoped.id, principalType: "user", principalId: user.user.id });

    const abort = new AbortController();
    const response = await fetch(`${baseUrl}/api/admin/logs/stream`, {
      ...authed(user.token),
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let output = decoder.decode((await reader.read()).value, { stream: true });

    const event = (taskId: string, marker: string): AgentLogEvent => ({
      type: "assistant.message",
      timestamp: new Date().toISOString(),
      data: { content: marker },
      taskId,
      cycleNumber: 1,
    });
    agentLogBus.emit("event", event(taskB, "forbidden-project-marker"));
    agentLogBus.emit("event", event(orphanTask, "orphan-task-marker"));
    agentLogBus.emit("event", event(randomUUID(), "unknown-task-marker"));
    agentLogBus.emit("event", event(taskA, "allowed-project-marker"));

    while (!output.includes("allowed-project-marker")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
    }
    abort.abort();

    expect(output).toContain("allowed-project-marker");
    expect(output).not.toContain("forbidden-project-marker");
    expect(output).not.toContain("orphan-task-marker");
    expect(output).not.toContain("unknown-task-marker");
  });

  it("allows a project owner to open an owned task log stream", async () => {
    const admin = await setupAdmin();
    const owner = await createUserAndLogin(admin, "stream-owner", "operator");
    const agent = await store.createAgent({
      name: "Stream owner agent",
      type: "coding",
      modelConfigJson: "{}",
      systemPromptId: "system_generic_code",
      instructionsPromptId: "instructions_generic_code",
      ownerUserId: owner.user.id,
    });
    const project = await store.createProject({
      name: "Stream owner project",
      type: "coding",
      agentId: agent.id,
      ownerUserId: owner.user.id,
    });
    const taskId = randomUUID();
    await store.createTask(
      makeTaskId(taskId),
      makeTicketId("STREAM-OWN-1"),
      "Owned stream",
      "",
      "redmine",
      undefined,
      undefined,
      undefined,
      project.id
    );

    const abort = new AbortController();
    const response = await fetch(`${baseUrl}/api/admin/logs/stream?taskId=${taskId}`, {
      ...authed(owner.token),
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    abort.abort();
  });

  it("denies project-scoped principals access to another project's log stream", async () => {
    const admin = await setupAdmin();
    const { a, b } = await seedTwoProjects();
    const taskB = randomUUID();
    const taskIdB = makeTaskId(taskB);
    await store.createTask(taskIdB, makeTicketId("T-B-LOGS"), "Task B logs", "", "redmine", undefined, undefined, undefined, makeProjectId(b));
    await store.saveAgentCycle(taskIdB, 1, {
      status: "success",
      modifiedFiles: [],
      summary: "done",
      agentLogs: "PROJECT_B_HISTORY_SECRET",
      metadata: {},
    });
    pushToTaskBuffer({
      type: "assistant.message",
      timestamp: new Date().toISOString(),
      data: { message: "PROJECT_B_LIVE_SECRET" },
      taskId: taskB,
      cycleNumber: 2,
    });

    try {
      const user = await createUserAndLogin(admin, "logscoped", "viewer");
      const viewerPolicy = (await store.listPolicies()).find((policy) => policy.name === "Viewer");
      await store.deleteBinding(viewerPolicy!.id, "user", user.user.id);
      const scoped = await store.createPolicy({ name: "Task-A-logs" });
      await store.setPolicyRules(scoped.id, [{ permission: "task.read", resourceId: a }]);
      await store.createBinding({ policyId: scoped.id, principalType: "user", principalId: user.user.id });

      const response = await fetch(`${baseUrl}/api/admin/logs/stream?taskId=${encodeURIComponent(taskB)}`, authed(user.token));
      const body = await response.text();

      expect(response.status).toBe(403);
      expect(body).not.toContain("PROJECT_B_HISTORY_SECRET");
      expect(body).not.toContain("PROJECT_B_LIVE_SECRET");
    } finally {
      clearTaskEventBuffer(taskB);
    }
  });
});
