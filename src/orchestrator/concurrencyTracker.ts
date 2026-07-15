/**
 * Multi-level concurrency tracker.
 *
 * In-memory, single-process counters that gate active agent runs at one level:
 *   1. Per AI adapter integration (`agents.integrationId`) using
 *      `agents.maxConcurrent` (default 1, floor = 1)
 *
 * Project counters are tracked for diagnostics only.
 *
 * Single-process model: this lives entirely in the orchestrator process.
 * No cross-process / distributed coordination. After a process restart all
 * counters reset to 0; in-flight tasks resume their cycles via state recovery,
 * and `runWorkflow` re-acquires their slot lazily.
 *
 * Limits are read from agent records on every call (with a tiny TTL
 * cache to avoid hammering SQLite). Edits via the admin UI take
 * effect within the cache TTL.
 */
import type { AgentId, AgentRecord, ProjectId } from "../interfaces.js";
import { getLogger } from "../logger.js";

const log = getLogger("concurrency-tracker");

/** TTL for the per-deps limit cache, in milliseconds. */
const DEFAULT_CACHE_TTL_MS = 5_000;

export interface ConcurrencyLimits {
  /** Per-integration ceiling. Always `>= 1`. */
  perIntegration: number;
  /** Adapter/integration key used for shared counting across agents. */
  integrationKey: string;
}

export interface ConcurrencySnapshot {
  global: number;
  perProject: Record<string, number>;
  perAgent: Record<string, number>;
}

declare const concurrencyLeaseBrand: unique symbol;

export interface ConcurrencyLease {
  readonly [concurrencyLeaseBrand]: true;
}

export interface ConcurrencyTracker {
  /**
    * Returns true if a new task can start (all gating limits would still be
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
  acquire(projectId: ProjectId, agentId: AgentId): Promise<ConcurrencyLease | null>;

  /**
   * Release a slot when a task reaches a terminal state. Idempotent: releasing
   * a never-acquired or already-released slot is a no-op (counters never go
   * negative).
   */
  release(lease: ConcurrencyLease): void;

  /** Diagnostic snapshot of the live counters. */
  snapshot(): ConcurrencySnapshot;
}

export interface ConcurrencyTrackerDeps {
  agentStore: { getAgentById(id: AgentId): Promise<AgentRecord | null> };
  /** Override the cache TTL (ms). Defaults to 5000. Tests use this with fake timers. */
  cacheTtlMs?: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface ActiveLease {
  projectId: ProjectId;
  agentId: AgentId;
  integrationKey: string;
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
  const agentLookup = cachedLimitsLookup<AgentId, AgentRecord | null>(
    (id) => deps.agentStore.getAgentById(id),
    ttl
  );
  const perProject = new Map<string, number>();
  const perIntegration = new Map<string, number>();
  const activeLeases = new WeakMap<ConcurrencyLease, ActiveLease>();
  let activeGlobal = 0;

  /** Fetch the current concurrency limits for an agent, using the TTL cache. */
  async function loadLimits(projectId: ProjectId, agentId: AgentId): Promise<ConcurrencyLimits> {
    const agent = await agentLookup(agentId);
    void projectId;
    const integrationKey = agent?.integrationId ?? `agent:${agentId}`;
    return {
      integrationKey,
      perIntegration: normalizePerEntityLimit(agent?.maxConcurrent),
    };
  }

  /** Return true when the integration counter is below its limit. */
  function check(limits: ConcurrencyLimits, projectId: ProjectId, agentId: AgentId): boolean {
    void projectId;
    void agentId;
    if ((perIntegration.get(limits.integrationKey) ?? 0) >= limits.perIntegration) return false;
    return true;
  }

  return {
    /** Check whether a new task can start without mutating counters. */
    async canStart(projectId, agentId): Promise<boolean> {
      const limits = await loadLimits(projectId, agentId);
      return check(limits, projectId, agentId);
    },

    /** Atomically claim a slot if limits allow, incrementing all three counters. */
    async acquire(projectId, agentId): Promise<ConcurrencyLease | null> {
      const limits = await loadLimits(projectId, agentId);
      if (!check(limits, projectId, agentId)) {
        return null;
      }
      activeGlobal += 1;
      perProject.set(projectId, (perProject.get(projectId) ?? 0) + 1);
      perIntegration.set(limits.integrationKey, (perIntegration.get(limits.integrationKey) ?? 0) + 1);
      const lease = Object.freeze({}) as ConcurrencyLease;
      activeLeases.set(lease, { projectId, agentId, integrationKey: limits.integrationKey });
      log.debug({ projectId, agentId, activeGlobal, limits }, "acquired concurrency slot");
      return lease;
    },

    /** Consume a lease once and decrement exactly the counters it acquired. */
    release(lease): void {
      const active = activeLeases.get(lease);
      if (active === undefined) return;
      activeLeases.delete(lease);
      const projectCount = perProject.get(active.projectId) ?? 0;
      perProject.set(active.projectId, Math.max(0, projectCount - 1));
      const integrationCount = perIntegration.get(active.integrationKey) ?? 0;
      perIntegration.set(active.integrationKey, Math.max(0, integrationCount - 1));
      activeGlobal = Math.max(0, activeGlobal - 1);
      log.debug({ ...active, activeGlobal }, "released concurrency slot");
    },

    /** Return a copy of the current counter state for diagnostics. */
    snapshot(): ConcurrencySnapshot {
      const proj: Record<string, number> = {};
      for (const [k, v] of perProject) if (v > 0) proj[k] = v;
      const ag: Record<string, number> = {};
      for (const [k, v] of perIntegration) if (v > 0) ag[k] = v;
      return { global: activeGlobal, perProject: proj, perAgent: ag };
    },
  };
}
