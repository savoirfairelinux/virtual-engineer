import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { createAdminServer } from "../../src/admin/adminServer.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe("Admin API — project statistics route", () => {
  let store: SqliteStateStore;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDatabasePath("ve-admin-project-statistics"));
    server = createAdminServer({
      stateStore: store,
      agentStore: store,
      projectStore: store,
      allowUnauthenticatedAdmin: true,
      config: {
        nodeEnv: "test",
        logLevel: "error",
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        pollingIntervalMs: 30_000,
      },
      polling: { isRunning: () => false, getIntervals: () => ({ intervalMs: 30_000 }) },
      providers: [],
    });
    baseUrl = await listen(server);
  });

  afterEach(async () => {
    await close(server);
    store.close();
  });

  async function createProject(): Promise<string> {
    const agent = await store.createAgent({
      name: "Statistics route agent",
      type: "coding",
      modelConfigJson: "{}",
      systemPromptId: "system_generic_code",
      instructionsPromptId: "instructions_generic_code",
      enabled: true,
    });
    const project = await store.createProject({ name: "PLATFORM", type: "coding", agentId: agent.id });
    return project.id;
  }

  it("returns only the selected project's statistics and forwards a supported period", async () => {
    const projectId = await createProject();
    const getProjectStatistics = vi.spyOn(store, "getProjectStatistics");
    const before = Date.now();

    const response = await fetch(`${baseUrl}/api/admin/projects/${projectId}/statistics?days=7`);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body["projectId"]).toBe(projectId);
    expect(body).not.toHaveProperty("perProject");
    expect(body).not.toHaveProperty("instanceTotal");
    expect(getProjectStatistics).toHaveBeenCalledTimes(1);
    const args = getProjectStatistics.mock.calls[0];
    expect(args?.[0]).toBe(projectId);
    const options = args?.[1];
    expect(options?.since).toBeInstanceOf(Date);
    expect(Math.abs((options?.since?.getTime() ?? 0) - (before - 7 * 24 * 60 * 60 * 1000))).toBeLessThan(5000);
  });

  it("falls back to all-time for an invalid period and returns 404 for an unknown project", async () => {
    const projectId = await createProject();
    const getProjectStatistics = vi.spyOn(store, "getProjectStatistics");

    const invalidPeriod = await fetch(`${baseUrl}/api/admin/projects/${projectId}/statistics?days=90`);
    expect(invalidPeriod.status).toBe(200);
    expect(getProjectStatistics.mock.calls[0]?.[1]).toBeUndefined();

    const missing = await fetch(`${baseUrl}/api/admin/projects/missing/statistics`);
    expect(missing.status).toBe(404);
    expect(getProjectStatistics).toHaveBeenCalledTimes(1);
  });
});

interface SessionResponse {
  token: string;
  user: { id: string; username: string; role: string };
}

describe("Admin API — project statistics authorization", () => {
  let store: SqliteStateStore;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDatabasePath("ve-admin-project-statistics-rbac"));
    server = createAdminServer({
      stateStore: store,
      agentStore: store,
      projectStore: store,
      config: {
        nodeEnv: "test",
        logLevel: "error",
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        pollingIntervalMs: 30_000,
        adminAuthSecret: "statistics-rbac-secret",
      },
      polling: { isRunning: () => false, getIntervals: () => ({ intervalMs: 30_000 }) },
      providers: [],
    });
    baseUrl = await listen(server);
  });

  afterEach(async () => {
    await close(server);
    store.close();
  });

  async function setupAdmin(): Promise<SessionResponse> {
    const response = await fetch(`${baseUrl}/api/admin/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "Str0ng-Pass-1x" }),
    });
    expect(response.status).toBe(201);
    return await response.json() as SessionResponse;
  }

  async function createUser(admin: SessionResponse, username: string): Promise<SessionResponse> {
    const created = await fetch(`${baseUrl}/api/admin/users`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ username, password: "Str0ng-Pass-1x", role: "operator" }),
    });
    expect(created.status).toBe(201);
    const login = await fetch(`${baseUrl}/api/admin/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: "Str0ng-Pass-1x" }),
    });
    expect(login.status).toBe(200);
    return await login.json() as SessionResponse;
  }

  async function createOwnedProject(ownerUserId: string): Promise<string> {
    const agent = await store.createAgent({
      name: `Owned statistics agent ${ownerUserId}`,
      type: "coding",
      modelConfigJson: "{}",
      systemPromptId: "system_generic_code",
      instructionsPromptId: "instructions_generic_code",
      enabled: true,
      ownerUserId,
    });
    const project = await store.createProject({
      name: "PRIVATE",
      type: "coding",
      agentId: agent.id,
      ownerUserId,
    });
    return project.id;
  }

  it("allows the administrator and the direct project owner", async () => {
    const admin = await setupAdmin();
    const owner = await createUser(admin, "statistics-owner");
    const projectId = await createOwnedProject(owner.user.id);

    const adminResponse = await fetch(`${baseUrl}/api/admin/projects/${projectId}/statistics`, {
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(adminResponse.status).toBe(200);

    const ownerResponse = await fetch(`${baseUrl}/api/admin/projects/${projectId}/statistics`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(ownerResponse.status).toBe(200);
  });

  it("denies a non-owner before aggregation", async () => {
    const admin = await setupAdmin();
    const owner = await createUser(admin, "statistics-private-owner");
    const peer = await createUser(admin, "statistics-private-peer");
    const projectId = await createOwnedProject(owner.user.id);
    const getProjectStatistics = vi.spyOn(store, "getProjectStatistics");

    const response = await fetch(`${baseUrl}/api/admin/projects/${projectId}/statistics`, {
      headers: { authorization: `Bearer ${peer.token}` },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden", permission: "project.statistics.read" });
    expect(getProjectStatistics).not.toHaveBeenCalled();
  });

  it("denies a delegated group even when it has an explicit statistics grant", async () => {
    const admin = await setupAdmin();
    const owner = await createUser(admin, "statistics-delegated-owner");
    const delegate = await createUser(admin, "statistics-delegate");
    const projectId = await createOwnedProject(owner.user.id);
    const group = await store.createGroup({ name: "Statistics delegates" });
    await store.addUserToGroup(group.id, delegate.user.id);
    const policy = await store.createPolicy({ name: "Statistics delegate grant" });
    await store.setPolicyRules(policy.id, [{ permission: "project.statistics.read", resourceId: projectId }]);
    await store.createBinding({ policyId: policy.id, principalType: "group", principalId: group.id });

    const response = await fetch(`${baseUrl}/api/admin/projects/${projectId}/statistics`, {
      headers: { authorization: `Bearer ${delegate.token}` },
    });
    expect(response.status).toBe(403);
  });
});