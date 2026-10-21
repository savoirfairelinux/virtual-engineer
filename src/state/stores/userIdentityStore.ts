import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AdminUser, UserRole } from "../../interfaces.js";
import { userIdentities, userSessions, users } from "../schema.js";
import * as schema from "../schema.js";

/** Stored in `users.password_hash` for directory-linked users; never a valid scrypt hash. */
export const EXTERNAL_PASSWORD_HASH = "!external";

export interface UserIdentityRecord {
  id: string;
  userId: string;
  authSourceId: string;
  externalSubject: string;
  externalUsername: string;
  createdAt: Date;
  lastLoginAt: Date | null;
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE";
}

/** Enabled admins without a directory link, counted inside the caller's transaction. */
export function countEnabledLocalAdminsIn(tx: Pick<BetterSQLite3Database<typeof schema>, "select">): number {
  const row = tx.select({ total: sql<number>`COUNT(*)` })
    .from(users)
    .leftJoin(userIdentities, eq(userIdentities.userId, users.id))
    .where(and(eq(users.role, "admin"), eq(users.enabled, 1), isNull(userIdentities.id)))
    .get();
  return row?.total ?? 0;
}

export interface UserIdentityStoreApi {
  getUserIdentityByUserId(userId: string): Promise<UserIdentityRecord | null>;
  getUserIdentityBySubject(authSourceId: string, externalSubject: string): Promise<UserIdentityRecord | null>;
  listUserIdentities(): Promise<UserIdentityRecord[]>;
  countUserIdentitiesForSource(authSourceId: string): Promise<number>;
  /** Enabled admins without a directory link — the break-glass accounts. */
  countEnabledLocalAdmins(): Promise<number>;
  /**
   * Atomically create a user that signs in through a directory account.
   * Throws `code = "DUPLICATE"` when the username or directory account is taken.
   */
  createExternalUser(input: {
    id?: string;
    username: string;
    role: UserRole;
    enabled?: boolean;
    authSourceId: string;
    externalSubject: string;
    externalUsername: string;
  }): Promise<{ user: AdminUser; identity: UserIdentityRecord }>;
  /**
   * Link an existing local user to a directory account, disable its local
   * password, and revoke its sessions in one transaction. Throws
   * `NOT_FOUND`, `ALREADY_LINKED`, `DUPLICATE` (account linked elsewhere), or
   * `LAST_LOCAL_ADMIN` (would leave no enabled local admin).
   */
  linkUserIdentity(input: {
    userId: string;
    authSourceId: string;
    externalSubject: string;
    externalUsername: string;
  }): Promise<UserIdentityRecord>;
  /** Remove the link, set a local password hash, and revoke sessions. False when not linked. */
  unlinkUserIdentity(userId: string, passwordHash: string): Promise<boolean>;
  recordIdentityLogin(identityId: string, update: { externalUsername: string; at: Date }): Promise<void>;
  /** Revoke every session of users linked to the source; returns the number removed. */
  deleteSessionsForAuthSource(authSourceId: string): Promise<number>;
}

interface UserIdentityStoreContext {
  db: BetterSQLite3Database<typeof schema>;
}

