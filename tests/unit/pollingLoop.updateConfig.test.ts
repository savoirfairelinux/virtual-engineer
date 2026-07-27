import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PollingLoop } from "../../src/orchestrator/pollingLoop.js";
import type { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { StateStore } from "../../src/interfaces.js";

function makeStore(): StateStore {
  return {
    getActiveTasks: vi.fn().mockResolvedValue([]),
    getTaskByTicketId: vi.fn().mockResolvedValue(null),
    getActiveTaskByTicketId: vi.fn().mockResolvedValue(null),
    getFailedAttemptCount: vi.fn().mockResolvedValue(0),
    getChangesForTask: vi.fn().mockResolvedValue([]),
    isTaskPaused: vi.fn().mockResolvedValue(false),
  } as unknown as StateStore;
}

function makeOrchestrator(): Orchestrator {
  return {
    startTaskForProject: vi.fn().mockResolvedValue(undefined),
    handleReviewEvent: vi.fn(),
    continueTask: vi.fn(),
    pollAndProcessTickets: vi.fn().mockResolvedValue(undefined),
  } as unknown as Orchestrator;
}

describe("PollingLoop — updateConfig", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("updates the reported interval and max retries", () => {
    const loop = new PollingLoop(
      { ticketIntervalMs: 30000, maxRetryAttempts: 5 },
      makeOrchestrator(),
      makeStore()
    );
    loop.updateConfig({ ticketIntervalMs: 60000, maxRetryAttempts: 9 });
    expect(loop.getIntervals().intervalMs).toBe(60000);
  });

  it("restarts the timer with the new interval when running", () => {
    const setSpy = vi.spyOn(global, "setInterval");
    const clearSpy = vi.spyOn(global, "clearInterval");
    const loop = new PollingLoop(
      { ticketIntervalMs: 30000, maxRetryAttempts: 5 },
      makeOrchestrator(),
      makeStore()
    );
    loop.start();
    setSpy.mockClear();

    loop.updateConfig({ ticketIntervalMs: 45000 });

    expect(clearSpy).toHaveBeenCalled();
    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 45000);
    loop.stop();
  });

  it("does not restart the timer when the interval is unchanged", () => {
    const loop = new PollingLoop(
      { ticketIntervalMs: 30000, maxRetryAttempts: 5 },
      makeOrchestrator(),
      makeStore()
    );
    loop.start();
    const setSpy = vi.spyOn(global, "setInterval");

    loop.updateConfig({ maxRetryAttempts: 2 });

    expect(setSpy).not.toHaveBeenCalled();
    loop.stop();
  });
});
