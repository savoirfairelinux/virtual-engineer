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

/**
 * Substrings (case-insensitive) that mark a key as secret-bearing. Matching is
 * intentionally a loose substring test rather than segment-exact: this is a
 * fail-safe security function where masking a benign field (e.g. `monkey`) is
 * harmless, but *failing* to mask a real secret is a leak. Substring matching
 * therefore also covers separator-less compounds like `apikey` / `accesstoken`
 * that a segment-exact test would miss. Mirrors `SECRET_KEY_PATTERNS` in
 * `adminAgentsRoutes.ts` so the two masking paths stay consistent.
 */
const SECRET_KEY_PATTERNS: readonly string[] = [
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "credential",
  "key",
];
/**
 * Keys that contain a secret pattern as a substring but are known-safe
 * identifiers, not secrets: `repoKey(s)` / `ticketProjectKey` are VE project
 * identifiers and `publicKey` is public by definition. Anything ending in
 * `Path` (e.g. `sshKeyPath`) is a filesystem path, not the secret material.
 */
const SAFE_KEYS: ReadonlySet<string> = new Set(["repoKey", "repoKeys", "ticketProjectKey", "publicKey"]);
const MASK = "***";
const MAX_DEPTH = 8;

/** Whether a key's value must be masked in the audit trail. */
function isSecretKey(key: string): boolean {
  if (SAFE_KEYS.has(key) || /Path$/.test(key)) return false;
  const lower = key.toLowerCase();
  return SECRET_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

function maskValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth >= MAX_DEPTH) {
    return (Array.isArray(value) || (value !== null && typeof value === "object")) ? "[MaxDepth]" : value;
  }
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
      if (isSecretKey(key) && item !== undefined && item !== null && item !== "") {
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
 * Delays (ms) between audit-append retry attempts. The first append is
 * immediate; a transient store failure is then retried after each delay. Kept
 * short so a struggling store doesn't queue unbounded work, but enough to ride
 * out a brief lock/contention blip.
 */
const AUDIT_RETRY_DELAYS_MS: readonly number[] = [100, 500, 2000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Don't let a pending retry delay keep the process/event loop alive.
    if (typeof timer.unref === "function") timer.unref();
  });
}

/**
 * Append an audit entry, retrying transient failures with backoff. Never
 * throws — after the final attempt fails it logs at error level (with the
 * attempt count) so the failure is visible for monitoring. Exported for tests.
 */
export async function appendAuditWithRetry(
  store: Required<Pick<AuditCapableStore, "appendAuditEntry">>,
  entry: AuditAppendInput,
  delays: readonly number[] = AUDIT_RETRY_DELAYS_MS
): Promise<void> {
  const totalAttempts = delays.length + 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    try {
      await store.appendAuditEntry(entry);
      return;
    } catch (err: unknown) {
      lastErr = err;
      // Sleep between attempts only — never after the final attempt.
      if (attempt < delays.length) await sleep(delays[attempt] ?? 0);
    }
  }
  log.error(
    { err: lastErr, action: entry.action, attempts: totalAttempts },
    "audit append failed after retries"
  );
}

/**
 * Fire-and-forget audit append for admin mutations. Resolves the actor from
 * the request's auth context (fallback `"unknown"`), masks secret-like keys in
 * `details`, and never throws or blocks the response — an audit failure must
 * not fail the mutation. Transient append failures are retried with backoff
 * (see {@link appendAuditWithRetry}). No-ops when the store lacks
 * `appendAuditEntry`.
 */
export function recordAudit(
  store: AuditCapableStore | null | undefined,
  req: IncomingMessage,
  input: { action: string; targetType?: string; targetId?: string; details?: Record<string, unknown> }
): void {
  if (!store || typeof store.appendAuditEntry !== "function") return;
  const context = getAuthContext(req);
  const appendable = store as Required<Pick<AuditCapableStore, "appendAuditEntry">>;
  try {
    void appendAuditWithRetry(appendable, {
      actorUserId: context?.userId ?? null,
      actorName: context?.username ?? "unknown",
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      details: maskAuditDetails(input.details ?? {}),
    });
  } catch (err: unknown) {
    log.error({ err, action: input.action }, "audit append failed");
  }
}
