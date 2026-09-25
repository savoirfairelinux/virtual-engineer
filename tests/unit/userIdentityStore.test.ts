import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { EXTERNAL_PASSWORD_HASH } from "../../src/state/stores/userIdentityStore.js";
import { verifyPassword } from "../../src/admin/authentication/passwordHash.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

describe("userIdentityStore", () => {
  let store: SqliteStateStore;
  let sourceId: string;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDatabasePath("ve-user-identities"));
    sourceId = (await store.createAuthSource({ name: "Corp", kind: "ldap", configJson: "{}" })).id;
  });

  afterEach(() => {
    store.close();
  });

  async function localUser(username: string, role: "admin" | "operator" | "viewer" = "viewer", enabled = true): Promise<string> {
    const id = randomUUID();
    await store.createUser({ id, username, passwordHash: "scrypt:local", role, enabled });
    return id;
  }

  it("creates an external user with an unusable password and a directory link", async () => {
    const { user, identity } = await store.createExternalUser({
      username: "alice",
      role: "operator",
      authSourceId: sourceId,
      externalSubject: "uuid-alice",
      externalUsername: "alice",
    });

    expect(user).toMatchObject({ username: "alice", role: "operator", enabled: true, passwordHash: EXTERNAL_PASSWORD_HASH });
    await expect(verifyPassword("", user.passwordHash)).resolves.toBe(false);
    expect(identity).toMatchObject({ userId: user.id, authSourceId: sourceId, externalSubject: "uuid-alice", lastLoginAt: null });
    await expect(store.getUserIdentityByUserId(user.id)).resolves.toEqual(identity);
    await expect(store.getUserIdentityBySubject(sourceId, "uuid-alice")).resolves.toEqual(identity);
    await expect(store.countUserIdentitiesForSource(sourceId)).resolves.toBe(1);
  });

  it("rejects duplicate usernames and directory accounts without leaving partial rows", async () => {
    await localUser("taken");
    await store.createExternalUser({ username: "bob", role: "viewer", authSourceId: sourceId, externalSubject: "uuid-bob", externalUsername: "bob" });

    await expect(store.createExternalUser({
      username: "taken", role: "viewer", authSourceId: sourceId, externalSubject: "uuid-new", externalUsername: "new",
    })).rejects.toMatchObject({ code: "DUPLICATE" });
    await expect(store.createExternalUser({
      username: "bob2", role: "viewer", authSourceId: sourceId, externalSubject: "uuid-bob", externalUsername: "bob",
    })).rejects.toMatchObject({ code: "DUPLICATE" });

    await expect(store.getUserByUsername("bob2")).resolves.toBeNull();
    await expect(store.getUserIdentityBySubject(sourceId, "uuid-new")).resolves.toBeNull();
  });

  it("links a local user, disabling its password and revoking its sessions", async () => {
    const userId = await localUser("carol");
    await store.createSession({ tokenHash: "carol-session", userId, expiresAt: new Date(Date.now() + 60_000) });

    const identity = await store.linkUserIdentity({ userId, authSourceId: sourceId, externalSubject: "uuid-carol", externalUsername: "carol" });

    expect(identity.userId).toBe(userId);
    expect((await store.getUserById(userId))?.passwordHash).toBe(EXTERNAL_PASSWORD_HASH);
    await expect(store.getSessionByTokenHash("carol-session")).resolves.toBeNull();
    await expect(store.linkUserIdentity({ userId, authSourceId: sourceId, externalSubject: "uuid-other", externalUsername: "x" }))
      .rejects.toMatchObject({ code: "ALREADY_LINKED" });
    await expect(store.linkUserIdentity({ userId: "missing", authSourceId: sourceId, externalSubject: "s", externalUsername: "x" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses to link a directory account that is already linked elsewhere", async () => {
    const first = await localUser("first");
    const second = await localUser("second");
    await store.linkUserIdentity({ userId: first, authSourceId: sourceId, externalSubject: "uuid-shared", externalUsername: "shared" });

    await expect(store.linkUserIdentity({ userId: second, authSourceId: sourceId, externalSubject: "uuid-shared", externalUsername: "shared" }))
      .rejects.toMatchObject({ code: "DUPLICATE" });
    expect((await store.getUserById(second))?.passwordHash).toBe("scrypt:local");
  });

  it("keeps at least one enabled local admin", async () => {
    const root = await localUser("root", "admin");
    await localUser("disabled-admin", "admin", false);

    await expect(store.countEnabledLocalAdmins()).resolves.toBe(1);
    await expect(store.linkUserIdentity({ userId: root, authSourceId: sourceId, externalSubject: "uuid-root", externalUsername: "root" }))
      .rejects.toMatchObject({ code: "LAST_LOCAL_ADMIN" });

    const second = await localUser("second-admin", "admin");
    await store.linkUserIdentity({ userId: second, authSourceId: sourceId, externalSubject: "uuid-2", externalUsername: "second" });
    await expect(store.countEnabledLocalAdmins()).resolves.toBe(1);
    await expect(store.countEnabledAdmins()).resolves.toBe(2);
  });

  it("checks the current admins inside the update and delete transactions", async () => {
    const root = await localUser("root", "admin");
    await expect(store.updateUser(root, { role: "viewer" })).rejects.toMatchObject({ code: "LAST_ADMIN" });
    await expect(store.deleteUser(root)).rejects.toMatchObject({ code: "LAST_ADMIN" });

    const { user: directoryAdmin } = await store.createExternalUser({
      username: "alice", role: "admin", authSourceId: sourceId, externalSubject: "uuid-alice", externalUsername: "alice",
    });
    await expect(store.updateUser(root, { enabled: false })).rejects.toMatchObject({ code: "LAST_LOCAL_ADMIN" });
    await expect(store.deleteUser(root)).rejects.toMatchObject({ code: "LAST_LOCAL_ADMIN" });
    await expect(store.getUserById(root)).resolves.toMatchObject({ role: "admin", enabled: true });
    await expect(store.updateUser(directoryAdmin.id, { role: "viewer" })).resolves.toMatchObject({ role: "viewer" });

    const second = await localUser("second", "admin");
    const raced = await Promise.allSettled([
      store.updateUser(root, { role: "operator" }),
      store.updateUser(second, { enabled: false }),
    ]);
    expect(raced.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    await expect(store.countEnabledAdmins()).resolves.toBe(1);
  });

  it("issues a session only while the user's directory link is the one that signed in", async () => {
    const userId = await localUser("frank");
    const expiresAt = new Date(Date.now() + 60_000);
    await store.createSession({ tokenHash: "local", userId, expiresAt, identityId: null });
    const identity = await store.linkUserIdentity({ userId, authSourceId: sourceId, externalSubject: "uuid-frank", externalUsername: "frank" });

    await expect(store.createSession({ tokenHash: "stale-local", userId, expiresAt, identityId: null }))
      .rejects.toMatchObject({ code: "IDENTITY_CHANGED" });
    await store.createSession({ tokenHash: "linked", userId, expiresAt, identityId: identity.id });
    await expect(store.getSessionByTokenHash("linked")).resolves.toMatchObject({ userId });
    await store.unlinkUserIdentity(userId, "scrypt:new");
    await expect(store.createSession({ tokenHash: "stale-link", userId, expiresAt, identityId: identity.id }))
      .rejects.toMatchObject({ code: "IDENTITY_CHANGED" });

    await expect(store.getSessionByTokenHash("stale-local")).resolves.toBeNull();
    await expect(store.getSessionByTokenHash("stale-link")).resolves.toBeNull();
  });

  it("issues no directory session while the account's source is disabled", async () => {
    const userId = await localUser("gina");
    const identity = await store.linkUserIdentity({ userId, authSourceId: sourceId, externalSubject: "uuid-gina", externalUsername: "gina" });
    await store.updateAuthSource(sourceId, { enabled: false });

    await expect(store.createSession({ tokenHash: "while-disabled", userId, expiresAt: new Date(Date.now() + 60_000), identityId: identity.id }))
      .rejects.toMatchObject({ code: "SOURCE_DISABLED" });
    await expect(store.getSessionByTokenHash("while-disabled")).resolves.toBeNull();
  });

  it("unlinks with a new local password hash and revokes sessions", async () => {
    const userId = await localUser("dave");
    await store.linkUserIdentity({ userId, authSourceId: sourceId, externalSubject: "uuid-dave", externalUsername: "dave" });
    await store.createSession({ tokenHash: "dave-session", userId, expiresAt: new Date(Date.now() + 60_000) });

    await expect(store.unlinkUserIdentity(userId, "scrypt:new")).resolves.toBe(true);
    expect((await store.getUserById(userId))?.passwordHash).toBe("scrypt:new");
    await expect(store.getSessionByTokenHash("dave-session")).resolves.toBeNull();
    await expect(store.getUserIdentityByUserId(userId)).resolves.toBeNull();
    await expect(store.unlinkUserIdentity(userId, "scrypt:other")).resolves.toBe(false);
    expect((await store.getUserById(userId))?.passwordHash).toBe("scrypt:new");
  });

  it("revokes the sessions of every user linked to a source", async () => {
    const { user } = await store.createExternalUser({
      username: "fay", role: "viewer", authSourceId: sourceId, externalSubject: "uuid-fay", externalUsername: "fay",
    });
    const localId = await localUser("gus");
    const at = new Date(Math.floor(Date.now() / 1000) * 1000);
    await store.createSession({ tokenHash: "fay-session", userId: user.id, expiresAt: new Date(Date.now() + 60_000), validatedAt: at });
    await store.createSession({ tokenHash: "gus-session", userId: localId, expiresAt: new Date(Date.now() + 60_000) });

    await expect(store.getSessionByTokenHash("fay-session")).resolves.toMatchObject({ validatedAt: at });
    await expect(store.getSessionByTokenHash("gus-session")).resolves.toMatchObject({ validatedAt: null });
    const later = new Date(at.getTime() + 60_000);
    await store.markSessionValidated("gus-session", later);
    await expect(store.getSessionByTokenHash("gus-session")).resolves.toMatchObject({ validatedAt: later });

    await expect(store.deleteSessionsForAuthSource(sourceId)).resolves.toBe(1);
    await expect(store.getSessionByTokenHash("fay-session")).resolves.toBeNull();
    await expect(store.getSessionByTokenHash("gus-session")).resolves.not.toBeNull();
  });

  it("records logins and follows user deletion; sources with links cannot be deleted", async () => {
    const { user, identity } = await store.createExternalUser({
      username: "erin", role: "viewer", authSourceId: sourceId, externalSubject: "uuid-erin", externalUsername: "erin",
    });
    const at = new Date(Math.floor(Date.now() / 1000) * 1000);

    await store.recordIdentityLogin(identity.id, { externalUsername: "erin.renamed", at });
    await expect(store.getUserIdentityByUserId(user.id)).resolves.toMatchObject({ externalUsername: "erin.renamed", lastLoginAt: at });

    await expect(store.deleteAuthSource(sourceId)).rejects.toThrow(/FOREIGN KEY/);
    await store.deleteUser(user.id);
    await expect(store.listUserIdentities()).resolves.toEqual([]);
    await expect(store.deleteAuthSource(sourceId)).resolves.toBe(true);
  });
});
