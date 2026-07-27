import { describe, expect, it } from "vitest";
import type { AdminUser, UserSession } from "../../src/interfaces.js";
import {
  createAdminAuthService,
  hashPassword,
  hashSessionToken,
  verifyPassword,
  SESSION_TTL_MS,
  type AdminAuthStateStore,
} from "../../src/admin/adminAuthService.js";

function makeUser(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: "user-1",
    username: "alice",
    passwordHash: "",
    role: "admin",
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface MockStore extends AdminAuthStateStore {
  users: Map<string, AdminUser>;
  sessions: Map<string, UserSession>;
  touchCalls: Array<{ tokenHash: string; lastSeenAt: Date; expiresAt: Date }>;
  purgeCalls: number;
}

function makeStore(users: AdminUser[] = []): MockStore {
  const store: MockStore = {
    users: new Map(users.map((u) => [u.username, u])),
    sessions: new Map(),
    touchCalls: [],
    purgeCalls: 0,
    async getUserByUsername(username) {
      return store.users.get(username) ?? null;
    },
    async createSession(input) {
      const session: UserSession = {
        id: store.sessions.size + 1,
        tokenHash: input.tokenHash,
        userId: input.userId,
        createdAt: new Date(),
        expiresAt: input.expiresAt,
        lastSeenAt: new Date(),
      };
      store.sessions.set(input.tokenHash, session);
      return session;
    },
    async getSessionByTokenHash(tokenHash) {
      const session = store.sessions.get(tokenHash);
      if (!session) return null;
      if (session.expiresAt.getTime() <= Date.now()) return null;
      const user = [...store.users.values()].find((u) => u.id === session.userId);
      if (!user || !user.enabled) return null;
      return { ...session, user };
    },
    async touchSession(tokenHash, update) {
      store.touchCalls.push({ tokenHash, ...update });
      const session = store.sessions.get(tokenHash);
      if (session) {
        session.lastSeenAt = update.lastSeenAt;
        session.expiresAt = update.expiresAt;
      }
    },
    async deleteSessionByTokenHash(tokenHash) {
      return store.sessions.delete(tokenHash);
    },
    async purgeExpiredSessions(_now) {
      store.purgeCalls += 1;
      return 0;
    },
  };
  return store;
}

describe("hashPassword / verifyPassword", () => {
  it("round-trips a password through scrypt hash and verify", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^scrypt:16384:8:1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    await expect(verifyPassword("correct horse battery", hash)).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery");
    await expect(verifyPassword("wrong password!!", hash)).resolves.toBe(false);
  });

  it("produces unique hashes for the same password (random salt)", async () => {
    const [a, b] = await Promise.all([hashPassword("same-password"), hashPassword("same-password")]);
    expect(a).not.toBe(b);
  });

  it("returns false for malformed stored hashes", async () => {
    await expect(verifyPassword("pw", "not-a-hash")).resolves.toBe(false);
    await expect(verifyPassword("pw", "scrypt:16384:8:1:onlyfive")).resolves.toBe(false);
    await expect(verifyPassword("pw", "bcrypt:16384:8:1:aaaa:bbbb")).resolves.toBe(false);
    await expect(verifyPassword("pw", "scrypt:zzz:8:1:aaaa:bbbb")).resolves.toBe(false);
  });
});

