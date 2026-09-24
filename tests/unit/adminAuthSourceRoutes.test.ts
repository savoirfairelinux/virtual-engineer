import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";
import { login, requestJson, setupAdmin, startAdminHttpServer, type AdminHttpServer } from "./helpers/adminHttp.js";
import { ldapAvailable, startLdapDirectoryServer, type LdapDirectoryServer } from "./helpers/ldapDirectoryServer.js";

const MASK = "********";

const staticConfig = {
  url: "ldaps://ldap.example.test:636",
  bindDn: "cn=svc,dc=example,dc=test",
  bindPassword: "svc-Secret-1",
  userSearchBaseDn: "ou=people,dc=example,dc=test",
};

async function waitForAudit(store: SqliteStateStore, action: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { entries } = await store.listAuditEntries({ action });
    if (entries[0]) return entries[0].details;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`audit action ${action} was not recorded`);
}

describe("adminAuthSourceRoutes", () => {
  let store: SqliteStateStore;
  let admin: AdminHttpServer;
  let token: string;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDatabasePath("ve-auth-source-routes"));
    admin = await startAdminHttpServer(store);
    token = await setupAdmin(admin.baseUrl);
  });

  afterEach(async () => {
    await admin.close();
    store.close();
  });

  async function createSource(overrides: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    return requestJson(admin.baseUrl, "POST", "/api/admin/auth-sources", {
      token,
      body: { name: "Corp LDAP", kind: "ldap", config: staticConfig, ...overrides },
    });
  }

  it("creates a source, encrypts the bind password at rest, and masks it in responses", async () => {
    const created = await createSource({ priority: 10 });

    expect(created.status).toBe(201);
    const source = created.body["authSource"] as Record<string, unknown>;
    expect(source).toMatchObject({ name: "Corp LDAP", kind: "ldap", enabled: true, priority: 10 });
    expect(source["config"]).toMatchObject({ url: staticConfig.url, bindPassword: MASK, uniqueIdAttribute: "entryUUID" });

    const row = await store.getAuthSourceById(source["id"] as string);
    expect(row?.configJson).toMatch(/"bindPassword":"veenc:v1:/);
    expect(row?.configJson).not.toContain("svc-Secret-1");

    const listed = await requestJson(admin.baseUrl, "GET", "/api/admin/auth-sources", { token });
    expect(JSON.stringify(listed.body)).not.toContain("svc-Secret-1");
    await expect(waitForAudit(store, "auth_source.create")).resolves.toMatchObject({ name: "Corp LDAP", kind: "ldap" });
  });

  it("rejects plaintext LDAP, unknown kinds, and duplicate names", async () => {
    const plaintext = await createSource({ config: { ...staticConfig, url: "ldap://ldap.example.test" } });
    expect(plaintext.status).toBe(400);
    expect(plaintext.body["error"]).toContain("plaintext LDAP is not allowed");

    expect((await createSource({ kind: "saml" })).status).toBe(400);
    expect((await createSource()).status).toBe(201);
    expect((await createSource()).status).toBe(409);
  });

  it("refuses to store a bind password without ADMIN_AUTH_SECRET", async () => {
    await admin.close();
    admin = await startAdminHttpServer(store, null);

    const created = await createSource();
    expect(created.status).toBe(400);
    expect(created.body["error"]).toBe("ADMIN_AUTH_SECRET is required to encrypt credentials.");
    await expect(store.listAuthSources()).resolves.toEqual([]);
  });

  it("keeps the stored password when an edit sends the mask, and replaces it when a new one is sent", async () => {
    const id = ((await createSource()).body["authSource"] as Record<string, unknown>)["id"] as string;
    const before = (await store.getAuthSourceById(id))?.configJson;

    const renamed = await requestJson(admin.baseUrl, "PUT", `/api/admin/auth-sources/${id}`, {
      token,
      body: { name: "Renamed", enabled: false, config: { ...staticConfig, bindPassword: MASK, timeoutMs: 2000 } },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body["authSource"]).toMatchObject({ name: "Renamed", enabled: false, config: { timeoutMs: 2000, bindPassword: MASK } });
    const afterMask = (await store.getAuthSourceById(id))?.configJson ?? "";
    expect(afterMask).not.toBe(before);
    expect(afterMask).toMatch(/"bindPassword":"veenc:v1:/);

    const toggled = await requestJson(admin.baseUrl, "PUT", `/api/admin/auth-sources/${id}`, { token, body: { enabled: true } });
    expect(toggled.status).toBe(200);
    expect((await store.getAuthSourceById(id))?.configJson).toBe(afterMask);
  });

  it("returns 404 for unknown sources and deletes existing ones", async () => {
    expect((await requestJson(admin.baseUrl, "GET", "/api/admin/auth-sources/missing", { token })).status).toBe(404);
    const id = ((await createSource()).body["authSource"] as Record<string, unknown>)["id"] as string;

    expect((await requestJson(admin.baseUrl, "DELETE", `/api/admin/auth-sources/${id}`, { token })).status).toBe(204);
    expect((await requestJson(admin.baseUrl, "DELETE", `/api/admin/auth-sources/${id}`, { token })).status).toBe(404);
    await expect(waitForAudit(store, "auth_source.delete")).resolves.toMatchObject({ name: "Corp LDAP" });
  });

  it("requires user.manage", async () => {
    const created = await requestJson(admin.baseUrl, "POST", "/api/admin/users", {
      token,
      body: { username: "ops", password: "Operator-Pass-1", role: "operator" },
    });
    expect(created.status).toBe(201);
    const operatorToken = await login(admin.baseUrl, "ops", "Operator-Pass-1");

    const listed = await requestJson(admin.baseUrl, "GET", "/api/admin/auth-sources", { token: operatorToken });
    expect(listed).toMatchObject({ status: 403, body: { error: "forbidden", permission: "user.manage" } });
    expect((await requestJson(admin.baseUrl, "GET", "/api/admin/auth-sources")).status).toBe(401);
  });
});

describe.skipIf(!ldapAvailable)("adminAuthSourceRoutes connection tests (live slapd)", () => {
  let directory: LdapDirectoryServer;
  let store: SqliteStateStore;
  let admin: AdminHttpServer;
  let token: string;

  beforeAll(async () => {
    directory = await startLdapDirectoryServer();
  });

  afterAll(async () => {
    await directory.stop();
  });

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDatabasePath("ve-auth-source-tests"));
    admin = await startAdminHttpServer(store);
    token = await setupAdmin(admin.baseUrl);
  });

  afterEach(async () => {
    await admin.close();
    store.close();
  });

  it("tests an unsaved configuration", async () => {
    const ok = await requestJson(admin.baseUrl, "POST", "/api/admin/auth-sources/test", {
      token,
      body: { kind: "ldap", config: directory.config() },
    });
    expect(ok).toEqual({ status: 200, body: { ok: true } });

    const badPassword = await requestJson(admin.baseUrl, "POST", "/api/admin/auth-sources/test", {
      token,
      body: { kind: "ldap", config: directory.config({ bindPassword: "wrong-Pass-9" }) },
    });
    expect(badPassword.body).toEqual({ ok: false, stage: "bind", error: "The directory rejected the bind credentials" });
  });

  it("tests a stored source and an edit that reuses its masked password", async () => {
    const created = await requestJson(admin.baseUrl, "POST", "/api/admin/auth-sources", {
      token,
      body: { name: "QA", kind: "ldap", config: directory.config() },
    });
    const id = (created.body["authSource"] as Record<string, unknown>)["id"] as string;

    expect((await requestJson(admin.baseUrl, "POST", `/api/admin/auth-sources/${id}/test`, { token })).body).toEqual({ ok: true });

    const editedStartTls = await requestJson(admin.baseUrl, "POST", "/api/admin/auth-sources/test", {
      token,
      body: { id, kind: "ldap", config: directory.config({ url: directory.ldapUrl, startTls: true, bindPassword: MASK }) },
    });
    expect(editedStartTls.body).toEqual({ ok: true });
  });
});
