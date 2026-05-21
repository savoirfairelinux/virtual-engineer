/**
 * Multi-level concurrency tracker.
 *
 * In-memory, single-process counters that gate task starts at three levels:
 *   1. Global (from `app_concurrency.maxConcurrent`, NULL = unlimited)
 *   2. Per-project (from `projects.maxConcurrent`, default 1, floor = 1)
 *   3. Per-agent (from `agents.maxConcurrent`, default 1, floor = 1)
 *
 * Single-process model: this lives entirely in the orchestrator process.
 * No cross-process / distributed coordination. After a process restart all
 * counters reset to 0; in-flight tasks resume their cycles via state recovery,
 * and `runWorkflow` re-acquires their slot lazily.
 *
 * Limits are read from project / agent / global records on every call (with a
 * tiny TTL cache to avoid hammering SQLite). Edits via the admin UI take
 * effect within the cache TTL.
 */
import type { AgentId, AgentRecord, ProjectId, ProjectRecord } from "../interfaces.js";
import { getLogger } from "../logger.js";

const log = getLogger("concurrency-tracker");

/** TTL for the per-deps limit cache, in milliseconds. */
const DEFAULT_CACHE_TTL_MS = 5_000;

export interface ConcurrencyLimits {
  /** Global concurrent-task ceiling. `null` = unlimited. */
  global: number | null;
  /** Per-project ceiling. Always `>= 1`. */
  perProject: number;
  /** Per-agent ceiling. Always `>= 1`. */
  perAgent: number;
}

export interface ConcurrencySnapshot {
  global: number;
  perProject: Record<string, number>;
  perAgent: Record<string, number>;
}

export interface ConcurrencyTracker {
  /**
   * Returns true if a new task can start (all three limits would still be
   * respected). Does NOT mutate counters — call {@link acquire} to actually
   * claim a slot.
   */
  canStart(projectId: ProjectId, agentId: AgentId): Promise<boolean>;

  /**
   * Reserve a slot. Returns false if the call would breach any limit; in that
   * case no counters are mutated. Atomic in the single-threaded Node sense:
   * the caller must not `await` between {@link canStart} and {@link acquire}
   * if it relies on the prior decision.
   */
  acquire(projectId: ProjectId, agentId: AgentId): Promise<boolean>;

  /**
   * Release a slot when a task reaches a terminal state. Idempotent: releasing
   * a never-acquired or already-released slot is a no-op (counters never go
   * negative).
   */
  release(projectId: ProjectId, agentId: AgentId): void;

  /** Diagnostic snapshot of the live counters. */
  snapshot(): ConcurrencySnapshot;
}

export interface ConcurrencyTrackerDeps {
  projectStore: { getProjectById(id: ProjectId): Promise<ProjectRecord | null> };
  agentStore: { getAgentById(id: AgentId): Promise<AgentRecord | null> };
  /** Wraps `stateStore.getGlobalConcurrencyLimit()`. Return null for unlimited. */
  globalLimitProvider: () => Promise<number | null>;
  /** Override the cache TTL (ms). Defaults to 5000. Tests use this with fake timers. */
  cacheTtlMs?: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Tiny per-key TTL cache used to debounce SQLite reads of the project / agent
 * / global limits. Keyed by id (or "global"). Single-flight is unnecessary
 * here because the loader functions are cheap and idempotent.
 */
function cachedLimitsLookup<K extends string, V>(
  loader: (key: K) => Promise<V>,
  ttlMs: number
): (key: K) => Promise<V> {
  const cache = new Map<K, CacheEntry<V>>();
  return async (key: K): Promise<V> => {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) {
      return hit.value;
    }
    const value = await loader(key);
    cache.set(key, { value, expiresAt: now + ttlMs });
    return value;
  };
}

/** Coerce a stored maxConcurrent to a positive integer (floor = 1). */
function normalizePerEntityLimit(raw: number | null | undefined): number {
  if (raw === null || raw === undefined) return 1;
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.floor(raw);
}

/** Create a ConcurrencyTracker backed by in-memory counters and TTL-cached limit lookups. */
export function createConcurrencyTracker(deps: ConcurrencyTrackerDeps): ConcurrencyTracker {
  const ttl = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const projectLookup = cachedLimitsLookup<ProjectId, ProjectRecord | null>(
    (id) => deps.projectStore.getProjectById(id),
    ttl
  );
  const agentLookup = cachedLimitsLookup<AgentId, AgentRecord | null>(
    (id) => deps.agentStore.getAgentById(id),
    ttl
  );
  const globalLookup = cachedLimitsLookup<"global", number | null>(
    async () => deps.globalLimitProvider(),
    ttl
  );

  const perProject = new Map<string, number>();
  const perAgent = new Map<string, number>();
  let activeGlobal = 0;

  /** Fetch the current concurrency limits for a (project, agent) pair, using the TTL cache. */
  async function loadLimits(projectId: ProjectId, agentId: AgentId): Promise<ConcurrencyLimits> {
    const [project, agent, global] = await Promise.all([
      projectLookup(projectId),
      agentLookup(agentId),
      globalLookup("global"),
    ]);
    return {
      global,
      perProject: normalizePerEntityLimit(project?.maxConcurrent),
      perAgent: normalizePerEntityLimit(agent?.maxConcurrent),
    };
  }

  /** Return true when all three counters (global, per-project, per-agent) are below their limits. */
  function check(limits: ConcurrencyLimits, projectId: ProjectId, agentId: AgentId): boolean {
    if (limits.global !== null && activeGlobal >= limits.global) return false;
    if ((perProject.get(projectId) ?? 0) >= limits.perProject) return false;
    if ((perAgent.get(agentId) ?? 0) >= limits.perAgent) return false;
    return true;
  }

  return {
    /** Check whether a new task can start without mutating counters. */
    async canStart(projectId, agentId): Promise<boolean> {
      const limits = await loadLimits(projectId, agentId);
      return check(limits, projectId, agentId);
    },

    /** Atomically claim a slot if limits allow, incrementing all three counters. */
    async acquire(projectId, agentId): Promise<boolean> {
      const limits = await loadLimits(projectId, agentId);
      if (!check(limits, projectId, agentId)) {
        return false;
      }
      activeGlobal += 1;
      perProject.set(projectId, (perProject.get(projectId) ?? 0) + 1);
      perAgent.set(agentId, (perAgent.get(agentId) ?? 0) + 1);
      log.debug({ projectId, agentId, activeGlobal, limits }, "acquired concurrency slot");
      return true;
    },

    /** Decrement counters when a task ends; idempotent if counters are already zero. */
    release(projectId, agentId): void {
      let mutated = false;
      const projCount = perProject.get(projectId) ?? 0;
      if (projCount > 0) {
        perProject.set(projectId, projCount - 1);
        mutated = true;
      }
      const agentCount = perAgent.get(agentId) ?? 0;
      if (agentCount > 0) {
        perAgent.set(agentId, agentCount - 1);
        mutated = true;
      }
      if (activeGlobal > 0 && mutated) {
        activeGlobal -= 1;
      }
      if (mutated) {
        log.debug({ projectId, agentId, activeGlobal }, "released concurrency slot");
      }
    },

    /** Return a copy of the current counter state for diagnostics. */
    snapshot(): ConcurrencySnapshot {
      const proj: Record<string, number> = {};
      for (const [k, v] of perProject) if (v > 0) proj[k] = v;
      const ag: Record<string, number> = {};
      for (const [k, v] of perAgent) if (v > 0) ag[k] = v;
      return { global: activeGlobal, perProject: proj, perAgent: ag };
    },
  };
}
