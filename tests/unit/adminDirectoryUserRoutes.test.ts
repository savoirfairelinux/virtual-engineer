import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";
import { login, requestJson, setupAdmin, startAdminHttpServer, type AdminHttpServer } from "./helpers/adminHttp.js";
import { ldapAvailable, startLdapDirectoryServer, type LdapDirectoryServer } from "./helpers/ldapDirectoryServer.js";

async function waitForAudit(store: SqliteStateStore, action: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { entries } = await store.listAuditEntries({ action });
    if (entries[0]) return entries[0].details;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`audit action ${action} was not recorded`);
}

describe.skipIf(!ldapAvailable)("directory users over HTTP (live slapd)", () => {
  let directory: LdapDirectoryServer;
  let store: SqliteStateStore;
  let admin: AdminHttpServer;
  let rootToken: string;
  let sourceId: string;

  beforeAll(async () => {
    directory = await startLdapDirectoryServer();
    await directory.addUser("alice", "alice-Pass-1");
    await directory.addUser("bob", "bob-Pass-1");
  });

  afterAll(async () => {
    await directory.stop();
  });

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDatabasePath("ve-directory-users"));
    admin = await startAdminHttpServer(store);
    rootToken = await setupAdmin(admin.baseUrl);
    const created = await call("POST", "/api/admin/auth-sources", { name: "Corp LDAP", kind: "ldap", config: directory.config() });
    expect(created.status).toBe(201);
    sourceId = (created.body["authSource"] as Record<string, unknown>)["id"] as string;
  });

  afterEach(async () => {
    await admin.close();
    store.close();
  });

  function call(method: string, path: string, body?: unknown, token: string = rootToken): ReturnType<typeof requestJson> {
    return requestJson(admin.baseUrl, method, path, { token, ...(body !== undefined ? { body } : {}) });
  }

  async function createDirectoryUser(externalUsername: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const created = await call("POST", "/api/admin/users", { authSourceId: sourceId, externalUsername, role: "operator", ...extra });
    expect(created.status).toBe(201);
    return created.body["user"] as Record<string, unknown>;
  }

  it("creates a directory user without a password and signs it in through LDAP", async () => {
    const user = await createDirectoryUser("alice");
    expect(user).toMatchObject({ username: "alice", role: "operator", authSource: { id: sourceId, name: "Corp LDAP", externalUsername: "alice" } });

    const token = await login(admin.baseUrl, "alice", "alice-Pass-1");
    const me = await call("GET", "/api/admin/auth/me", undefined, token);
    expect(me.body).toMatchObject({ username: "alice", role: "operator", authSource: { id: sourceId, name: "Corp LDAP" } });
    await expect(waitForAudit(store, "auth.login")).resolves.toMatchObject({ username: "alice", authSourceId: sourceId });

    const wrong = await requestJson(admin.baseUrl, "POST", "/api/admin/auth/login", { body: { username: "alice", password: "wrong-Pass-1" } });
    expect(wrong).toMatchObject({ status: 401, body: { error: "Invalid username or password" } });

    const rootMe = await call("GET", "/api/admin/auth/me");
    expect(rootMe.body["authSource"]).toBeNull();
    const listed = await call("GET", "/api/admin/users");
    const rows = listed.body["users"] as Array<Record<string, unknown>>;
    expect(rows.find((row) => row["username"] === "root")?.["authSource"]).toBeNull();
    expect(rows.find((row) => row["username"] === "alice")?.["authSource"]).toMatchObject({ lastLoginAt: expect.any(String) as unknown });
  });

  it("uses a requested local username and reports lookup failures", async () => {
    const user = await createDirectoryUser("bob", { username: "Bob.Builder" });
    expect(user).toMatchObject({ username: "bob.builder", authSource: { externalUsername: "bob" } });

    const missing = await call("POST", "/api/admin/users", { authSourceId: sourceId, externalUsername: "nobody", role: "viewer" });
    expect(missing).toMatchObject({ status: 400, body: { error: "No directory account matches \"nobody\"" } });
    const noSource = await call("POST", "/api/admin/users", { authSourceId: "missing", externalUsername: "alice", role: "viewer" });
    expect(noSource).toMatchObject({ status: 400, body: { error: "Authentication source not found" } });
    const duplicate = await call("POST", "/api/admin/users", { authSourceId: sourceId, externalUsername: "bob", role: "viewer", username: "other" });
    expect(duplicate.status).toBe(409);
  });

  it("returns 503 without rate limiting while the directory is unreachable", async () => {
    await createDirectoryUser("alice");
    const closed = directory.ldapsUrl.replace(/:\d+$/, ":1");
    const updated = await call("PUT", `/api/admin/auth-sources/${sourceId}`, { config: { ...directory.config({ url: closed }), bindPassword: "" } });
    expect(updated.status).toBe(200);

    for (let attempt = 0; attempt < 6; attempt++) {
      const result = await requestJson(admin.baseUrl, "POST", "/api/admin/auth/login", { body: { username: "alice", password: "alice-Pass-1" } });
      expect(result.status).toBe(503);
      expect(result.body["error"]).toContain("temporarily unavailable");
    }
    await expect(waitForAudit(store, "auth.login_unavailable")).resolves.toMatchObject({ username: "alice" });
    await login(admin.baseUrl, "root", "Str0ng-Pass-1x");
  });

  it("blocks password changes for directory users", async () => {
    const user = await createDirectoryUser("alice");
    const token = await login(admin.baseUrl, "alice", "alice-Pass-1");

    const own = await call("PUT", `/api/admin/users/${user["id"] as string}/password`, { password: "New-Pass-12", currentPassword: "alice-Pass-1" }, token);
    expect(own.status).toBe(409);
    const reset = await call("PUT", `/api/admin/users/${user["id"] as string}/password`, { password: "New-Pass-12" });
    expect(reset.status).toBe(409);
  });

  it("links a local user to the directory and converts it back", async () => {
    const created = await call("POST", "/api/admin/users", { username: "carol", password: "carol-Pass-1", role: "viewer" });
    const userId = (created.body["user"] as Record<string, unknown>)["id"] as string;
    const localToken = await login(admin.baseUrl, "carol", "carol-Pass-1");

    const linked = await call("PUT", `/api/admin/users/${userId}/identity`, { authSourceId: sourceId, externalUsername: "bob" });
    expect(linked).toMatchObject({ status: 200, body: { user: { username: "carol", authSource: { externalUsername: "bob" } } } });
    expect((await call("GET", "/api/admin/auth/me", undefined, localToken)).status).toBe(401);
    expect((await requestJson(admin.baseUrl, "POST", "/api/admin/auth/login", { body: { username: "carol", password: "carol-Pass-1" } })).status).toBe(401);
    await login(admin.baseUrl, "carol", "bob-Pass-1");
    await expect(waitForAudit(store, "user.identity_link")).resolves.toMatchObject({ username: "carol", externalUsername: "bob" });

    expect((await call("PUT", `/api/admin/users/${userId}/identity`, { authSourceId: sourceId, externalUsername: "bob" })).status).toBe(409);
    expect((await call("DELETE", `/api/admin/users/${userId}/identity`, { password: "weak" })).status).toBe(400);

    const unlinked = await call("DELETE", `/api/admin/users/${userId}/identity`, { password: "carol-Pass-2" });
    expect(unlinked).toMatchObject({ status: 200, body: { user: { authSource: null } } });
    await login(admin.baseUrl, "carol", "carol-Pass-2");
    expect((await requestJson(admin.baseUrl, "POST", "/api/admin/auth/login", { body: { username: "carol", password: "bob-Pass-1" } })).status).toBe(401);
    expect((await call("DELETE", `/api/admin/users/${userId}/identity`, { password: "carol-Pass-3" })).status).toBe(404);
  });

  it("keeps one enabled local admin for directory outages", async () => {
    const root = (await call("GET", "/api/admin/auth/me")).body["id"] as string;
    expect((await call("PUT", `/api/admin/users/${root}/identity`, { authSourceId: sourceId, externalUsername: "alice" })).status).toBe(409);

    const directoryAdmin = await createDirectoryUser("alice", { role: "admin" });
    const demote = await call("PUT", `/api/admin/users/${root}`, { role: "viewer" });
    expect(demote.status).toBe(409);
    expect(demote.body["error"]).toContain("last enabled local admin");
    expect((await call("PUT", `/api/admin/users/${root}`, { enabled: false })).status).toBe(409);
    expect((await call("DELETE", `/api/admin/users/${root}`)).status).toBe(409);

    const demoted = await call("PUT", `/api/admin/users/${directoryAdmin["id"] as string}`, { role: "viewer" });
    expect(demoted).toMatchObject({
      status: 200,
      body: { user: { role: "viewer", authSource: { id: sourceId, name: "Corp LDAP", externalUsername: "alice" } } },
    });
  });

  it("keeps one enabled local admin when demotions race", async () => {
    const root = (await call("GET", "/api/admin/auth/me")).body["id"] as string;
    const second = await call("POST", "/api/admin/users", { username: "zed", password: "zed-Pass-123", role: "admin" });
    const zed = (second.body["user"] as Record<string, unknown>)["id"] as string;
    await createDirectoryUser("alice", { role: "admin" });
    const directoryToken = await login(admin.baseUrl, "alice", "alice-Pass-1");

    const results = await Promise.all([root, zed].map((id) => call("PUT", `/api/admin/users/${id}`, { role: "viewer" }, directoryToken)));

    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(results.find((result) => result.status === 409)?.body["error"]).toContain("last enabled local admin");
    await expect(store.countEnabledLocalAdmins()).resolves.toBe(1);
  });

  it("refuses to delete a source that users sign in through", async () => {
    const user = await createDirectoryUser("alice");

    const blocked = await call("DELETE", `/api/admin/auth-sources/${sourceId}`);
    expect(blocked).toMatchObject({ status: 409 });
    expect(blocked.body["error"]).toContain("1 user signs in through this source");

    expect((await call("DELETE", `/api/admin/users/${user["id"] as string}`)).status).toBe(200);
    expect((await call("DELETE", `/api/admin/auth-sources/${sourceId}`)).status).toBe(204);
  });
});
