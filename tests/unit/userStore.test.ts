import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

function tempDbPath(): string {
  return tempDatabasePath("ve-users");
}

function futureDate(ms = 3_600_000): Date {
  return new Date(Date.now() + ms);
}

function pastDate(ms = 60_000): Date {
  return new Date(Date.now() - ms);
}

async function makeUser(
  store: SqliteStateStore,
  overrides: Partial<Parameters<SqliteStateStore["createUser"]>[0]> = {}
) {
  return store.createUser({
    id: randomUUID(),
    username: `user-${randomUUID().slice(0, 8)}`,
    passwordHash: "scrypt:16384:8:1:salt:hash",
    role: "viewer",
    ...overrides,
  });
}

describe("userStore — users", () => {
  let store: SqliteStateStore;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
  });

  afterEach(() => {
    store.close();
  });

  it("creates and retrieves a user by id and username", async () => {
    const user = await makeUser(store, { username: "alice", role: "admin" });
    expect(user.username).toBe("alice");
    expect(user.role).toBe("admin");
    expect(user.enabled).toBe(true);
    expect(user.passwordHash).toBe("scrypt:16384:8:1:salt:hash");

    const byId = await store.getUserById(user.id);
    expect(byId?.username).toBe("alice");

    const byName = await store.getUserByUsername("alice");
    expect(byName?.id).toBe(user.id);
  });

  it("returns null for unknown users", async () => {
    expect(await store.getUserById("nope")).toBeNull();
    expect(await store.getUserByUsername("nope")).toBeNull();
  });

  it("createUser honours enabled: false", async () => {
    const user = await makeUser(store, { enabled: false });
    expect(user.enabled).toBe(false);
  });

  it("throws an error with code DUPLICATE on duplicate username", async () => {
    await makeUser(store, { username: "alice" });
    await expect(makeUser(store, { username: "alice" })).rejects.toMatchObject({
      code: "DUPLICATE",
    });
  });

  it("listUsers returns users ordered by username", async () => {
    await makeUser(store, { username: "charlie" });
    await makeUser(store, { username: "alice" });
    await makeUser(store, { username: "bob" });
    const list = await store.listUsers();
    expect(list.map((u) => u.username)).toEqual(["alice", "bob", "charlie"]);
  });

  it("updateUser changes role and enabled; returns null for missing user", async () => {
    const user = await makeUser(store, { role: "viewer" });
    const updated = await store.updateUser(user.id, { role: "operator", enabled: false });
    expect(updated?.role).toBe("operator");
    expect(updated?.enabled).toBe(false);

    expect(await store.updateUser("missing", { role: "admin" })).toBeNull();
  });

  it("updateUserPassword replaces the hash and reports existence", async () => {
    const user = await makeUser(store);
    expect(await store.updateUserPassword(user.id, "new-hash")).toBe(true);
    const fetched = await store.getUserById(user.id);
    expect(fetched?.passwordHash).toBe("new-hash");

    expect(await store.updateUserPassword("missing", "x")).toBe(false);
  });

  it("countUsers and countEnabledAdmins", async () => {
    expect(await store.countUsers()).toBe(0);
    expect(await store.countEnabledAdmins()).toBe(0);

    await makeUser(store, { role: "admin" });
    await makeUser(store, { role: "admin", enabled: false });
    await makeUser(store, { role: "operator" });
    await makeUser(store, { role: "viewer" });

    expect(await store.countUsers()).toBe(4);
    expect(await store.countEnabledAdmins()).toBe(1);
  });

  it("deleteUser removes the user and cascades their sessions", async () => {
    const user = await makeUser(store);
    await store.createSession({ tokenHash: "t1", userId: user.id, expiresAt: futureDate() });
    await store.createSession({ tokenHash: "t2", userId: user.id, expiresAt: futureDate() });

    expect(await store.deleteUser(user.id)).toBe(true);
    expect(await store.getUserById(user.id)).toBeNull();
    expect(await store.getSessionByTokenHash("t1")).toBeNull();
    expect(await store.getSessionByTokenHash("t2")).toBeNull();

    expect(await store.deleteUser(user.id)).toBe(false);
  });
});