export function createUserIdentityStore(context: UserIdentityStoreContext): UserIdentityStoreApi {
  const { db } = context;

  function rowToIdentity(row: typeof userIdentities.$inferSelect): UserIdentityRecord {
    return {
      id: row.id,
      userId: row.userId,
      authSourceId: row.authSourceId,
      externalSubject: row.externalSubject,
      externalUsername: row.externalUsername,
      createdAt: row.createdAt,
      lastLoginAt: row.lastLoginAt ?? null,
    };
  }

  function rowToUser(row: typeof users.$inferSelect): AdminUser {
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.passwordHash,
      role: row.role,
      enabled: row.enabled === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function getUserIdentityByUserId(userId: string): Promise<UserIdentityRecord | null> {
    const row = await db.query.userIdentities.findFirst({ where: eq(userIdentities.userId, userId) });
    return row ? rowToIdentity(row) : null;
  }

  async function getUserIdentityBySubject(authSourceId: string, externalSubject: string): Promise<UserIdentityRecord | null> {
    const row = await db.query.userIdentities.findFirst({
      where: and(eq(userIdentities.authSourceId, authSourceId), eq(userIdentities.externalSubject, externalSubject)),
    });
    return row ? rowToIdentity(row) : null;
  }

  async function listUserIdentities(): Promise<UserIdentityRecord[]> {
    return (await db.query.userIdentities.findMany()).map(rowToIdentity);
  }

  function countUserIdentitiesForSource(authSourceId: string): Promise<number> {
    const row = db.select({ total: sql<number>`COUNT(*)` }).from(userIdentities)
      .where(eq(userIdentities.authSourceId, authSourceId)).get();
    return Promise.resolve(row?.total ?? 0);
  }

  function countEnabledLocalAdmins(): Promise<number> {
    return Promise.resolve(countEnabledLocalAdminsIn(db));
  }

  function createExternalUser(input: {
    id?: string;
    username: string;
    role: UserRole;
    enabled?: boolean;
    authSourceId: string;
    externalSubject: string;
    externalUsername: string;
  }): Promise<{ user: AdminUser; identity: UserIdentityRecord }> {
    const now = new Date();
    try {
      const created = db.transaction((tx) => {
        const user = tx.insert(users).values({
          id: input.id ?? randomUUID(),
          username: input.username,
          passwordHash: EXTERNAL_PASSWORD_HASH,
          role: input.role,
          enabled: input.enabled === false ? 0 : 1,
          createdAt: now,
          updatedAt: now,
        }).returning().get();
        const identity = tx.insert(userIdentities).values({
          id: randomUUID(),
          userId: user.id,
          authSourceId: input.authSourceId,
          externalSubject: input.externalSubject,
          externalUsername: input.externalUsername,
          createdAt: now,
        }).returning().get();
        return { user: rowToUser(user), identity: rowToIdentity(identity) };
      }, { behavior: "immediate" });
      return Promise.resolve(created);
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        return Promise.reject(codedError("DUPLICATE", "The username or directory account is already in use"));
      }
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  function linkUserIdentity(input: {
    userId: string;
    authSourceId: string;
    externalSubject: string;
    externalUsername: string;
  }): Promise<UserIdentityRecord> {
    try {
      const linked = db.transaction((tx) => {
        const user = tx.select().from(users).where(eq(users.id, input.userId)).get();
        if (!user) throw codedError("NOT_FOUND", "User not found");
        if (tx.select().from(userIdentities).where(eq(userIdentities.userId, input.userId)).get()) {
          throw codedError("ALREADY_LINKED", "User is already linked to a directory account");
        }
        if (user.role === "admin" && user.enabled === 1 && countEnabledLocalAdminsIn(tx) <= 1) {
          throw codedError("LAST_LOCAL_ADMIN", "Cannot link the last enabled local admin");
        }
        const now = new Date();
        const identity = tx.insert(userIdentities).values({
          id: randomUUID(),
          userId: input.userId,
          authSourceId: input.authSourceId,
          externalSubject: input.externalSubject,
          externalUsername: input.externalUsername,
          createdAt: now,
        }).returning().get();
        tx.update(users).set({ passwordHash: EXTERNAL_PASSWORD_HASH, updatedAt: now }).where(eq(users.id, input.userId)).run();
        tx.delete(userSessions).where(eq(userSessions.userId, input.userId)).run();
        return rowToIdentity(identity);
      }, { behavior: "immediate" });
      return Promise.resolve(linked);
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        return Promise.reject(codedError("DUPLICATE", "The directory account is already linked to another user"));
      }
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  function unlinkUserIdentity(userId: string, passwordHash: string): Promise<boolean> {
    const unlinked = db.transaction((tx) => {
      const removed = tx.delete(userIdentities).where(eq(userIdentities.userId, userId)).run().changes > 0;
      if (!removed) return false;
      tx.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, userId)).run();
      tx.delete(userSessions).where(eq(userSessions.userId, userId)).run();
      return true;
    }, { behavior: "immediate" });
    return Promise.resolve(unlinked);
  }

  async function recordIdentityLogin(identityId: string, update: { externalUsername: string; at: Date }): Promise<void> {
    await db.update(userIdentities)
      .set({ externalUsername: update.externalUsername, lastLoginAt: update.at })
      .where(eq(userIdentities.id, identityId));
  }

  async function deleteSessionsForAuthSource(authSourceId: string): Promise<number> {
    const linkedUsers = db.select({ userId: userIdentities.userId }).from(userIdentities)
      .where(eq(userIdentities.authSourceId, authSourceId));
    const result = await db.delete(userSessions).where(inArray(userSessions.userId, linkedUsers));
    return result.changes;
  }

  return {
    getUserIdentityByUserId,
    getUserIdentityBySubject,
    listUserIdentities,
    countUserIdentitiesForSource,
    countEnabledLocalAdmins,
    createExternalUser,
    linkUserIdentity,
    unlinkUserIdentity,
    recordIdentityLogin,
    deleteSessionsForAuthSource,
  };
}
