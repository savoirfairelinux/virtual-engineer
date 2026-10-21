import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { ldapConfigSchema, serializeLdapConfig } from "../../src/admin/authentication/ldapConfig.js";
import { createDirectoryAuthenticator } from "../../src/admin/authentication/directoryAuthenticator.js";
import { createDirectorySessionGuard, REVALIDATION_RETRY_MS } from "../../src/admin/authentication/directorySessionGuard.js";
import type { SessionGuard } from "../../src/admin/authentication/sessionGuard.js";
import { hashPassword } from "../../src/admin/authentication/passwordHash.js";
import { lookupLdapAccount, MAX_LDAP_GROUPS } from "../../src/admin/authentication/ldapDirectory.js";
import { createAdminAuthService, hashSessionToken, SESSION_TTL_MS, type AdminAuthService } from "../../src/admin/adminAuthService.js";
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

  async function validatedAtOf(token: string): Promise<number> {
    return (await store.getSessionByTokenHash(hashSessionToken(token)))?.validatedAt?.getTime() ?? 0;
  }

  it("keeps the session when the directory renames the account mid-session", async () => {
    const token = await signIn();
    const renamed = await directory.renameEntry("uid=alice,ou=people,dc=ve,dc=test", "uid=alice.renamed");
    try {
      offsetMs = 16 * MINUTE;
      await expect(service.validateSession(token)).resolves.toMatchObject({ username: "alice" });
      expect(await validatedAtOf(token)).toBeGreaterThan(Date.now() + 15 * MINUTE);
    } finally {
      await directory.renameEntry(renamed, "uid=alice");
    }
  });

  it("backs off after a failed revalidation instead of contacting the directory on every request", async () => {
    const token = await signIn();
    await pointSourceAt(directory.ldapsUrl.replace(/:\d+$/, ":1"));
    offsetMs = 16 * MINUTE;
    await expect(service.validateSession(token)).resolves.toMatchObject({ username: "alice" });

    // The directory is reachable again and would now refuse the account, but the backoff is still running.
    await store.updateAuthSource(sourceId, {
      configJson: serializeLdapConfig(ldapConfigSchema.parse(directory.config({
        userSearchFilter: "(&(objectClass=inetOrgPerson)(uid={username})(employeeType=staff))",
      })), TEST_ADMIN_SECRET),
    });
    offsetMs = 16 * MINUTE + REVALIDATION_RETRY_MS - 1_000;
    await expect(service.validateSession(token)).resolves.toMatchObject({ username: "alice" });

    offsetMs = 16 * MINUTE + REVALIDATION_RETRY_MS + 1_000;
    await expect(service.validateSession(token)).resolves.toBeNull();
  });

  it("still ends the session at once when the source is disabled during a backoff", async () => {
    const token = await signIn();
    await pointSourceAt(directory.ldapsUrl.replace(/:\d+$/, ":1"));
    offsetMs = 16 * MINUTE;
    await expect(service.validateSession(token)).resolves.toMatchObject({ username: "alice" });

    await store.updateAuthSource(sourceId, { enabled: false });
    await expect(service.validateSession(token)).resolves.toBeNull();
  });

  it("keeps the session and retries later when a confirmed revalidation cannot be recorded", async () => {
    const token = await signIn();
    const signedInAt = await validatedAtOf(token);
    const raw = (store as unknown as { raw: { exec(sql: string): unknown } }).raw;
    raw.exec(`
      CREATE TRIGGER reject_revalidation BEFORE UPDATE OF validated_at ON user_sessions
      BEGIN SELECT RAISE(ABORT, 'session update rejected'); END
    `);

    offsetMs = 16 * MINUTE;
    await expect(service.validateSession(token)).resolves.toMatchObject({ username: "alice" });
    expect(await validatedAtOf(token)).toBe(signedInAt);

    raw.exec("DROP TRIGGER reject_revalidation");
    offsetMs = 16 * MINUTE + REVALIDATION_RETRY_MS + 1_000;
    await expect(service.validateSession(token)).resolves.toMatchObject({ username: "alice" });
    expect(await validatedAtOf(token)).toBeGreaterThan(signedInAt);
  });

  async function linkDirectoryUser(uid: string): Promise<void> {
    const lookup = await lookupLdapAccount(ldapConfigSchema.parse(directory.config()), uid);
    if (lookup.status !== "found") throw new Error(`${uid} missing from the test directory`);
    await store.createExternalUser({
      username: uid, role: "viewer", authSourceId: sourceId, externalSubject: lookup.account.subject, externalUsername: uid,
    });
  }

  it("pauses only the session whose own account cannot be checked, not the whole source", async () => {
    await directory.addUser("bulky", "bulky-Pass-1");
    await directory.addUser("gone", "gone-Pass-1");
    await linkDirectoryUser("bulky");
    await linkDirectoryUser("gone");
    const bulky = await signIn("bulky", "bulky-Pass-1");
    const gone = await signIn("gone", "gone-Pass-1");
    await directory.addGroups(Array.from({ length: MAX_LDAP_GROUPS + 1 }, (_, index) => `bulk-${index}`), ["bulky"]);
    await directory.deleteEntry("uid=gone,ou=people,dc=ve,dc=test");

    offsetMs = 16 * MINUTE;
    await expect(service.validateSession(bulky)).resolves.toMatchObject({ username: "bulky" });
    await expect(service.validateSession(gone)).resolves.toBeNull();
  }, 60_000);

  it("starts the backoff when a slow failure finishes, not when the request began", async () => {
    const sockets = new Set<Socket>();
    const silent = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", () => resolve()));
    const address = silent.address();
    const silentUrl = `ldaps://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    // A clock that only moves when the test says so, so the exchange's real duration is the only gap.
    const base = Date.now();
    const frozen = createAdminAuthService({
      stateStore: store,
      authenticator: createDirectoryAuthenticator({ store, adminAuthSecret: TEST_ADMIN_SECRET }),
      sessionGuard: createDirectorySessionGuard({ store, adminAuthSecret: TEST_ADMIN_SECRET }),
      now: () => new Date(base + offsetMs),
    });
    try {
      const login = await frozen.login("alice", "alice-Pass-1");
      if (login.status !== "ok") throw new Error(`login ${login.status}`);
      const token = login.session.token;
      await store.updateAuthSource(sourceId, {
        configJson: serializeLdapConfig(ldapConfigSchema.parse(directory.config({ url: silentUrl, timeoutMs: 1000 })), TEST_ADMIN_SECRET),
      });

      offsetMs = 16 * MINUTE;
      const started = performance.now();
      await expect(frozen.validateSession(token)).resolves.toMatchObject({ username: "alice" });
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThan(500);

      // Reachable again but refusing the account: any directory contact now revokes the session.
      await store.updateAuthSource(sourceId, {
        configJson: serializeLdapConfig(ldapConfigSchema.parse(directory.config({
          userSearchFilter: "(&(objectClass=inetOrgPerson)(uid={username})(employeeType=staff))",
        })), TEST_ADMIN_SECRET),
      });
      offsetMs = 16 * MINUTE + REVALIDATION_RETRY_MS;
      await expect(frozen.validateSession(token)).resolves.toMatchObject({ username: "alice" });
      offsetMs = 16 * MINUTE + REVALIDATION_RETRY_MS + Math.ceil(elapsed) + 1_000;
      await expect(frozen.validateSession(token)).resolves.toBeNull();
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  }, 30_000);

  /** A service whose guard runs `change` after the real directory check answers, before the request is authenticated. */
  function changedDuringCheck(change: () => Promise<unknown>): AdminAuthService {
    const guard = createDirectorySessionGuard({ store, adminAuthSecret: TEST_ADMIN_SECRET });
    const deferred: SessionGuard = {
      async check(session, now) {
        const verdict = await guard.check(session, now);
        await change();
        return verdict;
      },
    };
    return createAdminAuthService({
      stateStore: store,
      authenticator: createDirectoryAuthenticator({ store, adminAuthSecret: TEST_ADMIN_SECRET }),
      sessionGuard: deferred,
      now: () => new Date(Date.now() + offsetMs),
    });
  }

  it("refuses a session revoked while its directory check was pending", async () => {
    const token = await signIn();
    const disabling = changedDuringCheck(async () => {
      await store.updateAuthSource(sourceId, { enabled: false });
      await store.deleteSessionsForAuthSource(sourceId);
    });

    offsetMs = 16 * MINUTE;
    await expect(disabling.validateSession(token)).resolves.toBeNull();
  });

  it("reports the user's current role after a pending directory check", async () => {
    const token = await signIn();
    const userId = (await store.getUserByUsername("alice"))?.id ?? "";
    const promoting = changedDuringCheck(() => store.updateUser(userId, { role: "operator" }));

    offsetMs = 16 * MINUTE;
    await expect(promoting.validateSession(token)).resolves.toMatchObject({ username: "alice", role: "operator" });
  });

  it("issues no token when the source is disabled during a pending login, even once it is re-enabled", async () => {
    const directoryAuth = createDirectoryAuthenticator({ store, adminAuthSecret: TEST_ADMIN_SECRET });
    const disabling = createAdminAuthService({
      stateStore: store,
      authenticator: {
        async authenticate(username, password) {
          const outcome = await directoryAuth.authenticate(username, password);
          await store.updateAuthSource(sourceId, { enabled: false });
          await store.deleteSessionsForAuthSource(sourceId);
          return outcome;
        },
      },
      sessionGuard: createDirectorySessionGuard({ store, adminAuthSecret: TEST_ADMIN_SECRET }),
      now: () => new Date(Date.now() + offsetMs),
    });

    await expect(disabling.login("alice", "alice-Pass-1")).resolves.toEqual({ status: "rejected" });
    await store.updateAuthSource(sourceId, { enabled: true });
    expect(await store.purgeExpiredSessions(new Date(Date.now() + 2 * SESSION_TTL_MS))).toBe(0);
  });
});
