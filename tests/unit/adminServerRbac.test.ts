import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("lets project owners and delegated owner groups read project tasks", async () => {
    const admin = await setupAdmin();
    const owner = await createUserAndLogin(admin, "task-owner", "operator");
    const delegate = await createUserAndLogin(admin, "task-delegate", "viewer");
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
    expect(redelegate.status).toBe(200);

    const revoke = await fetch(
      `${baseUrl}/api/admin/projects/${project.id}/access/groups/${group.id}`,
      { method: "DELETE", ...authed(owner.token) }
    );
    expect(revoke.status).toBe(204);
    expect((await fetch(`${baseUrl}/api/admin/tasks/${taskId}`, authed(delegate.token))).status).toBe(403);
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
      ownerUserId: owner.user.id,
    });

    const response = await fetch(
      `${baseUrl}/api/admin/prompts/system_generic_code/usage`,
      authed(peer.token)
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      promptId: "system_generic_code",
      agents: [],
    });
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

  it("masks private agent and integration metadata in a shared project", async () => {
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
    await expect(detail.json()).resolves.toMatchObject({
      project: {
        ownerUserId: owner.user.id,
        agentId: null,
        agentName: null,
        ticketSource: {
          integration: null,
          ticketProjectKey: "PRIVATE",
        },
      },
    });
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