describe("createAdminAuthService — login", () => {
  it("returns a token and public user shape on success", async () => {
    const passwordHash = await hashPassword("hunter2hunter2");
    const store = makeStore([makeUser({ passwordHash })]);
    const service = createAdminAuthService({ stateStore: store });

    const result = await service.login("alice", "hunter2hunter2");
    expect(result).not.toBeNull();
    expect(result?.token).toMatch(/^[0-9a-f]{64}$/);
    expect(result?.user).toEqual({ id: "user-1", username: "alice", role: "admin" });

    // The stored session holds the sha256 of the token, not the raw token.
    const session = store.sessions.get(hashSessionToken(result?.token ?? ""));
    expect(session).toBeDefined();
    expect(session?.userId).toBe("user-1");
    expect(session?.expiresAt.getTime()).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 60_000);
    expect(store.purgeCalls).toBe(1);
  });

  it("returns null for an unknown user", async () => {
    const service = createAdminAuthService({ stateStore: makeStore() });
    await expect(service.login("nobody", "whateverpw")).resolves.toBeNull();
  });

  it("returns null for a wrong password", async () => {
    const passwordHash = await hashPassword("hunter2hunter2");
    const store = makeStore([makeUser({ passwordHash })]);
    const service = createAdminAuthService({ stateStore: store });
    await expect(service.login("alice", "not-the-password")).resolves.toBeNull();
    expect(store.sessions.size).toBe(0);
  });

  it("returns null for a disabled user even with the right password", async () => {
    const passwordHash = await hashPassword("hunter2hunter2");
    const store = makeStore([makeUser({ passwordHash, enabled: false })]);
    const service = createAdminAuthService({ stateStore: store });
    await expect(service.login("alice", "hunter2hunter2")).resolves.toBeNull();
  });
});

describe("createAdminAuthService — validateSession", () => {
  async function loggedInService(): Promise<{ service: ReturnType<typeof createAdminAuthService>; store: MockStore; token: string }> {
    const passwordHash = await hashPassword("hunter2hunter2");
    const store = makeStore([makeUser({ passwordHash })]);
    const service = createAdminAuthService({ stateStore: store });
    const result = await service.login("alice", "hunter2hunter2");
    if (!result) throw new Error("login failed in test setup");
    return { service, store, token: result.token };
  }

  it("resolves a valid token to an AuthContext", async () => {
    const { service, token } = await loggedInService();
    await expect(service.validateSession(token)).resolves.toEqual({
      userId: "user-1",
      username: "alice",
      role: "admin",
    });
  });

  it("returns null for garbage and empty tokens", async () => {
    const { service } = await loggedInService();
    await expect(service.validateSession("garbage")).resolves.toBeNull();
    await expect(service.validateSession("")).resolves.toBeNull();
  });

  it("returns null for an expired session", async () => {
    const { service, store, token } = await loggedInService();
    const session = store.sessions.get(hashSessionToken(token));
    if (!session) throw new Error("missing session");
    session.expiresAt = new Date(Date.now() - 1000);
    await expect(service.validateSession(token)).resolves.toBeNull();
  });

  it("does not touch a session seen less than 60s ago", async () => {
    const { service, store, token } = await loggedInService();
    await service.validateSession(token);
    expect(store.touchCalls).toHaveLength(0);
  });

  it("touches a session (sliding expiry) when last seen more than 60s ago", async () => {
    const { service, store, token } = await loggedInService();
    const session = store.sessions.get(hashSessionToken(token));
    if (!session) throw new Error("missing session");
    session.lastSeenAt = new Date(Date.now() - 120_000);

    await service.validateSession(token);
    expect(store.touchCalls).toHaveLength(1);
    const touch = store.touchCalls[0];
    expect(touch?.expiresAt.getTime()).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 60_000);
  });
});

describe("createAdminAuthService — logout", () => {
  it("revokes the session so the token stops validating", async () => {
    const passwordHash = await hashPassword("hunter2hunter2");
    const store = makeStore([makeUser({ passwordHash })]);
    const service = createAdminAuthService({ stateStore: store });
    const result = await service.login("alice", "hunter2hunter2");
    if (!result) throw new Error("login failed in test setup");

    await expect(service.logout(result.token)).resolves.toBe(true);
    await expect(service.validateSession(result.token)).resolves.toBeNull();
    await expect(service.logout(result.token)).resolves.toBe(false);
  });

  it("returns false for an empty token", async () => {
    const service = createAdminAuthService({ stateStore: makeStore() });
    await expect(service.logout("")).resolves.toBe(false);
  });
});
