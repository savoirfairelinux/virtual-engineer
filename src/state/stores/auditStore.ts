import { and, asc, desc, eq, gte, lt, or, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AuditEntry } from "../../interfaces.js";
import { auditLog } from "../schema.js";
import * as schema from "../schema.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface AuditEntryFilter {
  limit?: number;
  offset?: number;
  action?: string;
  actorName?: string;
  targetType?: string;
  integrationId?: string;
  createdFrom?: Date;
  createdBefore?: Date;
}

export interface AuditIntegrationOption {
  id: string;
  name: string;
}

export interface AuditDateRange {
  from: Date | null;
  to: Date | null;
}

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
  listAuditEntries(filter?: AuditEntryFilter): Promise<{ entries: AuditEntry[]; total: number }>;
  /** Return the oldest and newest timestamps in the audit trail. */
  listAuditDateRange(): Promise<AuditDateRange>;
  /** List the distinct action names present in the audit trail, sorted alphabetically. */
  listAuditActions(): Promise<string[]>;
  /** List the distinct actor names present in the audit trail, sorted alphabetically. */
  listAuditActors(): Promise<string[]>;
  /** List integrations referenced by audit entries, sorted by display name. */
  listAuditIntegrations(): Promise<AuditIntegrationOption[]>;
  /** List the distinct non-null target types present in the audit trail. */
  listAuditTargetTypes(): Promise<string[]>;
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

  async function listAuditEntries(filter?: AuditEntryFilter): Promise<{ entries: AuditEntry[]; total: number }> {
    const conditions = [];
    if (filter?.action !== undefined) conditions.push(eq(auditLog.action, filter.action));
    if (filter?.actorName !== undefined) conditions.push(eq(auditLog.actorName, filter.actorName));
    if (filter?.targetType !== undefined) conditions.push(eq(auditLog.targetType, filter.targetType));
    if (filter?.integrationId !== undefined) {
      const integrationCondition = or(
        eq(auditLog.targetId, filter.integrationId),
        sql`json_extract(${auditLog.detailsJson}, '$.integrationId') = ${filter.integrationId}`,
      );
      if (integrationCondition) conditions.push(integrationCondition);
    }
    if (filter?.createdFrom !== undefined) conditions.push(gte(auditLog.createdAt, filter.createdFrom));
    if (filter?.createdBefore !== undefined) conditions.push(lt(auditLog.createdAt, filter.createdBefore));
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

  async function listAuditDateRange(): Promise<AuditDateRange> {
    const [oldest] = await db
      .select({ createdAt: auditLog.createdAt })
      .from(auditLog)
      .orderBy(asc(auditLog.createdAt), asc(auditLog.id))
      .limit(1);
    const [newest] = await db
      .select({ createdAt: auditLog.createdAt })
      .from(auditLog)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(1);
    return {
      from: oldest?.createdAt ?? null,
      to: newest?.createdAt ?? null,
    };
  }

  async function listAuditActions(): Promise<string[]> {
    const rows = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .groupBy(auditLog.action)
      .orderBy(asc(auditLog.action));
    return rows.map((row) => row.action);
  }

  async function listAuditActors(): Promise<string[]> {
    const rows = await db
      .select({ actorName: auditLog.actorName })
      .from(auditLog)
      .groupBy(auditLog.actorName)
      .orderBy(asc(auditLog.actorName));
    return rows.map((row) => row.actorName);
  }

  async function listAuditIntegrations(): Promise<AuditIntegrationOption[]> {
    const rows = await db
      .select({ targetId: auditLog.targetId, detailsJson: auditLog.detailsJson })
      .from(auditLog)
      .where(and(eq(auditLog.targetType, "integration"), sql`${auditLog.targetId} IS NOT NULL`))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id));
    const byId = new Map<string, AuditIntegrationOption>();
    for (const row of rows) {
      if (row.targetId === null || byId.has(row.targetId)) continue;
      const details = parseDetails(row.detailsJson);
      const name = typeof details["name"] === "string" && details["name"].trim()
        ? details["name"]
        : row.targetId;
      byId.set(row.targetId, { id: row.targetId, name });
    }
    return [...byId.values()].sort((left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  async function listAuditTargetTypes(): Promise<string[]> {
    const rows = await db
      .select({ targetType: auditLog.targetType })
      .from(auditLog)
      .where(sql`${auditLog.targetType} IS NOT NULL`)
      .groupBy(auditLog.targetType)
      .orderBy(asc(auditLog.targetType));
    return rows.flatMap((row) => row.targetType === null ? [] : [row.targetType]);
  }

  return {
    appendAuditEntry,
    listAuditEntries,
    listAuditDateRange,
    listAuditActions,
    listAuditActors,
    listAuditIntegrations,
    listAuditTargetTypes,
  };
}
