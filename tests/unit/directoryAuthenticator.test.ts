import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { ldapConfigSchema, serializeLdapConfig } from "../../src/admin/authentication/ldapConfig.js";
import { lookupLdapAccount } from "../../src/admin/authentication/ldapDirectory.js";
import { hashPassword } from "../../src/admin/authentication/passwordHash.js";
import {
  createDirectoryAccountResolver,
  createDirectoryAuthenticator,
} from "../../src/admin/authentication/directoryAuthenticator.js";
import type { PasswordAuthenticator } from "../../src/admin/authentication/passwordAuthenticator.js";
import { createAdminAuthService, SESSION_TTL_MS } from "../../src/admin/adminAuthService.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";
import { TEST_ADMIN_SECRET } from "./helpers/adminHttp.js";
import { ldapAvailable, startLdapDirectoryServer, type LdapDirectoryServer } from "./helpers/ldapDirectoryServer.js";

describe.skipIf(!ldapAvailable)("createDirectoryAuthenticator (live slapd)", () => {
  let directory: LdapDirectoryServer;
  let store: SqliteStateStore;
  let authenticator: PasswordAuthenticator;
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
    store = await SqliteStateStore.create(tempDatabasePath("ve-directory-auth"));
    sourceId = (await createSource("Corp", directory.config())).id;
    authenticator = createDirectoryAuthenticator({ store, adminAuthSecret: TEST_ADMIN_SECRET });
  });

  afterEach(() => {
    store.close();
  });

  function createSource(name: string, config: Record<string, unknown>, priority = 100): ReturnType<SqliteStateStore["createAuthSource"]> {
    return store.createAuthSource({
      name,
      kind: "ldap",
      priority,
      configJson: serializeLdapConfig(ldapConfigSchema.parse(config), TEST_ADMIN_SECRET),
    });
  }

  async function subjectOf(uid: string): Promise<string> {
    const lookup = await lookupLdapAccount(ldapConfigSchema.parse(directory.config()), uid);
    if (lookup.status !== "found") throw new Error(`no directory account ${uid}`);
    return lookup.account.subject;
  }

  async function linkedUser(username: string, externalUsername: string, enabled = true): Promise<string> {
    const { user } = await store.createExternalUser({
      username,
      role: "viewer",
      enabled,
      authSourceId: sourceId,
      externalSubject: await subjectOf(externalUsername),
      externalUsername,
    });
    return user.id;
  }

  it("signs a linked user in through the directory and records the login", async () => {
    const userId = await linkedUser("alice", "alice");

    const outcome = await authenticator.authenticate("alice", "alice-Pass-1");

    const identity = await store.getUserIdentityByUserId(userId);
    expect(outcome).toMatchObject({ status: "authenticated", user: { id: userId }, authSourceId: sourceId, identityId: identity?.id });
    expect(identity?.lastLoginAt).toBeInstanceOf(Date);
    await expect(authenticator.authenticate("alice", "wrong-Pass-1")).resolves.toEqual({ status: "rejected" });
  });

  it("finds a linked user by directory name when the local username differs", async () => {
    const userId = await linkedUser("alice.local", "alice");

    await expect(authenticator.authenticate("alice", "alice-Pass-1"))
      .resolves.toMatchObject({ status: "authenticated", user: { id: userId } });
    await expect(authenticator.authenticate("alice.local", "alice-Pass-1"))
      .resolves.toMatchObject({ status: "authenticated", user: { id: userId } });
  });

  it("rejects directory accounts that are not linked to a user", async () => {
    await expect(authenticator.authenticate("bob", "bob-Pass-1")).resolves.toEqual({ status: "rejected" });
  });

  it("keeps local passwords authoritative for unlinked local users", async () => {
    await store.createUser({ id: randomUUID(), username: "bob", passwordHash: await hashPassword("local-Pass-1"), role: "viewer" });

    await expect(authenticator.authenticate("bob", "local-Pass-1")).resolves.toMatchObject({ status: "authenticated", authSourceId: null, identityId: null });
    await expect(authenticator.authenticate("bob", "bob-Pass-1")).resolves.toEqual({ status: "rejected" });
  });

  it("rejects disabled users and users of a disabled source", async () => {
    await linkedUser("alice", "alice", false);
    await expect(authenticator.authenticate("alice", "alice-Pass-1")).resolves.toEqual({ status: "rejected" });

    await linkedUser("bob", "bob");
    await store.updateAuthSource(sourceId, { enabled: false });
    await expect(authenticator.authenticate("bob", "bob-Pass-1")).resolves.toEqual({ status: "rejected" });
  });

  it("refuses to sign in when the linked name now belongs to a different entry", async () => {
    const userId = await linkedUser("bob", "bob");
    await directory.deleteEntry("uid=bob,ou=people,dc=ve,dc=test");
    await directory.addUser("bob", "bob-Pass-1");

    await expect(authenticator.authenticate("bob", "bob-Pass-1")).resolves.toEqual({ status: "rejected" });
    expect((await store.getUserIdentityByUserId(userId))?.lastLoginAt).toBeNull();
  });

  it("keeps signing a linked user in after the directory renames the account", async () => {
    await directory.addUser("erin", "erin-Pass-1");
    const userId = await linkedUser("erin", "erin");
    await directory.renameEntry("uid=erin,ou=people,dc=ve,dc=test", "uid=erin.new");

    await expect(authenticator.authenticate("erin", "erin-Pass-1")).resolves.toMatchObject({ status: "authenticated", user: { id: userId } });
    await expect(store.getUserIdentityByUserId(userId)).resolves.toMatchObject({ externalUsername: "erin.new" });
  });

  it("still signs in when the login metadata cannot be recorded", async () => {
    const userId = await linkedUser("alice", "alice");
    (store as unknown as { raw: { exec(sql: string): unknown } }).raw.exec(`
      CREATE TRIGGER reject_identity_login BEFORE UPDATE ON user_identities
      BEGIN SELECT RAISE(ABORT, 'identity update rejected'); END
    `);

    await expect(authenticator.authenticate("alice", "alice-Pass-1")).resolves.toMatchObject({ status: "authenticated", user: { id: userId } });
    expect((await store.getUserIdentityByUserId(userId))?.lastLoginAt).toBeNull();
  });

  it("is unavailable when the directory cannot be reached", async () => {
    await linkedUser("alice", "alice");
    const closed = directory.ldapsUrl.replace(/:\d+$/, ":1");
    await store.updateAuthSource(sourceId, {
      configJson: serializeLdapConfig(ldapConfigSchema.parse(directory.config({ url: closed })), TEST_ADMIN_SECRET),
    });

    await expect(authenticator.authenticate("alice", "alice-Pass-1")).resolves.toEqual({ status: "unavailable" });
    await expect(authenticator.authenticate("unknown", "any-Pass-1")).resolves.toEqual({ status: "unavailable" });
  });

  it("tries sources in priority order and skips an unreachable one", async () => {
    const closed = directory.ldapsUrl.replace(/:\d+$/, ":1");
    await createSource("Down", directory.config({ url: closed }), 1);
    const userId = await linkedUser("alice", "alice");

    await expect(authenticator.authenticate("alice", "alice-Pass-1")).resolves.toMatchObject({ status: "authenticated", user: { id: userId } });
    await expect(authenticator.authenticate("unknown", "any-Pass-1")).resolves.toEqual({ status: "unavailable" });
  });

  it("never reports unavailable once a reachable directory has judged the password", async () => {
    const closed = directory.ldapsUrl.replace(/:\d+$/, ":1");
    await createSource("Down", directory.config({ url: closed }), 1);

    await expect(authenticator.authenticate("bob", "wrong-Pass-1")).resolves.toEqual({ status: "rejected" });
    // Correct password for an unlinked account: must be indistinguishable from a wrong one.
    await expect(authenticator.authenticate("bob", "bob-Pass-1")).resolves.toEqual({ status: "rejected" });
  });

  it("is unavailable when a stored source cannot be decrypted", async () => {
    await linkedUser("alice", "alice");
    const wrongSecret = createDirectoryAuthenticator({ store, adminAuthSecret: "another-admin-secret-with-32-chars!!" });

    await expect(wrongSecret.authenticate("alice", "alice-Pass-1")).resolves.toEqual({ status: "unavailable" });
  });

  it("resolves directory accounts for admin linking", async () => {
    const resolver = createDirectoryAccountResolver({ store, adminAuthSecret: TEST_ADMIN_SECRET });

    await expect(resolver.resolve(sourceId, "alice")).resolves.toMatchObject({
      status: "found",
      source: { id: sourceId },
      account: { username: "alice", subject: await subjectOf("alice") },
    });
    await expect(resolver.resolve(sourceId, "nobody")).resolves.toEqual({ status: "not_found" });
    await expect(resolver.resolve("missing", "alice")).resolves.toEqual({ status: "source_not_found" });
  });

  /** Runs `change` after the real authenticator answers, before the auth service issues a session. */
  function changedWhilePending(change: () => Promise<unknown>): PasswordAuthenticator {
    return {
      async authenticate(username, password) {
        const outcome = await authenticator.authenticate(username, password);
        await change();
        return outcome;
      },
    };
  }

  async function sessionCount(): Promise<number> {
    return store.purgeExpiredSessions(new Date(Date.now() + 2 * SESSION_TTL_MS));
  }

  it("issues no session when the account is unlinked while LDAP sign-in is pending", async () => {
    const userId = await linkedUser("alice", "alice");
    const unlinking = changedWhilePending(async () => store.unlinkUserIdentity(userId, await hashPassword("local-Pass-1")));

    await expect(createAdminAuthService({ stateStore: store, authenticator: unlinking }).login("alice", "alice-Pass-1"))
      .resolves.toEqual({ status: "rejected" });
    expect(await sessionCount()).toBe(0);
  });

  it("issues no session when a local account is linked while its password is being checked", async () => {
    const userId = randomUUID();
    await store.createUser({ id: userId, username: "carol", passwordHash: await hashPassword("carol-Pass-1"), role: "viewer" });
    const linking = changedWhilePending(async () => store.linkUserIdentity({
      userId, authSourceId: sourceId, externalSubject: await subjectOf("bob"), externalUsername: "bob",
    }));

    await expect(createAdminAuthService({ stateStore: store, authenticator: linking }).login("carol", "carol-Pass-1"))
      .resolves.toEqual({ status: "rejected" });
    expect(await sessionCount()).toBe(0);
  });
});
