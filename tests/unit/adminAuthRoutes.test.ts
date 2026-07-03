import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { createAdminServer } from "../../src/admin/adminServer.js";

const SECRET = "test-admin-secret";

function tempDbPath(): string {
  return join(tmpdir(), `ve-auth-routes-${randomUUID()}.db`);
}

function makeServer(store: SqliteStateStore): ReturnType<typeof createAdminServer> {
  return createAdminServer({
    stateStore: store,
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

async function runSetup(baseUrl: string, username = "root", password = "password123"): Promise<SessionResponse> {
  const response = await fetch(`${baseUrl}/api/admin/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as SessionResponse;
}

describe("adminAuthRoutes", () => {
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

  describe("setup", () => {
    it("reports needsSetup=true before any user exists (public route)", async () => {
      const response = await fetch(`${baseUrl}/api/admin/auth/setup-status`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ needsSetup: true });
    });

    it("allows setup without any authorization header", async () => {
      const response = await fetch(`${baseUrl}/api/admin/auth/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "root", password: "password123" }),
      });
      expect(response.status).toBe(201);
    });

    it("creates the first admin, logs them in, and records an audit entry", async () => {
      const session = await runSetup(baseUrl);
      expect(session.token).toMatch(/^[0-9a-f]{64}$/);
      expect(session.user.username).toBe("root");
      expect(session.user.role).toBe("admin");

      const status = await fetch(`${baseUrl}/api/admin/auth/setup-status`);
      await expect(status.json()).resolves.toEqual({ needsSetup: false });

      const { entries } = await store.listAuditEntries({ action: "auth.setup" });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actorName).toBe("bootstrap");
      expect(entries[0]?.details).toEqual({ username: "root", role: "admin" });
    });

    it("rejects setup once a user exists", async () => {
      await runSetup(baseUrl);
      const response = await fetch(`${baseUrl}/api/admin/auth/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "second", password: "password123" }),
      });
      expect(response.status).toBe(403);
    });

    it("validates username and password", async () => {
      for (const body of [{ username: "", password: "password123" }, { username: "root", password: "short" }]) {
        const response = await fetch(`${baseUrl}/api/admin/auth/setup`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
      }
    });
  });

  describe("login / me / logout", () => {
    it("logs in with valid credentials and resolves identity via /auth/me", async () => {
      await runSetup(baseUrl);
      const login = await fetch(`${baseUrl}/api/admin/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "root", password: "password123" }),
      });
      expect(login.status).toBe(200);
      const session = (await login.json()) as SessionResponse;

      const me = await fetch(`${baseUrl}/api/admin/auth/me`, {
        headers: { authorization: `Bearer ${session.token}` },
      });
      expect(me.status).toBe(200);
      await expect(me.json()).resolves.toEqual({
        id: session.user.id,
        username: "root",
        role: "admin",
      });
    });

    it("rejects bad credentials with 401", async () => {
      await runSetup(baseUrl);
      const response = await fetch(`${baseUrl}/api/admin/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "root", password: "wrong-password" }),
      });
      expect(response.status).toBe(401);
    });

    it("logout revokes the session token", async () => {
      const session = await runSetup(baseUrl);
      const logout = await fetch(`${baseUrl}/api/admin/auth/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}` },
      });
      expect(logout.status).toBe(204);

      const me = await fetch(`${baseUrl}/api/admin/auth/me`, {
        headers: { authorization: `Bearer ${session.token}` },
      });
      expect(me.status).toBe(401);
    });
  });

  describe("user management", () => {
    async function createUserViaApi(
      adminToken: string,
      body: { username: string; password: string; role: string }
    ): Promise<{ status: number; user: { id: string; username: string; role: string; enabled: boolean } }> {
      const response = await fetch(`${baseUrl}/api/admin/users`, {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = response.status === 201
        ? ((await response.json()) as { user: { id: string; username: string; role: string; enabled: boolean } })
        : { user: { id: "", username: "", role: "", enabled: false } };
      return { status: response.status, user: payload.user };
    }

    it("lists users without exposing password hashes", async () => {
      const session = await runSetup(baseUrl);
      await createUserViaApi(session.token, { username: "bob", password: "password123", role: "viewer" });

      const response = await fetch(`${baseUrl}/api/admin/users`, {
        headers: { authorization: `Bearer ${session.token}` },
      });
      expect(response.status).toBe(200);
      const { users } = (await response.json()) as { users: Array<Record<string, unknown>> };
      expect(users).toHaveLength(2);
      for (const user of users) {
        expect(user).not.toHaveProperty("passwordHash");
        expect(user).toHaveProperty("role");
      }
    });

    it("creates users and returns 409 on duplicate username", async () => {
      const session = await runSetup(baseUrl);
      const created = await createUserViaApi(session.token, { username: "bob", password: "password123", role: "operator" });
      expect(created.status).toBe(201);
      expect(created.user.role).toBe("operator");

      const duplicate = await createUserViaApi(session.token, { username: "bob", password: "password456", role: "viewer" });
      expect(duplicate.status).toBe(409);

      const { entries } = await store.listAuditEntries({ action: "user.create" });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actorName).toBe("root");
    });

    it("refuses to demote, disable, or delete the last enabled admin", async () => {
      const session = await runSetup(baseUrl);
      const adminId = session.user.id;
      const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };

      const demote = await fetch(`${baseUrl}/api/admin/users/${adminId}`, {
        method: "PUT", headers, body: JSON.stringify({ role: "viewer" }),
      });
      expect(demote.status).toBe(409);

      const disable = await fetch(`${baseUrl}/api/admin/users/${adminId}`, {
        method: "PUT", headers, body: JSON.stringify({ enabled: false }),
      });
      expect(disable.status).toBe(409);

      const remove = await fetch(`${baseUrl}/api/admin/users/${adminId}`, {
        method: "DELETE", headers: { authorization: `Bearer ${session.token}` },
      });
      expect(remove.status).toBe(409);
    });

    it("allows demoting an admin when another enabled admin remains", async () => {
      const session = await runSetup(baseUrl);
      const second = await createUserViaApi(session.token, { username: "carol", password: "password123", role: "admin" });
      expect(second.status).toBe(201);

      const demote = await fetch(`${baseUrl}/api/admin/users/${second.user.id}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
        body: JSON.stringify({ role: "operator" }),
      });
      expect(demote.status).toBe(200);
      const { user } = (await demote.json()) as { user: { role: string } };
      expect(user.role).toBe("operator");
    });

    it("forbids non-admin users from managing users", async () => {
      const session = await runSetup(baseUrl);
      await createUserViaApi(session.token, { username: "bob", password: "password123", role: "operator" });
      const bobLogin = await fetch(`${baseUrl}/api/admin/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "bob", password: "password123" }),
      });
      const bob = (await bobLogin.json()) as SessionResponse;

      const list = await fetch(`${baseUrl}/api/admin/users`, {
        headers: { authorization: `Bearer ${bob.token}` },
      });
      expect(list.status).toBe(403);
      await expect(list.json()).resolves.toEqual({ error: "forbidden", requiredRole: "admin" });

      const create = await fetch(`${baseUrl}/api/admin/users`, {
        method: "POST",
        headers: { authorization: `Bearer ${bob.token}`, "content-type": "application/json" },
        body: JSON.stringify({ username: "eve", password: "password123", role: "admin" }),
      });
      expect(create.status).toBe(403);
    });

    it("lets a non-admin change their own password with currentPassword, revoking sessions", async () => {
      const session = await runSetup(baseUrl);
      await createUserViaApi(session.token, { username: "bob", password: "password123", role: "viewer" });
      const bobLogin = await fetch(`${baseUrl}/api/admin/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "bob", password: "password123" }),
      });
      const bob = (await bobLogin.json()) as SessionResponse;

      // Wrong current password → 403.
      const wrong = await fetch(`${baseUrl}/api/admin/users/${bob.user.id}/password`, {
        method: "PUT",
        headers: { authorization: `Bearer ${bob.token}`, "content-type": "application/json" },
        body: JSON.stringify({ password: "newpassword456", currentPassword: "not-right" }),
      });
      expect(wrong.status).toBe(403);

      const change = await fetch(`${baseUrl}/api/admin/users/${bob.user.id}/password`, {
        method: "PUT",
        headers: { authorization: `Bearer ${bob.token}`, "content-type": "application/json" },
        body: JSON.stringify({ password: "newpassword456", currentPassword: "password123" }),
      });
      expect(change.status).toBe(200);

      // All of bob's sessions were revoked.
      const me = await fetch(`${baseUrl}/api/admin/auth/me`, {
        headers: { authorization: `Bearer ${bob.token}` },
      });
      expect(me.status).toBe(401);

      // New password works.
      const relogin = await fetch(`${baseUrl}/api/admin/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "bob", password: "newpassword456" }),
      });
      expect(relogin.status).toBe(200);
    });

    it("forbids a non-admin from changing another user's password", async () => {
      const session = await runSetup(baseUrl);
      await createUserViaApi(session.token, { username: "bob", password: "password123", role: "operator" });
      const bobLogin = await fetch(`${baseUrl}/api/admin/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "bob", password: "password123" }),
      });
      const bob = (await bobLogin.json()) as SessionResponse;

      const response = await fetch(`${baseUrl}/api/admin/users/${session.user.id}/password`, {
        method: "PUT",
        headers: { authorization: `Bearer ${bob.token}`, "content-type": "application/json" },
        body: JSON.stringify({ password: "newpassword456", currentPassword: "password123" }),
      });
      expect(response.status).toBe(403);
    });

    it("lets an admin reset another user's password without currentPassword", async () => {
      const session = await runSetup(baseUrl);
      const bob = await createUserViaApi(session.token, { username: "bob", password: "password123", role: "viewer" });

      const reset = await fetch(`${baseUrl}/api/admin/users/${bob.user.id}/password`, {
        method: "PUT",
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
        body: JSON.stringify({ password: "resetpassword789" }),
      });
      expect(reset.status).toBe(200);

      const login = await fetch(`${baseUrl}/api/admin/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "bob", password: "resetpassword789" }),
      });
      expect(login.status).toBe(200);

      const { entries } = await store.listAuditEntries({ action: "user.password_change" });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.details).toEqual({ username: "bob" });
    });

    it("deletes a non-admin user", async () => {
      const session = await runSetup(baseUrl);
      const bob = await createUserViaApi(session.token, { username: "bob", password: "password123", role: "viewer" });

      const remove = await fetch(`${baseUrl}/api/admin/users/${bob.user.id}`, {
        method: "DELETE", headers: { authorization: `Bearer ${session.token}` },
      });
      expect(remove.status).toBe(200);
      await expect(store.getUserById(bob.user.id)).resolves.toBeNull();

      const { entries } = await store.listAuditEntries({ action: "user.delete" });
      expect(entries).toHaveLength(1);
    });
  });
});
