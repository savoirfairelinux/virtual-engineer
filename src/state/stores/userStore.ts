import { and, eq, lte } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AdminUser, UserRole, UserSession } from "../../interfaces.js";
import { users, userSessions } from "../schema.js";
import * as schema from "../schema.js";

/**
 * True when `err` is a SQLite UNIQUE-constraint violation (better-sqlite3 sets
 * `code === "SQLITE_CONSTRAINT_UNIQUE"`).
 */
function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

/** Build an Error carrying `code = "DUPLICATE"` for route-layer 409 mapping. */
function duplicateError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "DUPLICATE" });
}

export interface UserStoreApi {
  /** Create a user. Throws an Error with `code = "DUPLICATE"` on duplicate username. */
  createUser(input: {
    id: string;
    username: string;
    passwordHash: string;
    role: UserRole;
    enabled?: boolean;
  }): Promise<AdminUser>;
  getUserById(id: string): Promise<AdminUser | null>;
  getUserByUsername(username: string): Promise<AdminUser | null>;
  /** All users ordered by username. Rows include passwordHash — strip it at the route layer. */
  listUsers(): Promise<AdminUser[]>;
  updateUser(id: string, partial: { role?: UserRole; enabled?: boolean }): Promise<AdminUser | null>;
  updateUserPassword(id: string, passwordHash: string): Promise<boolean>;
  /** Delete a user and all of their sessions. Returns false when the user does not exist. */
  deleteUser(id: string): Promise<boolean>;
  countUsers(): Promise<number>;
  countEnabledAdmins(): Promise<number>;
  createSession(input: { tokenHash: string; userId: string; expiresAt: Date }): Promise<UserSession>;
  /** Resolve a live session: null when unknown, expired, or the user is disabled/missing. */
  getSessionByTokenHash(tokenHash: string): Promise<(UserSession & { user: AdminUser }) | null>;
  /** Sliding-expiry update of an existing session. */
  touchSession(tokenHash: string, update: { lastSeenAt: Date; expiresAt: Date }): Promise<void>;
  deleteSessionByTokenHash(tokenHash: string): Promise<boolean>;
  /** Delete every session of a user; returns the number of sessions removed. */
  deleteSessionsForUser(userId: string): Promise<number>;
  /** Delete all sessions with `expires_at <= now`; returns the number removed. */
  purgeExpiredSessions(now: Date): Promise<number>;
}

interface UserStoreContext {
  db: BetterSQLite3Database<typeof schema>;
}

export function createUserStore(context: UserStoreContext): UserStoreApi {
  const { db } = context;

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

  function rowToSession(row: typeof userSessions.$inferSelect): UserSession {
    return {
      id: row.id,
      tokenHash: row.tokenHash,
      userId: row.userId,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      lastSeenAt: row.lastSeenAt,
    };
  }

  async function createUser(input: {
    id: string;
    username: string;
    passwordHash: string;
    role: UserRole;
    enabled?: boolean;
  }): Promise<AdminUser> {
    const now = new Date();
    try {
      await db.insert(users).values({
        id: input.id,
        username: input.username,
        passwordHash: input.passwordHash,
        role: input.role,
        enabled: input.enabled === false ? 0 : 1,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        throw duplicateError(`User already exists: "${input.username}"`);
      }
      throw err;
    }
    const created = await getUserById(input.id);
    if (!created) throw new Error(`Failed to create user ${input.id}`);
    return created;
  }

  async function getUserById(id: string): Promise<AdminUser | null> {
    const row = await db.query.users.findFirst({ where: eq(users.id, id) });
    return row ? rowToUser(row) : null;
  }

  async function getUserByUsername(username: string): Promise<AdminUser | null> {
    const row = await db.query.users.findFirst({ where: eq(users.username, username) });
    return row ? rowToUser(row) : null;
  }

  async function listUsers(): Promise<AdminUser[]> {
    const rows = await db.query.users.findMany({
      orderBy: (table, { asc }) => [asc(table.username)],
    });
    return rows.map((row) => rowToUser(row));
  }

  async function updateUser(
    id: string,
    partial: { role?: UserRole; enabled?: boolean }
  ): Promise<AdminUser | null> {
    const existing = await getUserById(id);
    if (!existing) return null;
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (partial.role !== undefined) update["role"] = partial.role;
    if (partial.enabled !== undefined) update["enabled"] = partial.enabled ? 1 : 0;
    await db.update(users).set(update).where(eq(users.id, id));
    return getUserById(id);
  }

  async function updateUserPassword(id: string, passwordHash: string): Promise<boolean> {
    const result = await db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, id));
    return result.changes > 0;
  }

  async function deleteUser(id: string): Promise<boolean> {
    await db.delete(userSessions).where(eq(userSessions.userId, id));
    const result = await db.delete(users).where(eq(users.id, id));
    return result.changes > 0;
  }

  async function countUsers(): Promise<number> {
    const rows = await db.query.users.findMany({ columns: { id: true } });
    return rows.length;
  }

  async function countEnabledAdmins(): Promise<number> {
    const rows = await db.query.users.findMany({
      columns: { id: true },
      where: and(eq(users.role, "admin"), eq(users.enabled, 1)),
    });
    return rows.length;
  }

  async function createSession(input: {
    tokenHash: string;
    userId: string;
    expiresAt: Date;
  }): Promise<UserSession> {
    const now = new Date();
    await db.insert(userSessions).values({
      tokenHash: input.tokenHash,
      userId: input.userId,
      createdAt: now,
      expiresAt: input.expiresAt,
      lastSeenAt: now,
    });
    const row = await db.query.userSessions.findFirst({
      where: eq(userSessions.tokenHash, input.tokenHash),
    });
    if (!row) throw new Error("Failed to create session");
    return rowToSession(row);
  }

  async function getSessionByTokenHash(
    tokenHash: string
  ): Promise<(UserSession & { user: AdminUser }) | null> {
    const row = await db.query.userSessions.findFirst({
      where: eq(userSessions.tokenHash, tokenHash),
    });
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    const user = await getUserById(row.userId);
    if (!user || !user.enabled) return null;
    return { ...rowToSession(row), user };
  }

  async function touchSession(
    tokenHash: string,
    update: { lastSeenAt: Date; expiresAt: Date }
  ): Promise<void> {
    await db
      .update(userSessions)
      .set({ lastSeenAt: update.lastSeenAt, expiresAt: update.expiresAt })
      .where(eq(userSessions.tokenHash, tokenHash));
  }

  async function deleteSessionByTokenHash(tokenHash: string): Promise<boolean> {
    const result = await db.delete(userSessions).where(eq(userSessions.tokenHash, tokenHash));
    return result.changes > 0;
  }

  async function deleteSessionsForUser(userId: string): Promise<number> {
    const result = await db.delete(userSessions).where(eq(userSessions.userId, userId));
    return result.changes;
  }

  async function purgeExpiredSessions(now: Date): Promise<number> {
    const result = await db.delete(userSessions).where(lte(userSessions.expiresAt, now));
    return result.changes;
  }

  return {
    createUser,
    getUserById,
    getUserByUsername,
    listUsers,
    updateUser,
    updateUserPassword,
    deleteUser,
    countUsers,
    countEnabledAdmins,
    createSession,
    getSessionByTokenHash,
    touchSession,
    deleteSessionByTokenHash,
    deleteSessionsForUser,
    purgeExpiredSessions,
  };
}
