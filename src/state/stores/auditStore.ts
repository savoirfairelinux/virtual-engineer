import { and, desc, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AuditEntry } from "../../interfaces.js";
import { auditLog } from "../schema.js";
import * as schema from "../schema.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface AuditStoreApi {
  /** Append one audit-trail entry. `details` is JSON-serialised into `details_json`. */
  appendAuditEntry(input: {
    actorUserId?: string | null;
    actorName: string;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    details?: Record<string, unknown>;
  }): Promise<AuditEntry>;
  /** List entries newest-first (created_at DESC, id DESC). Default limit 50, capped at 200. */
  listAuditEntries(filter?: {
    limit?: number;
    offset?: number;
    action?: string;
    actorName?: string;
  }): Promise<{ entries: AuditEntry[]; total: number }>;
}

interface AuditStoreContext {
  db: BetterSQLite3Database<typeof schema>;
}

export function createAuditStore(context: AuditStoreContext): AuditStoreApi {
  const { db } = context;

  function parseDetails(json: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  function rowToEntry(row: typeof auditLog.$inferSelect): AuditEntry {
    return {
      id: row.id,
      actorUserId: row.actorUserId ?? null,
      actorName: row.actorName,
      action: row.action,
      targetType: row.targetType ?? null,
      targetId: row.targetId ?? null,
      details: parseDetails(row.detailsJson),
      createdAt: row.createdAt,
    };
  }

  async function appendAuditEntry(input: {
    actorUserId?: string | null;
    actorName: string;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    details?: Record<string, unknown>;
  }): Promise<AuditEntry> {
    const result = await db.insert(auditLog).values({
      actorUserId: input.actorUserId ?? null,
      actorName: input.actorName,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      detailsJson: JSON.stringify(input.details ?? {}),
      createdAt: new Date(),
    });
    const id = Number(result.lastInsertRowid);
    const row = await db.query.auditLog.findFirst({ where: eq(auditLog.id, id) });
    if (!row) throw new Error("Failed to append audit entry");
    return rowToEntry(row);
  }

  async function listAuditEntries(filter?: {
    limit?: number;
    offset?: number;
    action?: string;
    actorName?: string;
  }): Promise<{ entries: AuditEntry[]; total: number }> {
    const conditions = [];
    if (filter?.action !== undefined) conditions.push(eq(auditLog.action, filter.action));
    if (filter?.actorName !== undefined) conditions.push(eq(auditLog.actorName, filter.actorName));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const limit = Math.min(Math.max(filter?.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(filter?.offset ?? 0, 0);

    const rows = await db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(limit)
      .offset(offset);

    const totalRows = await db
      .select({ total: sql<number>`COUNT(*)` })
      .from(auditLog)
      .where(where);

    return {
      entries: rows.map((row) => rowToEntry(row)),
      total: Number(totalRows[0]?.total ?? 0),
    };
  }

  return {
    appendAuditEntry,
    listAuditEntries,
  };
}
