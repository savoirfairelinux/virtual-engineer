import { randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { Group } from "../../interfaces.js";
import { groupMembers, groups, policyBindings } from "../schema.js";
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

export interface GroupStoreApi {
  /** Create a group. Throws an Error with `code = "DUPLICATE"` on duplicate name. */
  createGroup(input: { id?: string; name: string; description?: string }): Promise<Group>;
  getGroupById(id: string): Promise<Group | null>;
  listGroups(): Promise<Group[]>;
  updateGroup(id: string, partial: { name?: string; description?: string }): Promise<Group | null>;
  deleteGroup(id: string): Promise<boolean>;
  /** Idempotent: adding an existing member is a no-op. */
  addUserToGroup(groupId: string, userId: string): Promise<void>;
  removeUserFromGroup(groupId: string, userId: string): Promise<boolean>;
  /** User ids belonging to a group. */
  listGroupMemberIds(groupId: string): Promise<string[]>;
  /** Groups a user belongs to, ordered by name. */
  listGroupsForUser(userId: string): Promise<Group[]>;
}

interface GroupStoreContext {
  db: BetterSQLite3Database<typeof schema>;
}

export function createGroupStore(context: GroupStoreContext): GroupStoreApi {
  const { db } = context;

  function rowToGroup(row: typeof groups.$inferSelect): Group {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  return {
    async createGroup(input): Promise<Group> {
      const now = new Date();
      const row = {
        id: input.id ?? randomUUID(),
        name: input.name,
        description: input.description ?? "",
        createdAt: now,
        updatedAt: now,
      };
      try {
        await db.insert(groups).values(row);
      } catch (err) {
        if (isUniqueConstraintViolation(err)) {
          throw duplicateError(`Group name already exists: ${input.name}`);
        }
        throw err;
      }
      return rowToGroup(row);
    },

    async getGroupById(id): Promise<Group | null> {
      const row = await db.query.groups.findFirst({ where: eq(groups.id, id) });
      return row ? rowToGroup(row) : null;
    },

    async listGroups(): Promise<Group[]> {
      const rows = await db.query.groups.findMany({ orderBy: groups.name });
      return rows.map(rowToGroup);
    },

    async updateGroup(id, partial): Promise<Group | null> {
      const existing = await db.query.groups.findFirst({ where: eq(groups.id, id) });
      if (!existing) return null;
      const next = {
        name: partial.name ?? existing.name,
        description: partial.description ?? existing.description,
        updatedAt: new Date(),
      };
      try {
        await db.update(groups).set(next).where(eq(groups.id, id));
      } catch (err) {
        if (isUniqueConstraintViolation(err)) {
          throw duplicateError(`Group name already exists: ${partial.name ?? existing.name}`);
        }
        throw err;
      }
      return rowToGroup({ ...existing, ...next });
    },

    async deleteGroup(id): Promise<boolean> {
      // Remove any policy bindings targeting this group (principal_id has no FK),
      // then the group row (group_members cascade). Atomic so no orphans remain.
      let changes = 0;
      db.transaction((tx) => {
        tx.delete(policyBindings)
          .where(and(eq(policyBindings.principalType, "group"), eq(policyBindings.principalId, id)))
          .run();
        changes = tx.delete(groups).where(eq(groups.id, id)).run().changes;
      });
      return changes > 0;
    },

    async addUserToGroup(groupId, userId): Promise<void> {
      await db
        .insert(groupMembers)
        .values({ groupId, userId, createdAt: new Date() })
        .onConflictDoNothing();
    },

    async removeUserFromGroup(groupId, userId): Promise<boolean> {
      const result = await db
        .delete(groupMembers)
        .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));
      return result.changes > 0;
    },

    async listGroupMemberIds(groupId): Promise<string[]> {
      const rows = await db.query.groupMembers.findMany({ where: eq(groupMembers.groupId, groupId) });
      return rows.map((r) => r.userId);
    },

    async listGroupsForUser(userId): Promise<Group[]> {
      const rows = await db
        .select({
          id: groups.id,
          name: groups.name,
          description: groups.description,
          createdAt: groups.createdAt,
          updatedAt: groups.updatedAt,
        })
        .from(groupMembers)
        .innerJoin(groups, eq(groupMembers.groupId, groups.id))
        .where(eq(groupMembers.userId, userId))
        .orderBy(sql`${groups.name}`);
      return rows.map(rowToGroup);
    },
  };
}
