import type { AuditEntry } from "../interfaces.js";
import type { AuditEntryFilter } from "../state/stores/auditStore.js";
import { writeJson, toIsoTimestamp, parseNonNegativeInt, requireStore } from "./adminRouteUtils.js";
import { maskAuditDetails } from "./adminAudit.js";
import type { Router } from "./router.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const EXPORT_PAGE_SIZE = 200;
const MAX_EXPORT_ENTRIES = 50_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** Store surface needed to read the audit trail (satisfied by SqliteStateStore). */
export interface AuditReadStore {
  listAuditEntries(filter?: AuditEntryFilter): Promise<{ entries: AuditEntry[]; total: number }>;
  listAuditDateRange(): Promise<{ from: Date | null; to: Date | null }>;
  listAuditActions(): Promise<string[]>;
  listAuditActors(): Promise<string[]>;
  listAuditIntegrations(): Promise<Array<{ id: string; name: string }>>;
  listAuditTargetTypes(): Promise<string[]>;
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

function nonEmptyParam(value: string | null): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : undefined;
}

function toCalendarDate(value: Date | null): string | null {
  return value?.toISOString().slice(0, 10) ?? null;
}

/** Parse an HTML date input as a UTC calendar boundary. `endExclusive` includes the selected end day. */
function parseCalendarDate(value: string, endExclusive: boolean): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return endExclusive ? new Date(date.getTime() + DAY_MS) : date;
}

interface ParsedAuditFilters {
  filter: Omit<AuditEntryFilter, "limit" | "offset">;
  error: string | null;
}

function parseAuditFilters(requestUrl: URL): ParsedAuditFilters {
  const action = nonEmptyParam(requestUrl.searchParams.get("action"));
  const actorName = nonEmptyParam(requestUrl.searchParams.get("actor"));
  const targetType = nonEmptyParam(requestUrl.searchParams.get("targetType"));
  const integrationId = nonEmptyParam(requestUrl.searchParams.get("integration"));
  const fromValue = nonEmptyParam(requestUrl.searchParams.get("from"));
  const toValue = nonEmptyParam(requestUrl.searchParams.get("to"));
  const parsedCreatedFrom = fromValue === undefined ? undefined : parseCalendarDate(fromValue, false);
  const parsedCreatedBefore = toValue === undefined ? undefined : parseCalendarDate(toValue, true);
  if (fromValue !== undefined && parsedCreatedFrom === null) {
    return { filter: {}, error: "from must be a valid calendar date (YYYY-MM-DD)" };
  }
  if (toValue !== undefined && parsedCreatedBefore === null) {
    return { filter: {}, error: "to must be a valid calendar date (YYYY-MM-DD)" };
  }
  const createdFrom = parsedCreatedFrom ?? undefined;
  const createdBefore = parsedCreatedBefore ?? undefined;
  if (createdFrom !== undefined && createdBefore !== undefined && createdFrom >= createdBefore) {
    return { filter: {}, error: "from must be before or equal to to" };
  }

  return {
    filter: {
      ...(action === undefined ? {} : { action }),
      ...(actorName === undefined ? {} : { actorName }),
      ...(targetType === undefined ? {} : { targetType }),
      ...(integrationId === undefined ? {} : { integrationId }),
      ...(createdFrom === undefined ? {} : { createdFrom }),
      ...(createdBefore === undefined ? {} : { createdBefore }),
    },
    error: null,
  };
}

function csvCell(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function auditCsv(entries: AuditEntry[]): string {
  const header = ["id", "createdAt", "actorUserId", "actorName", "action", "targetType", "targetId", "details"];
  const rows = entries.map((entry) => [
    String(entry.id),
    toIsoTimestamp(entry.createdAt),
    entry.actorUserId ?? "",
    entry.actorName,
    entry.action,
    entry.targetType ?? "",
    entry.targetId ?? "",
    JSON.stringify(maskAuditDetails(entry.details ?? {})),
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

async function loadExportEntries(
  store: AuditReadStore,
  filter: Omit<AuditEntryFilter, "limit" | "offset">,
): Promise<AuditEntry[] | null> {
  const firstPage = await store.listAuditEntries({ ...filter, limit: EXPORT_PAGE_SIZE, offset: 0 });
  if (firstPage.total > MAX_EXPORT_ENTRIES) return null;
  const entries = [...firstPage.entries];
  let offset = firstPage.entries.length;
  while (entries.length < firstPage.total) {
    const page = await store.listAuditEntries({ ...filter, limit: EXPORT_PAGE_SIZE, offset });
    if (page.entries.length === 0) break;
    entries.push(...page.entries);
    offset += page.entries.length;
  }
  return entries;
}

/** Register the audit-trail read route on the given router (admin only). */
export function registerAuditRoutes(router: Router, deps: AuditRouteDeps): void {
  router.add("GET", "/api/admin/audit/options", async (_req, res, _params) => {
    if (!requireStore(deps.auditStore, res, "Audit store not available")) return;
    const [actions, actors, integrations, targetTypes, dateRange] = await Promise.all([
      deps.auditStore.listAuditActions(),
      deps.auditStore.listAuditActors(),
      deps.auditStore.listAuditIntegrations(),
      deps.auditStore.listAuditTargetTypes(),
      deps.auditStore.listAuditDateRange(),
    ]);
    writeJson(res, 200, {
      actions,
      actors,
      integrations,
      targetTypes,
      dateRange: {
        from: toCalendarDate(dateRange.from),
        to: toCalendarDate(dateRange.to),
      },
    });
  }, { permission: "audit.read" });

  router.add("GET", "/api/admin/audit/export.csv", async (req, res, _params) => {
    if (!requireStore(deps.auditStore, res, "Audit store not available")) return;
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const parsed = parseAuditFilters(requestUrl);
    if (parsed.error !== null) {
      writeJson(res, 400, { error: parsed.error });
      return;
    }
    const entries = await loadExportEntries(deps.auditStore, parsed.filter);
    if (entries === null) {
      writeJson(res, 413, { error: `Export exceeds the ${MAX_EXPORT_ENTRIES} entry limit; narrow the filters` });
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", 'attachment; filename="audit-export.csv"');
    res.setHeader("cache-control", "no-store");
    res.end(auditCsv(entries));
  }, { permission: "audit.read" });

  router.add("GET", "/api/admin/audit", async (req, res, _params) => {
    if (!requireStore(deps.auditStore, res, "Audit store not available")) return;
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const parsed = parseAuditFilters(requestUrl);
    if (parsed.error !== null) {
      writeJson(res, 400, { error: parsed.error });
      return;
    }
    const limit = Math.min(parseNonNegativeInt(requestUrl.searchParams.get("limit")) ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = parseNonNegativeInt(requestUrl.searchParams.get("offset")) ?? 0;
    const [{ entries, total }, actions] = await Promise.all([
      deps.auditStore.listAuditEntries({
        ...parsed.filter,
        limit: Math.max(limit, 1),
        offset,
      }),
      deps.auditStore.listAuditActions(),
    ]);
    writeJson(res, 200, {
      entries: entries.map(serializeAuditEntry),
      actions,
      total,
      limit: Math.max(limit, 1),
      offset,
    });
  }, { permission: "audit.read" });
}