describe("userStore — sessions", () => {
  let store: SqliteStateStore;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
  });

  afterEach(() => {
    store.close();
  });

  it("creates a session and resolves it with its user", async () => {
    const user = await makeUser(store, { username: "alice", role: "operator" });
    const session = await store.createSession({
      tokenHash: "hash-1",
      userId: user.id,
      expiresAt: futureDate(),
    });
    expect(session.tokenHash).toBe("hash-1");
    expect(session.userId).toBe(user.id);

    const resolved = await store.getSessionByTokenHash("hash-1");
    expect(resolved).not.toBeNull();
    expect(resolved?.user.username).toBe("alice");
    expect(resolved?.user.role).toBe("operator");
  });

  it("returns null for an unknown token hash", async () => {
    expect(await store.getSessionByTokenHash("missing")).toBeNull();
  });

  it("returns null for an expired session", async () => {
    const user = await makeUser(store);
    await store.createSession({ tokenHash: "expired", userId: user.id, expiresAt: pastDate() });
    expect(await store.getSessionByTokenHash("expired")).toBeNull();
  });

  it("returns null when the user is disabled", async () => {
    const user = await makeUser(store);
    await store.createSession({ tokenHash: "tok", userId: user.id, expiresAt: futureDate() });
    await store.updateUser(user.id, { enabled: false });
    expect(await store.getSessionByTokenHash("tok")).toBeNull();
  });

  it("touchSession slides expiry so a nearly-expired session stays valid", async () => {
    const user = await makeUser(store);
    await store.createSession({ tokenHash: "tok", userId: user.id, expiresAt: futureDate(2_000) });

    const newExpiry = futureDate(7_200_000);
    const newLastSeen = new Date();
    await store.touchSession("tok", { lastSeenAt: newLastSeen, expiresAt: newExpiry });

    const resolved = await store.getSessionByTokenHash("tok");
    expect(resolved).not.toBeNull();
    // Timestamps are stored in whole seconds — compare at second precision.
    expect(Math.floor(resolved!.expiresAt.getTime() / 1000)).toBe(
      Math.floor(newExpiry.getTime() / 1000)
    );
    expect(Math.floor(resolved!.lastSeenAt.getTime() / 1000)).toBe(
      Math.floor(newLastSeen.getTime() / 1000)
    );
  });

  it("deleteSessionByTokenHash removes a single session", async () => {
    const user = await makeUser(store);
    await store.createSession({ tokenHash: "tok", userId: user.id, expiresAt: futureDate() });
    expect(await store.deleteSessionByTokenHash("tok")).toBe(true);
    expect(await store.getSessionByTokenHash("tok")).toBeNull();
    expect(await store.deleteSessionByTokenHash("tok")).toBe(false);
  });

  it("deleteSessionsForUser removes all of a user's sessions and returns the count", async () => {
    const alice = await makeUser(store);
    const bob = await makeUser(store);
    await store.createSession({ tokenHash: "a1", userId: alice.id, expiresAt: futureDate() });
    await store.createSession({ tokenHash: "a2", userId: alice.id, expiresAt: futureDate() });
    await store.createSession({ tokenHash: "b1", userId: bob.id, expiresAt: futureDate() });

    expect(await store.deleteSessionsForUser(alice.id)).toBe(2);
    expect(await store.getSessionByTokenHash("a1")).toBeNull();
    expect(await store.getSessionByTokenHash("b1")).not.toBeNull();
  });

  it("purgeExpiredSessions removes only expired sessions and returns the count", async () => {
    const user = await makeUser(store);
    await store.createSession({ tokenHash: "old1", userId: user.id, expiresAt: pastDate(120_000) });
    await store.createSession({ tokenHash: "old2", userId: user.id, expiresAt: pastDate(60_000) });
    await store.createSession({ tokenHash: "live", userId: user.id, expiresAt: futureDate() });

    expect(await store.purgeExpiredSessions(new Date())).toBe(2);
    expect(await store.getSessionByTokenHash("live")).not.toBeNull();
    expect(await store.purgeExpiredSessions(new Date())).toBe(0);
  });
});
