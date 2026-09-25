import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";
import { login, requestJson, setupAdmin, startAdminHttpServer, type AdminHttpServer } from "./helpers/adminHttp.js";
import { ldapAvailable, startLdapDirectoryServer, type LdapDirectoryServer } from "./helpers/ldapDirectoryServer.js";

const DEVS_DN = "cn=devs,ou=groups,dc=ve,dc=test";

async function waitForAudit(store: SqliteStateStore, action: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { entries } = await store.listAuditEntries({ action });
    if (entries[0]) return entries[0].details;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`audit action ${action} was not recorded`);
}

describe.skipIf(!ldapAvailable)("directory groups and provisioning over HTTP (live slapd)", () => {
  let directory: LdapDirectoryServer;
  let store: SqliteStateStore;
  let admin: AdminHttpServer;
  let rootToken: string;
  let sourceId: string;
  let groupId: string;

  beforeAll(async () => {
    directory = await startLdapDirectoryServer();
    await directory.addUser("alice", "alice-Pass-1");
    await directory.addUser("bob", "bob-Pass-1");
    await directory.addGroup("devs", ["alice", "bob"]);
  });

  afterAll(async () => {
    await directory.stop();
  });

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDatabasePath("ve-directory-groups-http"));
    admin = await startAdminHttpServer(store);
    rootToken = await setupAdmin(admin.baseUrl);
    const source = await call("POST", "/api/admin/auth-sources", { name: "Corp LDAP", kind: "ldap", config: directory.config() });
    sourceId = (source.body["authSource"] as Record<string, unknown>)["id"] as string;
    const group = await call("POST", "/api/admin/groups", { name: "Developers" });
    groupId = (group.body["group"] as Record<string, unknown>)["id"] as string;
  });

  afterEach(async () => {
    await admin.close();
    store.close();
  });

  function call(method: string, path: string, body?: unknown, token: string = rootToken): ReturnType<typeof requestJson> {
    return requestJson(admin.baseUrl, method, path, { token, ...(body !== undefined ? { body } : {}) });
  }

  async function grantToGroup(permission: string): Promise<void> {
    const policy = await call("POST", "/api/admin/policies", { name: `grant ${permission}`, rules: [{ permission }] });
    expect(policy.status).toBe(201);
    const policyId = (policy.body["policy"] as Record<string, unknown>)["id"] as string;
    expect((await call("POST", `/api/admin/policies/${policyId}/bindings`, { principalType: "group", principalId: groupId })).status).toBe(201);
  }

  async function mapDevs(): Promise<string> {
    const mapped = await call("POST", `/api/admin/auth-sources/${sourceId}/group-mappings`, { externalGroup: "CN=Devs, OU=Groups,DC=ve,DC=test", groupId });
    expect(mapped.status).toBe(201);
    return (mapped.body["mapping"] as Record<string, unknown>)["id"] as string;
  }

  it("manages group mappings with policy.manage and normalized DNs", async () => {
    const mappingId = await mapDevs();
    const listed = await call("GET", `/api/admin/auth-sources/${sourceId}/group-mappings`);
    expect(listed.body["mappings"]).toEqual([expect.objectContaining({ id: mappingId, externalGroup: DEVS_DN, groupName: "Developers" })]);
    await expect(waitForAudit(store, "auth_source.group_mapping_create")).resolves.toMatchObject({ externalGroup: DEVS_DN });

    expect((await call("POST", `/api/admin/auth-sources/${sourceId}/group-mappings`, { externalGroup: DEVS_DN, groupId })).status).toBe(409);
    expect((await call("POST", `/api/admin/auth-sources/${sourceId}/group-mappings`, { externalGroup: DEVS_DN, groupId: "missing" })).status).toBe(404);
    expect((await call("POST", `/api/admin/auth-sources/${sourceId}/group-mappings`, { externalGroup: "devs", groupId })).status).toBe(400);

    await call("POST", "/api/admin/users", { username: "op", password: "Oper-Pass-12", role: "operator" });
    const operator = await login(admin.baseUrl, "op", "Oper-Pass-12");
    expect((await call("GET", `/api/admin/auth-sources/${sourceId}/group-mappings`, undefined, operator)).status).toBe(403);

    expect((await call("DELETE", `/api/admin/auth-sources/${sourceId}/group-mappings/${mappingId}`)).status).toBe(204);
    expect((await call("DELETE", `/api/admin/auth-sources/${sourceId}/group-mappings/${mappingId}`)).status).toBe(404);
  });

  it("grants mapped-group policies at sign-in and drops them when the directory membership ends", async () => {
    await grantToGroup("audit.read");
    await mapDevs();
    await call("POST", "/api/admin/users", { authSourceId: sourceId, externalUsername: "alice", role: "operator" });

    const token = await login(admin.baseUrl, "alice", "alice-Pass-1");
    expect((await call("GET", "/api/admin/audit", undefined, token)).status).toBe(200);
    const detail = await call("GET", `/api/admin/groups/${groupId}`);
    expect((detail.body["group"] as Record<string, unknown>)["directoryMembers"]).toEqual([expect.objectContaining({ username: "alice" })]);

    await directory.replaceAttribute(DEVS_DN, "member", ["uid=bob,ou=people,dc=ve,dc=test"]);
    try {
      const refreshed = await login(admin.baseUrl, "alice", "alice-Pass-1");
      expect((await call("GET", "/api/admin/audit", undefined, refreshed)).status).toBe(403);
      expect((await call("GET", "/api/admin/audit", undefined, token)).status).toBe(403);
    } finally {
      await directory.replaceAttribute(DEVS_DN, "member", ["uid=alice,ou=people,dc=ve,dc=test", "uid=bob,ou=people,dc=ve,dc=test"]);
    }
  });

  it("auto-provisions on first sign-in with the default role, which still caps mapped grants", async () => {
    expect((await call("PUT", `/api/admin/auth-sources/${sourceId}`, { defaultRole: "admin" })).status).toBe(400);
    const updated = await call("PUT", `/api/admin/auth-sources/${sourceId}`, { autoProvision: true, defaultRole: "viewer" });
    expect(updated.body["authSource"]).toMatchObject({ autoProvision: true, defaultRole: "viewer" });
    await grantToGroup("user.manage");
    await mapDevs();

    const token = await login(admin.baseUrl, "bob", "bob-Pass-1");
    const me = await call("GET", "/api/admin/auth/me", undefined, token);
    expect(me.body).toMatchObject({ username: "bob", role: "viewer", authSource: { id: sourceId } });
    await expect(waitForAudit(store, "user.provision")).resolves.toMatchObject({ username: "bob", role: "viewer", authSourceId: sourceId });
    expect((await call("GET", "/api/admin/users", undefined, token)).status).toBe(403);

    await call("PUT", `/api/admin/users/${me.body["id"] as string}`, { role: "operator" });
    const operatorToken = await login(admin.baseUrl, "bob", "bob-Pass-1");
    expect((await call("GET", "/api/admin/users", undefined, operatorToken)).status).toBe(200);
  });

  it("previews a directory lookup with mapped groups and link state", async () => {
    await mapDevs();
    const preview = await call("POST", `/api/admin/auth-sources/${sourceId}/lookup`, { username: "alice" });
    expect(preview.body).toMatchObject({
      status: "found",
      account: { username: "alice", groups: [DEVS_DN] },
      mappedGroups: [{ id: groupId, name: "Developers" }],
      linkedUser: null,
      wouldProvision: false,
    });

    await call("POST", "/api/admin/users", { authSourceId: sourceId, externalUsername: "alice", role: "viewer" });
    const linked = await call("POST", `/api/admin/auth-sources/${sourceId}/lookup`, { username: "alice" });
    expect(linked.body["linkedUser"]).toMatchObject({ username: "alice" });

    expect((await call("POST", `/api/admin/auth-sources/${sourceId}/lookup`, { username: "nobody" })).body).toEqual({ status: "not_found" });
    expect((await call("POST", "/api/admin/auth-sources/missing/lookup", { username: "alice" })).status).toBe(404);
  });

  it("reports why an unlinked account would not be created at sign-in", async () => {
    await call("PUT", `/api/admin/auth-sources/${sourceId}`, { autoProvision: true });
    const lookup = async (): Promise<Record<string, unknown>> =>
      (await call("POST", `/api/admin/auth-sources/${sourceId}/lookup`, { username: "bob" })).body;
    await expect(lookup()).resolves.toMatchObject({ wouldProvision: true, blockedReason: null });

    await call("POST", "/api/admin/users", { username: "Bob", password: "local-Pass-12", role: "viewer" });
    await expect(lookup()).resolves.toMatchObject({ wouldProvision: false, blockedReason: "username_taken" });

    await call("PUT", `/api/admin/auth-sources/${sourceId}`, { enabled: false });
    await expect(lookup()).resolves.toMatchObject({ wouldProvision: false, blockedReason: "source_disabled" });
  });
});
