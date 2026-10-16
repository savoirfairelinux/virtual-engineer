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

describe.skipIf(!ldapAvailable)("directory sessions over HTTP (live slapd)", () => {
  let directory: LdapDirectoryServer;
  let store: SqliteStateStore;
  let admin: AdminHttpServer;
  let rootToken: string;
  let sourceId: string;

  beforeAll(async () => {
    directory = await startLdapDirectoryServer();
  });

  afterAll(async () => {
    await directory.stop();
  });

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDatabasePath("ve-directory-sessions"));
    admin = await startAdminHttpServer(store);
    rootToken = await setupAdmin(admin.baseUrl);
    const source = await call("POST", "/api/admin/auth-sources", { name: "Corp LDAP", kind: "ldap", config: directory.config() });
    expect(source.body["authSource"]).toMatchObject({ sessionMaxAgeHours: 24, revalidateIntervalMinutes: 15 });
    sourceId = (source.body["authSource"] as Record<string, unknown>)["id"] as string;
  });

  afterEach(async () => {
    await admin.close();
    store.close();
  });

  function call(method: string, path: string, body?: unknown, token: string = rootToken): ReturnType<typeof requestJson> {
    return requestJson(admin.baseUrl, method, path, { token, ...(body !== undefined ? { body } : {}) });
  }

  async function directoryUserToken(uid: string): Promise<string> {
    await directory.addUser(uid, `${uid}-Pass-1`);
    expect((await call("POST", "/api/admin/users", { authSourceId: sourceId, externalUsername: uid, role: "viewer" })).status).toBe(201);
    return login(admin.baseUrl, uid, `${uid}-Pass-1`);
  }

  it("validates session settings", async () => {
    expect((await call("PUT", `/api/admin/auth-sources/${sourceId}`, { sessionMaxAgeHours: 0 })).status).toBe(400);
    expect((await call("PUT", `/api/admin/auth-sources/${sourceId}`, { revalidateIntervalMinutes: 1441 })).status).toBe(400);
    const updated = await call("PUT", `/api/admin/auth-sources/${sourceId}`, { sessionMaxAgeHours: 4, revalidateIntervalMinutes: 0 });
    expect(updated.body["authSource"]).toMatchObject({ sessionMaxAgeHours: 4, revalidateIntervalMinutes: 0 });
  });

  it("revokes directory sessions as soon as the source is disabled", async () => {
    const token = await directoryUserToken("dana");
    expect((await call("GET", "/api/admin/auth/me", undefined, token)).status).toBe(200);

    expect((await call("PUT", `/api/admin/auth-sources/${sourceId}`, { enabled: false })).status).toBe(200);
    expect((await call("GET", "/api/admin/auth/me", undefined, token)).status).toBe(401);
    expect((await call("GET", "/api/admin/auth/me")).status).toBe(200);
    await expect(waitForAudit(store, "auth_source.update")).resolves.toMatchObject({ enabled: false, revokedSessions: 1 });
  });

  it("signs a removed directory account out on its next request when revalidating every request", async () => {
    expect((await call("PUT", `/api/admin/auth-sources/${sourceId}`, { revalidateIntervalMinutes: 0 })).status).toBe(200);
    const token = await directoryUserToken("eve");
    expect((await call("GET", "/api/admin/auth/me", undefined, token)).status).toBe(200);

    await directory.deleteEntry("uid=eve,ou=people,dc=ve,dc=test");
    expect((await call("GET", "/api/admin/auth/me", undefined, token)).status).toBe(401);
    expect((await call("GET", "/api/admin/auth/me")).status).toBe(200);
  });
});
