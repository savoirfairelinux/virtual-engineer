/**
 * Runtime profile — identifies which execution backend runs an agent cycle.
 *
 * The runtime is selected per task from a three-tier fallback chain
 * (project → agent → global default). Keeping this as a small, pure module lets
 * the orchestrator, admin API, and DB layer share one canonical set of ids and
 * one resolution rule.
 */

/** All runtime backends VE knows how to drive. */
export const RUNTIME_IDS = ["docker", "openshell"] as const;

/** A supported agent-execution runtime backend id. */
export type RuntimeId = (typeof RUNTIME_IDS)[number];

/** The built-in default runtime used when nothing else is configured. */
export const DEFAULT_RUNTIME_ID: RuntimeId = "docker";

/** Type guard: is `value` one of the known {@link RuntimeId}s? */
export function isRuntimeId(value: unknown): value is RuntimeId {
  return typeof value === "string" && (RUNTIME_IDS as readonly string[]).includes(value);
}

/**
 * Coerce a stored/config string to a {@link RuntimeId}. Returns `undefined` for
 * empty, null, or unrecognised values so callers can fall back to the next tier.
 */
export function normalizeRuntimeId(value: string | null | undefined): RuntimeId | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return isRuntimeId(trimmed) ? trimmed : undefined;
}

/**
 * A runtime selection expressed as an ordered fallback chain. Each tier is
 * optional; the first defined tier wins.
 */
export interface RuntimeSelection {
  /** Per-project override (`projects.runtime`). Highest precedence. */
  project?: RuntimeId | null | undefined;
  /** Per-agent override (`agents.runtime`). */
  agent?: RuntimeId | null | undefined;
  /** Global default (`app_settings.default_runtime`). */
  default?: RuntimeId | null | undefined;
}

/**
 * Resolve a {@link RuntimeSelection} to a concrete {@link RuntimeId} using the
 * precedence `project → agent → default → {@link DEFAULT_RUNTIME_ID}`.
 */
export function resolveRuntimeId(selection: RuntimeSelection): RuntimeId {
  return (
    normalizeRuntimeId(selection.project) ??
    normalizeRuntimeId(selection.agent) ??
    normalizeRuntimeId(selection.default) ??
    DEFAULT_RUNTIME_ID
  );
}
