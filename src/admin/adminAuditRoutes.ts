import type { AuditEntry } from "../interfaces.js";
import { writeJson, toIsoTimestamp, parseNonNegativeInt } from "./adminRouteUtils.js";
import { maskAuditDetails } from "./adminAudit.js";
import type { Router } from "./router.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Store surface needed to read the audit trail (satisfied by SqliteStateStore). */
export interface AuditReadStore {
  listAuditEntries(filter?: {
    limit?: number;
    offset?: number;
    action?: string;
    actorName?: string;
  }): Promise<{ entries: AuditEntry[]; total: number }>;
}

export interface AuditRouteDeps {
  auditStore?: AuditReadStore | undefined;
}

// ⚠️ SECURITY: Defense-in-depth — re-mask on read even though entries are already
// masked at write time, so a future write path that forgets to mask can't leak secrets.
function serializeAuditEntry(entry: AuditEntry): Record<string, unknown> {
  return {
    id: entry.id,
    actorUserId: entry.actorUserId,
    actorName: entry.actorName,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    details: maskAuditDetails(entry.details ?? {}),
    createdAt: toIsoTimestamp(entry.createdAt),
  };
}

/** Register the audit-trail read route on the given router (admin only). */
export function registerAuditRoutes(router: Router, deps: AuditRouteDeps): void {
  router.add("GET", "/api/admin/audit", async (req, res, _params) => {
    if (!deps.auditStore) { writeJson(res, 501, { error: "Audit store not available" }); return; }
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const limit = Math.min(parseNonNegativeInt(requestUrl.searchParams.get("limit")) ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = parseNonNegativeInt(requestUrl.searchParams.get("offset")) ?? 0;
    const action = requestUrl.searchParams.get("action") ?? undefined;
    const actorName = requestUrl.searchParams.get("actor") ?? undefined;
    const { entries, total } = await deps.auditStore.listAuditEntries({
      limit: Math.max(limit, 1),
      offset,
      ...(action !== undefined ? { action } : {}),
      ...(actorName !== undefined ? { actorName } : {}),
    });
    writeJson(res, 200, {
      entries: entries.map(serializeAuditEntry),
      total,
      limit: Math.max(limit, 1),
      offset,
    });
  }, { role: "admin" });
}
