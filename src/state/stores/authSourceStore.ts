import { randomUUID } from "crypto";
import { asc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { authSources, type AuthSourceKind } from "../schema.js";
import * as schema from "../schema.js";

function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

function duplicateError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "DUPLICATE" });
}

/** A persisted admin authentication source. `configJson` holds encrypted credentials. */
export interface AuthSourceRecord {
  id: string;
  name: string;
  kind: AuthSourceKind;
  enabled: boolean;
  priority: number;
  configJson: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthSourceStoreApi {
  /** Throws an Error with `code = "DUPLICATE"` when the name is taken. */
  createAuthSource(input: {
    id?: string;
    name: string;
    kind: AuthSourceKind;
    enabled?: boolean;
    priority?: number;
    configJson: string;
  }): Promise<AuthSourceRecord>;
  getAuthSourceById(id: string): Promise<AuthSourceRecord | null>;
  /** Ordered by ascending priority, then name. */
  listAuthSources(): Promise<AuthSourceRecord[]>;
  /** Throws an Error with `code = "DUPLICATE"` when renamed onto a taken name. */
  updateAuthSource(
    id: string,
    partial: { name?: string; enabled?: boolean; priority?: number; configJson?: string }
  ): Promise<AuthSourceRecord | null>;
  deleteAuthSource(id: string): Promise<boolean>;
}

interface AuthSourceStoreContext {
  db: BetterSQLite3Database<typeof schema>;
}

export function createAuthSourceStore(context: AuthSourceStoreContext): AuthSourceStoreApi {
  const { db } = context;

  function rowToRecord(row: typeof authSources.$inferSelect): AuthSourceRecord {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      enabled: row.enabled === 1,
      priority: row.priority,
      configJson: row.configJson,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function getAuthSourceById(id: string): Promise<AuthSourceRecord | null> {
    const row = await db.query.authSources.findFirst({ where: eq(authSources.id, id) });
    return row ? rowToRecord(row) : null;
  }

  async function createAuthSource(input: {
    id?: string;
    name: string;
    kind: AuthSourceKind;
    enabled?: boolean;
    priority?: number;
    configJson: string;
  }): Promise<AuthSourceRecord> {
    const now = new Date();
    const id = input.id ?? randomUUID();
    try {
      await db.insert(authSources).values({
        id,
        name: input.name,
        kind: input.kind,
        enabled: input.enabled === false ? 0 : 1,
        priority: input.priority ?? 100,
        configJson: input.configJson,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      if (isUniqueConstraintViolation(err)) throw duplicateError(`Authentication source already exists: "${input.name}"`);
      throw err;
    }
    const created = await getAuthSourceById(id);
    if (!created) throw new Error(`Failed to create authentication source ${id}`);
    return created;
  }

  async function listAuthSources(): Promise<AuthSourceRecord[]> {
    const rows = await db.query.authSources.findMany({
      orderBy: [asc(authSources.priority), asc(authSources.name)],
    });
    return rows.map(rowToRecord);
  }

  async function updateAuthSource(
    id: string,
    partial: { name?: string; enabled?: boolean; priority?: number; configJson?: string }
  ): Promise<AuthSourceRecord | null> {
    const set: Partial<typeof authSources.$inferInsert> = { updatedAt: new Date() };
    if (partial.name !== undefined) set.name = partial.name;
    if (partial.enabled !== undefined) set.enabled = partial.enabled ? 1 : 0;
    if (partial.priority !== undefined) set.priority = partial.priority;
    if (partial.configJson !== undefined) set.configJson = partial.configJson;
    try {
      await db.update(authSources).set(set).where(eq(authSources.id, id));
    } catch (err) {
      if (isUniqueConstraintViolation(err)) throw duplicateError(`Authentication source already exists: "${partial.name ?? ""}"`);
      throw err;
    }
    return getAuthSourceById(id);
  }

  async function deleteAuthSource(id: string): Promise<boolean> {
    const result = await db.delete(authSources).where(eq(authSources.id, id));
    return result.changes > 0;
  }

  return { createAuthSource, getAuthSourceById, listAuthSources, updateAuthSource, deleteAuthSource };
}
