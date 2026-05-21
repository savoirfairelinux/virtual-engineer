import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createConcurrencyTracker,
  type ConcurrencyTrackerDeps,
} from "../../src/orchestrator/concurrencyTracker.js";
import type { AgentId, AgentRecord, ProjectId, ProjectRecord } from "../../src/interfaces.js";

function pid(s: string): ProjectId {
  return s as ProjectId;
}
function aid(s: string): AgentId {
  return s as AgentId;
}

interface Stubs {
  projects: Map<string, Partial<ProjectRecord>>;
  agents: Map<string, Partial<AgentRecord>>;
  global: number | null;
  deps: ConcurrencyTrackerDeps;
}

function makeStubs(opts: {
  perProject?: number;
  perAgent?: number;
  global?: number | null;
  cacheTtlMs?: number;
} = {}): Stubs {
  const projects = new Map<string, Partial<ProjectRecord>>();
  const agents = new Map<string, Partial<AgentRecord>>();
  const stub: Stubs = {
    projects,
    agents,
    global: opts.global ?? null,
    deps: {
      projectStore: {
        async getProjectById(id) {
          const p = projects.get(id) ?? { id, maxConcurrent: opts.perProject ?? 1 };
          return p as ProjectRecord;
        },
      },
      agentStore: {
        async getAgentById(id) {
          const a = agents.get(id) ?? { id, maxConcurrent: opts.perAgent ?? 1 };
          return a as AgentRecord;
        },
      },
      globalLimitProvider: async () => stub.global,
      ...(opts.cacheTtlMs !== undefined ? { cacheTtlMs: opts.cacheTtlMs } : {}),
    },
  };
  return stub;
}

describe("ConcurrencyTracker", () => {
  it("acquire increments all 3 counters and release decrements", async () => {
    const stubs = makeStubs({ perProject: 5, perAgent: 5 });
    const t = createConcurrencyTracker(stubs.deps);
    expect(await t.acquire(pid("p1"), aid("a1"))).toBe(true);
    expect(t.snapshot()).toEqual({ global: 1, perProject: { p1: 1 }, perAgent: { a1: 1 } });
    t.release(pid("p1"), aid("a1"));
    expect(t.snapshot()).toEqual({ global: 0, perProject: {}, perAgent: {} });
  });

  it("acquire returns false when per-project limit reached and does not mutate", async () => {
    const stubs = makeStubs({ perProject: 1, perAgent: 5 });
    const t = createConcurrencyTracker(stubs.deps);
    expect(await t.acquire(pid("p1"), aid("a1"))).toBe(true);
    const before = t.snapshot();
    expect(await t.acquire(pid("p1"), aid("a2"))).toBe(false);
    expect(t.snapshot()).toEqual(before);
  });

  it("acquire returns false when per-agent limit reached and does not mutate", async () => {
    const stubs = makeStubs({ perProject: 5, perAgent: 1 });
    const t = createConcurrencyTracker(stubs.deps);
    expect(await t.acquire(pid("p1"), aid("a1"))).toBe(true);
    const before = t.snapshot();
    expect(await t.acquire(pid("p2"), aid("a1"))).toBe(false);
    expect(t.snapshot()).toEqual(before);
  });

  it("acquire returns false when global limit reached", async () => {
    const stubs = makeStubs({ perProject: 5, perAgent: 5, global: 2 });
    const t = createConcurrencyTracker(stubs.deps);
    expect(await t.acquire(pid("p1"), aid("a1"))).toBe(true);
    expect(await t.acquire(pid("p2"), aid("a2"))).toBe(true);
    expect(await t.acquire(pid("p3"), aid("a3"))).toBe(false);
  });

  it("canStart is non-mutating", async () => {
    const stubs = makeStubs({ perProject: 5, perAgent: 5 });
    const t = createConcurrencyTracker(stubs.deps);
    expect(await t.canStart(pid("p1"), aid("a1"))).toBe(true);
    expect(await t.canStart(pid("p1"), aid("a1"))).toBe(true);
    expect(t.snapshot().global).toBe(0);
  });

  it("counts multiple projects and agents independently", async () => {
    const stubs = makeStubs({ perProject: 2, perAgent: 5 });
    const t = createConcurrencyTracker(stubs.deps);
    expect(await t.acquire(pid("p1"), aid("a1"))).toBe(true);
    expect(await t.acquire(pid("p1"), aid("a2"))).toBe(true);
    expect(await t.acquire(pid("p1"), aid("a3"))).toBe(false); // p1 full
    expect(await t.acquire(pid("p2"), aid("a3"))).toBe(true); // p2 still empty
    const s = t.snapshot();
    expect(s.perProject).toEqual({ p1: 2, p2: 1 });
  });

  it("treats maxConcurrent <= 0 as 1", async () => {
    const stubs = makeStubs();
    stubs.projects.set("p1", { id: pid("p1"), maxConcurrent: 0 });
    stubs.agents.set("a1", { id: aid("a1"), maxConcurrent: -3 });
    const t = createConcurrencyTracker(stubs.deps);
    expect(await t.acquire(pid("p1"), aid("a1"))).toBe(true);
    expect(await t.acquire(pid("p1"), aid("a1"))).toBe(false); // floor=1 enforced
  });

  it("global=null means unlimited", async () => {
    const stubs = makeStubs({ perProject: 100, perAgent: 100, global: null });
    const t = createConcurrencyTracker(stubs.deps);
    for (let i = 0; i < 50; i += 1) {
      expect(await t.acquire(pid(`p${i}`), aid(`a${i}`))).toBe(true);
    }
    expect(t.snapshot().global).toBe(50);
  });

  it("release of a never-acquired slot is a no-op (no negative counters)", async () => {
    const stubs = makeStubs();
    const t = createConcurrencyTracker(stubs.deps);
    t.release(pid("ghost"), aid("ghost"));
    t.release(pid("ghost"), aid("ghost"));
    expect(t.snapshot()).toEqual({ global: 0, perProject: {}, perAgent: {} });
  });

  describe("cache TTL", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("limit change is reflected on next acquire after TTL elapses", async () => {
      const stubs = makeStubs({ perProject: 1, perAgent: 5, cacheTtlMs: 1000 });
      const t = createConcurrencyTracker(stubs.deps);
      expect(await t.acquire(pid("p1"), aid("a1"))).toBe(true);
      // Even after release, cache still says perProject=1
      t.release(pid("p1"), aid("a1"));
      // Bump the limit at the source
      stubs.projects.set("p1", { id: pid("p1"), maxConcurrent: 2 });
      // Within TTL: new value not yet visible — but since counters are 0 we'd succeed anyway.
      // Demonstrate cache by repeatedly acquiring up to old limit and asserting refusal,
      // then advancing time past TTL and asserting new limit is honored.
      expect(await t.acquire(pid("p1"), aid("a1"))).toBe(true);
      expect(await t.acquire(pid("p1"), aid("a2"))).toBe(false); // cache still says 1
      vi.setSystemTime(new Date(Date.now() + 2000));
      expect(await t.acquire(pid("p1"), aid("a3"))).toBe(true); // cache refreshed → limit=2
    });
  });
});
