/**
 * Deny-event poller — consumes OpenShell policy-decision events, scrubs secrets,
 * and forwards normalized denial records to a sink (typically the DenialStore).
 *
 * Parsing is pure and defensive: OpenShell emits either structured decision
 * objects or a `{ error: "policy_denied", detail: "<METHOD> <path> ..." }`
 * shape. Both are supported; unrecognised/allow events yield `null`.
 */

import { getLogger } from "../logger.js";

const log = getLogger("openshell-deny-poller");

/** Normalized, secret-scrubbed denial ready for persistence. */
export interface NormalizedDenial {
  runtime: string;
  category: string;
  host: string;
  method: string;
  path: string;
  decision: string;
  reason: string;
}

/** Context attached to every denial parsed from a given sandbox/task. */
export interface DenialContext {
  taskId?: string | null;
  projectId?: string | null;
}

const SECRET_QUERY_KEYS = /([?&](?:token|access_token|api_key|apikey|key|secret|password|sig|signature)=)[^&#\s]+/gi;
const BEARER = /\b(bearer\s+)[A-Za-z0-9._-]+/gi;
const GH_PAT = /\b(gh[pousr]_)[A-Za-z0-9]{20,}/g;

/** Remove tokens/keys from a free-text string before it is persisted or shown. */
export function scrubSecrets(text: string): string {
  return text
    .replace(SECRET_QUERY_KEYS, "$1[REDACTED]")
    .replace(BEARER, "$1[REDACTED]")
    .replace(GH_PAT, "$1[REDACTED]");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Parse a single OpenShell event into a {@link NormalizedDenial}, or `null` when
 * the event is not a denial. Never throws.
 */
export function parseDenialEvent(raw: unknown, runtime = "openshell"): NormalizedDenial | null {
  const obj = asRecord(raw);
  if (!obj) return null;

  const decision = str(obj["decision"]).toLowerCase();
  const errorKind = str(obj["error"]).toLowerCase();
  const isDeny = decision === "deny" || decision === "denied" || errorKind === "policy_denied";
  if (!isDeny) return null;

  let method = str(obj["method"]).toUpperCase();
  let path = str(obj["path"]);
  const detail = str(obj["detail"]);
  // Fallback: parse "POST /repos/... not permitted by policy" from `detail`.
  if ((!method || !path) && detail) {
    const m = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT)\b\s+(\S+)/i.exec(detail);
    if (m) {
      method = method || (m[1] ?? "").toUpperCase();
      path = path || (m[2] ?? "");
    }
  }

  return {
    runtime,
    category: str(obj["category"]) || "network",
    host: str(obj["host"]),
    method,
    path: scrubSecrets(path),
    decision: "deny",
    reason: scrubSecrets(detail || str(obj["reason"]) || "denied by policy"),
  };
}

/** Sink that persists a normalized denial with its originating context. */
export type DenialSink = (denial: NormalizedDenial & DenialContext) => void | Promise<void>;

/** Async source of raw OpenShell events for one sandbox. */
export type DenialSource = AsyncIterable<unknown>;

/**
 * Consume a {@link DenialSource}, forwarding parsed denials to the sink. Resolves
 * when the source is exhausted; individual parse/sink errors are logged, not thrown.
 */
export async function pollDenials(
  source: DenialSource,
  sink: DenialSink,
  context: DenialContext = {},
  runtime = "openshell"
): Promise<number> {
  let count = 0;
  for await (const raw of source) {
    const denial = parseDenialEvent(raw, runtime);
    if (!denial) continue;
    try {
      await sink({ ...denial, ...context });
      count += 1;
    } catch (err) {
      log.warn({ err }, "failed to persist policy denial");
    }
  }
  return count;
}
