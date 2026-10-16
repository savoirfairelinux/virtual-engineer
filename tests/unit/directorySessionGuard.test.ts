import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { ldapConfigSchema, serializeLdapConfig } from "../../src/admin/authentication/ldapConfig.js";
import { createDirectoryAuthenticator } from "../../src/admin/authentication/directoryAuthenticator.js";
import { createDirectorySessionGuard } from "../../src/admin/authentication/directorySessionGuard.js";
import { hashPassword } from "../../src/admin/authentication/passwordHash.js";
import { lookupLdapAccount } from "../../src/admin/authentication/ldapDirectory.js";
import { createAdminAuthService, hashSessionToken, type AdminAuthService } from "../../src/admin/adminAuthService.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";
import { TEST_ADMIN_SECRET } from "./helpers/adminHttp.js";
import { ldapAvailable, startLdapDirectoryServer, type LdapDirectoryServer } from "./helpers/ldapDirectoryServer.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe.skipIf(!ldapAvailable)("directory session lifecycle (live slapd)", () => {
  let directory: LdapDirectoryServer;
  let store: SqliteStateStore;
  let service: AdminAuthService;
  let sourceId: string;
  let offsetMs: number;

  beforeAll(async () => {
    directory = await startLdapDirectoryServer();
    await directory.addUser("alice", "alice-Pass-1");
    await directory.addGroup("devs", ["alice"]);
  });

  afterAll(async () => {
    await directory.stop();
  });

  beforeEach(async () => {
    offsetMs = 0;
    store = await SqliteStateStore.create(tempDatabasePath("ve-session-guard"));
    sourceId = (await store.createAuthSource({
      name: "Corp",
      kind: "ldap",
      configJson: serializeLdapConfig(ldapConfigSchema.parse(directory.config()), TEST_ADMIN_SECRET),
      sessionMaxAgeHours: 8,
      revalidateIntervalMinutes: 15,
    })).id;
    const lookup = await lookupLdapAccount(ldapConfigSchema.parse(directory.config()), "alice");
    if (lookup.status !== "found") throw new Error("alice missing from the test directory");
    await store.createExternalUser({
      username: "alice", role: "viewer", authSourceId: sourceId, externalSubject: lookup.account.subject, externalUsername: "alice",
    });
    service = createAdminAuthService({
      stateStore: store,
      authenticator: createDirectoryAuthenticator({ store, adminAuthSecret: TEST_ADMIN_SECRET }),
      sessionGuard: createDirectorySessionGuard({ store, adminAuthSecret: TEST_ADMIN_SECRET }),
      now: () => new Date(Date.now() + offsetMs),
    });
  });

  afterEach(() => {
    store.close();
  });

  async function signIn(username = "alice", password = "alice-Pass-1"): Promise<string> {
    const result = await service.login(username, password);
    if (result.status !== "ok") throw new Error(`login ${result.status}`);
    return result.session.token;
  }

  async function pointSourceAt(url: string): Promise<void> {
    await store.updateAuthSource(sourceId, {
      configJson: serializeLdapConfig(ldapConfigSchema.parse(directory.config({ url })), TEST_ADMIN_SECRET),
    });
  }

  it("stamps directory sessions as validated and leaves local sessions alone", async () => {
    const token = await signIn();
    expect((await store.getSessionByTokenHash(hashSessionToken(token)))?.validatedAt).toBeInstanceOf(Date);

    await store.createUser({ id: randomUUID(), username: "root", passwordHash: await hashPassword("Root-Pass-12"), role: "admin" });
    const local = await signIn("root", "Root-Pass-12");
    expect((await store.getSessionByTokenHash(hashSessionToken(local)))?.validatedAt).toBeNull();
    offsetMs = 11 * HOUR;
    await expect(service.validateSession(local)).resolves.toMatchObject({ username: "root" });
  });

  it("ends directory sessions at the source's absolute age limit", async () => {
    const token = await signIn();
    offsetMs = 7 * HOUR + 59 * MINUTE;
    await expect(service.validateSession(token)).resolves.toMatchObject({ username: "alice" });

    offsetMs = 8 * HOUR;
    await expect(service.validateSession(token)).resolves.toBeNull();
    await expect(store.getSessionByTokenHash(hashSessionToken(token))).resolves.toBeNull();
  });

  it("skips the directory within the revalidation interval, then refreshes groups", async () => {
    const token = await signIn();
    const identityId = (await store.getUserIdentityByUserId((await store.getUserByUsername("alice"))?.id ?? ""))?.id ?? "";
    await pointSourceAt(directory.ldapsUrl.replace(/:\d+$/, ":1"));
    offsetMs = 10 * MINUTE;
    await expect(service.validateSession(token)).resolves.toMatchObject({ username: "alice" });

    await pointSourceAt(directory.ldapsUrl);
    await directory.replaceAttribute("cn=devs,ou=groups,dc=ve,dc=test", "member", ["cn=nobody"]);
    try {
      offsetMs = 20 * MINUTE;
      await expect(service.validateSession(token)).resolves.toMatchObject({ username: "alice" });
      await expect(store.listIdentityGroups(identityId)).resolves.toEqual([]);
      const validatedAt = (await store.getSessionByTokenHash(hashSessionToken(token)))?.validatedAt?.getTime() ?? 0;
      expect(validatedAt).toBeGreaterThan(Date.now() + 19 * MINUTE);
    } finally {
      await directory.replaceAttribute("cn=devs,ou=groups,dc=ve,dc=test", "member", ["uid=alice,ou=people,dc=ve,dc=test"]);
    }
  });

  it("keeps the session through a directory outage but not past the age limit", async () => {
    const token = await signIn();
    await pointSourceAt(directory.ldapsUrl.replace(/:\d+$/, ":1"));

    offsetMs = 30 * MINUTE;
    await expect(service.validateSession(token)).resolves.toMatchObject({ username: "alice" });
    offsetMs = 8 * HOUR;
    await expect(service.validateSession(token)).resolves.toBeNull();
  });

  it("revokes the session once the account no longer matches the user filter", async () => {
    const token = await signIn();
    await store.updateAuthSource(sourceId, {
      configJson: serializeLdapConfig(ldapConfigSchema.parse(directory.config({
        userSearchFilter: "(&(objectClass=inetOrgPerson)(uid={username})(!(employeeType=disabled)))",
      })), TEST_ADMIN_SECRET),
    });
    await directory.replaceAttribute("uid=alice,ou=people,dc=ve,dc=test", "employeeType", ["disabled"]);
    try {
      offsetMs = 16 * MINUTE;
      await expect(service.validateSession(token)).resolves.toBeNull();
    } finally {
      await directory.replaceAttribute("uid=alice,ou=people,dc=ve,dc=test", "employeeType", []);
    }
  });

  it("revalidates on every request when the interval is zero, and revokes when the source is disabled", async () => {
    await store.updateAuthSource(sourceId, { revalidateIntervalMinutes: 0 });
    const token = await signIn();
    const before = (await store.getSessionByTokenHash(hashSessionToken(token)))?.validatedAt?.getTime() ?? 0;
    offsetMs = 5_000;
    await expect(service.validateSession(token)).resolves.toMatchObject({ username: "alice" });
    const after = (await store.getSessionByTokenHash(hashSessionToken(token)))?.validatedAt?.getTime() ?? 0;
    expect(after).toBeGreaterThan(before);

    await store.updateAuthSource(sourceId, { enabled: false });
    await expect(service.validateSession(token)).resolves.toBeNull();
  });
});
