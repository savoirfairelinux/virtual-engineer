import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import type Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { IdentityId, IdentityRecord } from "../../interfaces.js";
import { identities } from "../schema.js";
import * as schema from "../schema.js";

export interface IdentityStoreApi {
  createIdentity(input: {
    id?: string;
    name: string;
    email?: string;
    username?: string;
    signature?: string;
  }): Promise<IdentityRecord>;
  getIdentityById(id: IdentityId): Promise<IdentityRecord | null>;
  listIdentities(): Promise<IdentityRecord[]>;
  updateIdentity(
    id: IdentityId,
    partial: Partial<Pick<IdentityRecord, "name" | "email" | "username" | "signature">>
  ): Promise<IdentityRecord>;
  deleteIdentity(id: IdentityId): Promise<void>;
}

interface IdentityStoreContext {
  db: BetterSQLite3Database<typeof schema>;
  raw: Database.Database;
}

export function createIdentityStore(context: IdentityStoreContext): IdentityStoreApi {
  const { db, raw } = context;

  function rowToIdentity(row: typeof identities.$inferSelect): IdentityRecord {
    return {
      id: row.id as IdentityId,
      name: row.name,
      email: row.email,
      username: row.username,
      signature: row.signature,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function getIdentityById(id: IdentityId): Promise<IdentityRecord | null> {
    const row = await db.query.identities.findFirst({ where: eq(identities.id, id) });
    return row ? rowToIdentity(row) : null;
  }

  async function createIdentity(input: {
    id?: string;
    name: string;
    email?: string;
    username?: string;
    signature?: string;
  }): Promise<IdentityRecord> {
    const now = new Date();
    const id = input.id ?? randomUUID();
    await db.insert(identities).values({
      id,
      name: input.name,
      email: input.email ?? "",
      username: input.username ?? "",
      signature: input.signature ?? "",
      createdAt: now,
      updatedAt: now,
    });
    const created = await getIdentityById(id as IdentityId);
    if (!created) throw new Error(`Failed to create identity ${id}`);
    return created;
  }

  async function listIdentities(): Promise<IdentityRecord[]> {
    const rows = await db.query.identities.findMany({
      orderBy: (table, { asc }) => [asc(table.name)],
    });
    return rows.map((row) => rowToIdentity(row));
  }

  async function updateIdentity(
    id: IdentityId,
    partial: Partial<Pick<IdentityRecord, "name" | "email" | "username" | "signature">>
  ): Promise<IdentityRecord> {
    const existing = await getIdentityById(id);
    if (!existing) throw new Error(`Identity not found: ${id}`);
    const now = new Date();
    const update: Record<string, unknown> = { updatedAt: now };
    if (partial.name !== undefined) update["name"] = partial.name;
    if (partial.email !== undefined) update["email"] = partial.email;
    if (partial.username !== undefined) update["username"] = partial.username;
    if (partial.signature !== undefined) update["signature"] = partial.signature;
    await db.update(identities).set(update).where(eq(identities.id, id));
    const updated = await getIdentityById(id);
    if (!updated) throw new Error(`Identity disappeared after update: ${id}`);
    return updated;
  }

  async function deleteIdentity(id: IdentityId): Promise<void> {
    // Detach the identity from any workflow that references it, then delete it.
    raw.transaction(() => {
      raw.prepare(`UPDATE projects SET identity_id = NULL WHERE identity_id = ?`).run(id);
      raw.prepare(`DELETE FROM identities WHERE id = ?`).run(id);
    })();
  }

  return {
    createIdentity,
    getIdentityById,
    listIdentities,
    updateIdentity,
    deleteIdentity,
  };
}
