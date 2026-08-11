import { desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { policyDenialEvents } from "../schema.js";
import * as schema from "../schema.js";

/** A recorded runtime policy denial (deny-by-default egress / fs / process). */
export interface PolicyDenialEventRecord {
  id: number;
  taskId: string | null;
  projectId: string | null;
  runtime: string;
  category: string;
  host: string;
  method: string;
  path: string;
  decision: string;
  reason: string;
  createdAt: Date;
}

/** Input for recording a denial. Callers MUST scrub secrets before passing values. */
export interface RecordPolicyDenialInput {
  taskId?: string | null;
  projectId?: string | null;
  runtime?: string;
  category?: string;
  host?: string;
  method?: string;
  path?: string;
  decision?: string;
  reason?: string;
}

export interface DenialStoreApi {
  recordPolicyDenial(input: RecordPolicyDenialInput): Promise<PolicyDenialEventRecord>;
  listPolicyDenials(filter?: {
    taskId?: string;
    projectId?: string;
    limit?: number;
  }): Promise<PolicyDenialEventRecord[]>;
}

interface DenialStoreContext {
  db: BetterSQLite3Database<typeof schema>;
}

export function createDenialStore(context: DenialStoreContext): DenialStoreApi {
  const { db } = context;

  function rowToEvent(row: typeof policyDenialEvents.$inferSelect): PolicyDenialEventRecord {
    return {
      id: row.id,
      taskId: row.taskId ?? null,
      projectId: row.projectId ?? null,
      runtime: row.runtime,
      category: row.category,
      host: row.host,
      method: row.method,
      path: row.path,
      decision: row.decision,
      reason: row.reason,
      createdAt: row.createdAt,
    };
  }

  async function recordPolicyDenial(input: RecordPolicyDenialInput): Promise<PolicyDenialEventRecord> {
    const now = new Date();
    const inserted = await db
      .insert(policyDenialEvents)
      .values({
        taskId: input.taskId ?? null,
        projectId: input.projectId ?? null,
        runtime: input.runtime ?? "",
        category: input.category ?? "",
        host: input.host ?? "",
        method: input.method ?? "",
        path: input.path ?? "",
        decision: input.decision ?? "deny",
        reason: input.reason ?? "",
        createdAt: now,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to record policy denial event");
    return rowToEvent(row);
  }

  async function listPolicyDenials(filter?: {
    taskId?: string;
    projectId?: string;
    limit?: number;
  }): Promise<PolicyDenialEventRecord[]> {
    const limit = filter?.limit ?? 100;
    const where =
      filter?.taskId !== undefined
        ? eq(policyDenialEvents.taskId, filter.taskId)
        : filter?.projectId !== undefined
          ? eq(policyDenialEvents.projectId, filter.projectId)
          : undefined;
    const rows = await db.query.policyDenialEvents.findMany({
      ...(where ? { where } : {}),
      orderBy: [desc(policyDenialEvents.createdAt), desc(policyDenialEvents.id)],
      limit,
    });
    return rows.map(rowToEvent);
  }

  return { recordPolicyDenial, listPolicyDenials };
}
