import type { IncomingMessage } from "node:http";
import { getLogger } from "../logger.js";
import { getAuthContext } from "./authContext.js";

const log = getLogger("admin-audit");

/** Input accepted by the audit-store append method. */
export interface AuditAppendInput {
  actorUserId?: string | null;
  actorName: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Store surface needed for audit recording. The method is optional so mock
 * stores (older tests / embedders) that lack it degrade to a no-op.
 */
export interface AuditCapableStore {
  appendAuditEntry?(input: AuditAppendInput): Promise<unknown>;
}

/** Key names whose values must never appear in the audit trail. */
const SECRET_KEY_RE = /token|secret|password|key|credential/i;
/**
 * Keys that match {@link SECRET_KEY_RE} but are known-safe identifiers, not secrets:
 * `repoKey(s)` / `ticketProjectKey` are VE project identifiers, and anything ending in
 * `Path` (e.g. `sshKeyPath`) is a filesystem path, not the secret material itself.
 */
const SAFE_KEY_RE = /^(repoKeys?|ticketProjectKey)$|Path$/;
const MASK = "***";
const MAX_DEPTH = 8;

function maskValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((item) => maskValue(item, depth + 1, seen));
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(key) && !SAFE_KEY_RE.test(key) && item !== undefined && item !== null && item !== "") {
        out[key] = MASK;
      } else {
        out[key] = maskValue(item, depth + 1, seen);
      }
    }
    return out;
  }
  return value;
}

/**
 * Recursively replace values of secret-like keys (token / secret / password /
 * key / credential) with `"***"`. Known-safe identifier keys such as
 * `repoKey(s)`, `ticketProjectKey`, and any `*Path` field (e.g. `sshKeyPath`)
 * are preserved. Tracks visited objects/arrays with a `WeakSet` so cyclic
 * structures resolve to `"[Circular]"` instead of recursing forever or throwing.
 */
export function maskAuditDetails(details: Record<string, unknown>): Record<string, unknown> {
  return maskValue(details, 0, new WeakSet()) as Record<string, unknown>;
}

/**
 * Fire-and-forget audit append for admin mutations. Resolves the actor from
 * the request's auth context (fallback `"unknown"`), masks secret-like keys in
 * `details`, and never throws or blocks the response — an audit failure must
 * not fail the mutation. No-ops when the store lacks `appendAuditEntry`.
 */
export function recordAudit(
  store: AuditCapableStore | null | undefined,
  req: IncomingMessage,
  input: { action: string; targetType?: string; targetId?: string; details?: Record<string, unknown> }
): void {
  if (!store || typeof store.appendAuditEntry !== "function") return;
  const context = getAuthContext(req);
  try {
    void store
      .appendAuditEntry({
        actorUserId: context?.userId ?? null,
        actorName: context?.username ?? "unknown",
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        details: maskAuditDetails(input.details ?? {}),
      })
      .catch((err: unknown) => {
        log.error({ err, action: input.action }, "audit append failed");
      });
  } catch (err: unknown) {
    log.error({ err, action: input.action }, "audit append failed");
  }
}
