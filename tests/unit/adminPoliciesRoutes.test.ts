import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { createAdminServer } from "../../src/admin/adminServer.js";

const SECRET = "policy-test-secret";

function tempDbPath(): string {
  return join(tmpdir(), `ve-policies-${randomUUID()}.db`);
}

function makeServer(store: SqliteStateStore): ReturnType<typeof createAdminServer> {
  return createAdminServer({
    stateStore: store,
    integrationStore: store,
    promptStore: store,
    projectStore: store,
    agentStore: store,
    config: {
      nodeEnv: "test", logLevel: "info", maxAgentCycles: 3, maxRetryAttempts: 5,
      pollingIntervalMs: 30_000, adminAuthSecret: SECRET,
    },
    polling: { isRunning: () => true, getIntervals: () => ({ intervalMs: 30_000 }) },
    providers: [],
  });
}

async function listen(server: ReturnType<typeof createAdminServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

interface SessionResponse { token: string; user: { id: string; username: string; role: string } }

describe("adminServer policy/group admin API", () => {
  let store: SqliteStateStore;
  let server: ReturnType<typeof createAdminServer>;
  let baseUrl: string;
  let admin: SessionResponse;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
    server = makeServer(store);
    baseUrl = await listen(server);
    const setup = await fetch(`${baseUrl}/api/admin/auth/setup`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "Str0ng-Pass-1x" }),
    });
    admin = (await setup.json()) as SessionResponse;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });

  function auth(token = admin.token): { headers: Record<string, string> } {
    return { headers: { authorization: `Bearer ${token}` } };
  }
  function authJson(body: unknown, token = admin.token): RequestInit {
    return { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) };
  }

  async function createOperator(username: string): Promise<SessionResponse> {
    const create = await fetch(`${baseUrl}/api/admin/users`, authJson({ username, password: "Str0ng-Pass-1x", role: "operator" }));
    expect(create.status).toBe(201);
    const login = await fetch(`${baseUrl}/api/admin/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: "Str0ng-Pass-1x" }),
    });
    return (await login.json()) as SessionResponse;
  }

  it("exposes the permission catalog", async () => {
    const res = await fetch(`${baseUrl}/api/admin/permissions`, auth());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { permissions: string[] };
    expect(body.permissions).toContain("project.read");
    expect(body.permissions).toContain("policy.manage");
  });

  it("performs full group CRUD + membership", async () => {
    const created = await fetch(`${baseUrl}/api/admin/groups`, authJson({ name: "Team A", description: "d" }));
    expect(created.status).toBe(201);
    const { group } = (await created.json()) as { group: { id: string } };

    // add a member
    const member = await createOperator("bob");
    const add = await fetch(`${baseUrl}/api/admin/groups/${group.id}/members`, authJson({ userId: member.user.id }));
    expect(add.status).toBe(200);

    const detail = await fetch(`${baseUrl}/api/admin/groups/${group.id}`, auth());
    const detailBody = (await detail.json()) as { group: { members: Array<{ id: string }> } };
    expect(detailBody.group.members.map((m) => m.id)).toContain(member.user.id);

    const rm = await fetch(`${baseUrl}/api/admin/groups/${group.id}/members/${member.user.id}`, { method: "DELETE", ...auth() });
    expect(rm.status).toBe(204);

    const del = await fetch(`${baseUrl}/api/admin/groups/${group.id}`, { method: "DELETE", ...auth() });
    expect(del.status).toBe(204);
  });

  it("rejects duplicate group names", async () => {
    await fetch(`${baseUrl}/api/admin/groups`, authJson({ name: "Dup" }));
    const again = await fetch(`${baseUrl}/api/admin/groups`, authJson({ name: "Dup" }));
    expect(again.status).toBe(409);
  });

  it("creates a policy with rules and reads it back", async () => {
    const created = await fetch(`${baseUrl}/api/admin/policies`, authJson({
      name: "Scoped", description: "d",
      rules: [{ permission: "project.read", resourceId: "proj-1" }],
    }));
    expect(created.status).toBe(201);
    const { policy } = (await created.json()) as { policy: { id: string } };

    const detail = await fetch(`${baseUrl}/api/admin/policies/${policy.id}`, auth());
    const body = (await detail.json()) as { policy: { rules: Array<{ permission: string; resourceId: string | null }> } };
    expect(body.policy.rules).toHaveLength(1);
    expect(body.policy.rules[0]).toMatchObject({ permission: "project.read", resourceId: "proj-1" });
  });

  it("rejects unknown permissions in rules", async () => {
    const res = await fetch(`${baseUrl}/api/admin/policies`, authJson({ name: "Bad", rules: [{ permission: "project.explode" }] }));
    expect(res.status).toBe(400);
  });

  it("replaces policy rules and creates/removes bindings", async () => {
    const created = await fetch(`${baseUrl}/api/admin/policies`, authJson({ name: "Editable" }));
    const { policy } = (await created.json()) as { policy: { id: string } };

    const setRules = await fetch(`${baseUrl}/api/admin/policies/${policy.id}/rules`, {
      method: "PUT", headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ rules: [{ permission: "task.read", resourceId: null }] }),
    });
    expect(setRules.status).toBe(200);

    const user = await createOperator("carol");
    const bind = await fetch(`${baseUrl}/api/admin/policies/${policy.id}/bindings`, authJson({ principalType: "user", principalId: user.user.id }));
    expect(bind.status).toBe(201);

    // duplicate binding → 409
    const dup = await fetch(`${baseUrl}/api/admin/policies/${policy.id}/bindings`, authJson({ principalType: "user", principalId: user.user.id }));
    expect(dup.status).toBe(409);

    const unbind = await fetch(`${baseUrl}/api/admin/policies/${policy.id}/bindings/user/${user.user.id}`, { method: "DELETE", ...auth() });
    expect(unbind.status).toBe(204);
  });

  it("binding a non-existent principal returns 404", async () => {
    const created = await fetch(`${baseUrl}/api/admin/policies`, authJson({ name: "P" }));
    const { policy } = (await created.json()) as { policy: { id: string } };
    const bind = await fetch(`${baseUrl}/api/admin/policies/${policy.id}/bindings`, authJson({ principalType: "user", principalId: "nope" }));
    expect(bind.status).toBe(404);
  });

  it("protects built-in policies from edits and deletion", async () => {
    const list = await fetch(`${baseUrl}/api/admin/policies`, auth());
    const body = (await list.json()) as { policies: Array<{ id: string; name: string; builtin: boolean }> };
    const operator = body.policies.find((p) => p.name === "Operator");
    expect(operator?.builtin).toBe(true);

    const upd = await fetch(`${baseUrl}/api/admin/policies/${operator!.id}`, {
      method: "PUT", headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ description: "hacked" }),
    });
    expect(upd.status).toBe(409);

    const del = await fetch(`${baseUrl}/api/admin/policies/${operator!.id}`, { method: "DELETE", ...auth() });
    expect(del.status).toBe(409);
  });

  it("denies non-admins access to policy management", async () => {
    const operator = await createOperator("dave");
    expect((await fetch(`${baseUrl}/api/admin/policies`, auth(operator.token))).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/admin/groups`, auth(operator.token))).status).toBe(403);
    const create = await fetch(`${baseUrl}/api/admin/groups`, authJson({ name: "X" }, operator.token));
    expect(create.status).toBe(403);
  });

  it("returns effective capabilities on /auth/me", async () => {
    // Admin is a superuser.
    const meAdmin = await fetch(`${baseUrl}/api/admin/auth/me`, auth());
    const adminBody = (await meAdmin.json()) as { capabilities?: { superuser: boolean } };
    expect(adminBody.capabilities?.superuser).toBe(true);

    // Operator has the Operator bundle → project.write present, granted globally.
    const operator = await createOperator("erin");
    const meOp = await fetch(`${baseUrl}/api/admin/auth/me`, auth(operator.token));
    const opBody = (await meOp.json()) as { capabilities?: { superuser: boolean; grants: Record<string, unknown> } };
    expect(opBody.capabilities?.superuser).toBe(false);
    expect(opBody.capabilities?.grants["project.write"]).toBe("*");
    expect(opBody.capabilities?.grants["policy.manage"]).toBeUndefined();
  });
});
