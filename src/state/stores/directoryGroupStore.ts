import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { authSourceGroupMappings, authSources, userIdentities, userIdentityGroups } from "../schema.js";
import * as schema from "../schema.js";

export interface AuthSourceGroupMapping {
  id: string;
  authSourceId: string;
  /** Normalized by the source kind (LDAP: lower-cased DN). */
  externalGroup: string;
  groupId: string;
  createdAt: Date;
}

export interface DirectoryGroupStoreApi {
  listGroupMappings(authSourceId: string): Promise<AuthSourceGroupMapping[]>;
  /** Throws `code = "DUPLICATE"` for an existing mapping, `NOT_FOUND` for an unknown source or group. */
  createGroupMapping(input: { authSourceId: string; externalGroup: string; groupId: string }): Promise<AuthSourceGroupMapping>;
  deleteGroupMapping(authSourceId: string, mappingId: string): Promise<boolean>;
  /** Replace an identity's directory groups in one transaction. */
  replaceIdentityGroups(identityId: string, externalGroups: readonly string[]): Promise<void>;
  listIdentityGroups(identityId: string): Promise<string[]>;
  /** VE group ids that the given directory groups of a source map into. */
  listMappedGroupIds(authSourceId: string, externalGroups: readonly string[]): Promise<string[]>;
  /** Users whose directory groups map into `groupId` through an enabled source. */
  listDirectoryMemberIds(groupId: string): Promise<string[]>;
}

interface DirectoryGroupStoreContext {
  db: BetterSQLite3Database<typeof schema>;
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function sqliteCode(err: unknown): unknown {
  return err instanceof Error && "code" in err ? (err as { code?: unknown }).code : undefined;
}

export function createDirectoryGroupStore(context: DirectoryGroupStoreContext): DirectoryGroupStoreApi {
  const { db } = context;

  function rowToMapping(row: typeof authSourceGroupMappings.$inferSelect): AuthSourceGroupMapping {
    return {
      id: row.id,
      authSourceId: row.authSourceId,
      externalGroup: row.externalGroup,
      groupId: row.groupId,
      createdAt: row.createdAt,
    };
  }

  return {
    async listGroupMappings(authSourceId): Promise<AuthSourceGroupMapping[]> {
      const rows = await db.query.authSourceGroupMappings.findMany({
        where: eq(authSourceGroupMappings.authSourceId, authSourceId),
        orderBy: [asc(authSourceGroupMappings.externalGroup)],
      });
      return rows.map(rowToMapping);
    },

    createGroupMapping(input): Promise<AuthSourceGroupMapping> {
      try {
        const row = db.insert(authSourceGroupMappings).values({
          id: randomUUID(),
          authSourceId: input.authSourceId,
          externalGroup: input.externalGroup,
          groupId: input.groupId,
          createdAt: new Date(),
        }).returning().get();
        return Promise.resolve(rowToMapping(row));
      } catch (err) {
        const code = sqliteCode(err);
        if (code === "SQLITE_CONSTRAINT_UNIQUE") {
          return Promise.reject(codedError("DUPLICATE", "This directory group is already mapped to the group"));
        }
        if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
          return Promise.reject(codedError("NOT_FOUND", "Authentication source or group not found"));
        }
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },

    async deleteGroupMapping(authSourceId, mappingId): Promise<boolean> {
      const result = await db.delete(authSourceGroupMappings).where(and(
        eq(authSourceGroupMappings.id, mappingId),
        eq(authSourceGroupMappings.authSourceId, authSourceId),
      ));
      return result.changes > 0;
    },

    replaceIdentityGroups(identityId, externalGroups): Promise<void> {
      const now = new Date();
      const unique = [...new Set(externalGroups)];
      db.transaction((tx) => {
        tx.delete(userIdentityGroups).where(eq(userIdentityGroups.identityId, identityId)).run();
        if (unique.length > 0) {
          tx.insert(userIdentityGroups)
            .values(unique.map((externalGroup) => ({ identityId, externalGroup, syncedAt: now })))
            .run();
        }
      }, { behavior: "immediate" });
      return Promise.resolve();
    },

    async listIdentityGroups(identityId): Promise<string[]> {
      const rows = await db.query.userIdentityGroups.findMany({
        where: eq(userIdentityGroups.identityId, identityId),
        orderBy: [asc(userIdentityGroups.externalGroup)],
      });
      return rows.map((row) => row.externalGroup);
    },

    async listMappedGroupIds(authSourceId, externalGroups): Promise<string[]> {
      if (externalGroups.length === 0) return [];
      const rows = await db.selectDistinct({ groupId: authSourceGroupMappings.groupId })
        .from(authSourceGroupMappings)
        .where(and(
          eq(authSourceGroupMappings.authSourceId, authSourceId),
          inArray(authSourceGroupMappings.externalGroup, [...externalGroups]),
        ));
      return rows.map((row) => row.groupId);
    },

    async listDirectoryMemberIds(groupId): Promise<string[]> {
      const rows = await db.selectDistinct({ userId: userIdentities.userId })
        .from(authSourceGroupMappings)
        .innerJoin(authSources, and(eq(authSources.id, authSourceGroupMappings.authSourceId), eq(authSources.enabled, 1)))
        .innerJoin(userIdentities, eq(userIdentities.authSourceId, authSourceGroupMappings.authSourceId))
        .innerJoin(userIdentityGroups, and(
          eq(userIdentityGroups.identityId, userIdentities.id),
          eq(userIdentityGroups.externalGroup, authSourceGroupMappings.externalGroup),
        ))
        .where(eq(authSourceGroupMappings.groupId, groupId));
      return rows.map((row) => row.userId);
    },
  };
}
