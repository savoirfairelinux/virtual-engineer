import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createConcurrencyTracker,
  type ConcurrencyTrackerDeps,
} from "../../src/orchestrator/concurrencyTracker.js";
import type { AgentId, AgentRecord, ProjectId } from "../../src/interfaces.js";

function pid(s: string): ProjectId {
  return s as ProjectId;
}
function aid(s: string): AgentId {
  return s as AgentId;
}

interface Stubs {
  agents: Map<string, Partial<AgentRecord>>;
  global: number | null;
  deps: ConcurrencyTrackerDeps;
}

function makeStubs(opts: {
  perAgent?: number;
  integrationId?: string;
  cacheTtlMs?: number;
} = {}): Stubs {
  const agents = new Map<string, Partial<AgentRecord>>();
  const stub: Stubs = {
    agents,
    global: null,
    deps: {
      agentStore: {
        async getAgentById(id) {
          const a = agents.get(id) ?? { id, maxConcurrent: opts.perAgent ?? 1, integrationId: opts.integrationId ?? null };
          return a as AgentRecord;
        },
      },
      ...(opts.cacheTtlMs !== undefined ? { cacheTtlMs: opts.cacheTtlMs } : {}),
    },
  };
  return stub;
}

describe("ConcurrencyTracker", () => {
  it("acquire increments all 3 counters and release decrements", async () => {
    const stubs = makeStubs({ perAgent: 5, integrationId: "copilot-1" });
    const t = createConcurrencyTracker(stubs.deps);
    expect(await t.acquire(pid("p1"), aid("a1"))).toBe(true);
    expect(t.snapshot()).toEqual({ global: 1, perProject: { p1: 1 }, perAgent: { "copilot-1": 1 } });
    t.release(pid("p1"), aid("a1"));
    expect(t.snapshot()).toEqual({ global: 0, perProject: {}, perAgent: {} });
  });

  it("project ownership does not gate starts", async () => {
    const stubs = makeStubs({ perAgent: 5 });
    const t = createConcurrencyTracker(stubs.deps);
    expect(await t.acquire(pid("p1"), aid("a1"))).toBe(true);
    expect(await t.acquire(pid("p1"), aid("a2"))).toBe(true);
  });

  it("acquire returns false when per-agent limit reached and does not mutate", async () => {
    const stubs = makeStubs({ perAgent: 1 });
    const t = createConcurrencyTracker(stubs.deps);
    expect(await t.acquire(pid("p1"), aid("a1"))).toBe(true);
    const before = t.snapshot();
    expect(await t.acquire(pid("p2"), aid("a1"))).toBe(false);
    expect(t.snapshot()).toEqual(before);
  });

  it("acquire returns false when integration limit reached", async () => {
    const stubs = makeStubs({ perAgent: 2, integrationId: "copilot-1" });
    stubs.agents.set("a1", { id: aid("a1"), maxConcurrent: 2, integrationId: "copilot-1" });
    stubs.agents.set("a2", { id: aid("a2"), maxConcurrent: 2, integrationId: "copilot-1" });
    stubs.agents.set("a3", { id: aid("a3"), maxConcurrent: 2, integrationId: "copilot-1" });
    const t = createConcurrencyTracker(stubs.deps);
    expect(await t.acquire(pid("p1"), aid("a1"))).toBe(true);
    expect(await t.acquire(pid("p2"), aid("a2"))).toBe(true);
    expect(await t.acquire(pid("p3"), aid("a3"))).toBe(false);
  });

  it("canStart is non-mutating", async () => {
    const stubs = makeStubs({ perAgent: 5 });
    const t = createConcurrencyTracker(stubs.deps);
    expect(await t.canStart(pid("p1"), aid("a1"))).toBe(true);
    expect(await t.canStart(pid("p1"), aid("a1"))).toBe(true);
    expect(t.snapshot().global).toBe(0);
  });

  it("counts multiple projects and agents for diagnostics", async () => {
    const stubs = makeStubs({ perAgent: 5 });
    const t = createConcurrencyTracker(stubs.deps);
    expect(await t.acquire(pid("p1"), aid("a1"))).toBe(true);
    expect(await t.acquire(pid("p1"), aid("a2"))).toBe(true);
    expect(await t.acquire(pid("p1"), aid("a3"))).toBe(true);
    expect(await t.acquire(pid("p2"), aid("a3"))).toBe(true); // p2 still empty
    const s = t.snapshot();
    expect(s.perProject).toEqual({ p1: 3, p2: 1 });
  });

  it("treats agent maxConcurrent <= 0 as 1", async () => {
    const stubs = makeStubs();
    stubs.agents.set("a1", { id: aid("a1"), maxConcurrent: -3 });
    const t = createConcurrencyTracker(stubs.deps);
    expect(await t.acquire(pid("p1"), aid("a1"))).toBe(true);
    expect(await t.acquire(pid("p1"), aid("a1"))).toBe(false); // floor=1 enforced
  });

  it("distinct integrations do not share the same gate", async () => {
    const stubs = makeStubs();
    stubs.agents.set("a1", { id: aid("a1"), maxConcurrent: 1, integrationId: "copilot-1" });
    stubs.agents.set("a2", { id: aid("a2"), maxConcurrent: 1, integrationId: "copilot-2" });
    const t = createConcurrencyTracker(stubs.deps);
    expect(await t.acquire(pid("p1"), aid("a1"))).toBe(true);
    expect(await t.acquire(pid("p2"), aid("a2"))).toBe(true);
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

    it("agent limit change is reflected on next acquire after TTL elapses", async () => {
      const stubs = makeStubs({ perAgent: 1, cacheTtlMs: 1000 });
      const t = createConcurrencyTracker(stubs.deps);
      expect(await t.acquire(pid("p1"), aid("a1"))).toBe(true);
      // Even after release, cache still says perAgent=1
      t.release(pid("p1"), aid("a1"));
      // Bump the limit at the source
      stubs.agents.set("a1", { id: aid("a1"), maxConcurrent: 2 });
      // Within TTL: new value not yet visible.
      expect(await t.acquire(pid("p1"), aid("a1"))).toBe(true);
      expect(await t.acquire(pid("p2"), aid("a1"))).toBe(false); // cache still says 1
      vi.setSystemTime(new Date(Date.now() + 2000));
      expect(await t.acquire(pid("p2"), aid("a1"))).toBe(true); // cache refreshed → limit=2
    });
  });
});
