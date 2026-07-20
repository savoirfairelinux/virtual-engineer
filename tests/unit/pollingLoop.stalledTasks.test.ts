import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PollingLoop } from "../../src/orchestrator/pollingLoop.js";
import type { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { StateStore, Task } from "../../src/interfaces.js";
import { makeTaskId, makeTicketId } from "../../src/interfaces.js";

function makeTask(
  over: { taskId: string; state?: Task["state"]; taskType?: Task["taskType"] }
): Task {
  return {
    taskId: makeTaskId(over.taskId),
    ticketId: makeTicketId("ticket-1"),
    ticketSourceLabel: "gitlab:int-1",
    ticketTitle: "Test ticket",
    ticketDescription: "",
    state: over.state ?? "CONTEXT_BUILDING",
    taskType: over.taskType ?? "code-gen",
    externalChangeId: null,
    currentPatchset: 0,
    reviewedPatchset: null,
    cycleCount: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    failureReason: null,
    ticketUrl: null,
    reviewUrl: null,
    displayId: null,
  };
}

function makeStore(activeTasks: Task[] = []): StateStore {
  return {
    getActiveTasks: vi.fn().mockResolvedValue(activeTasks),
  } as unknown as StateStore;
}

function makeOrchestrator() {
  return {
    resumeStalledCodeGenTask: vi.fn().mockResolvedValue(undefined),
    handleReviewEvent: vi.fn().mockResolvedValue(undefined),
    checkReviewWatchingTask: vi.fn().mockResolvedValue(undefined),
  } as unknown as Orchestrator & { resumeStalledCodeGenTask: ReturnType<typeof vi.fn> };
}

describe("PollingLoop — pollStalledCodeGenTasks", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("resumes code-gen tasks stuck in CONTEXT_BUILDING", async () => {
    const task = makeTask({ taskId: "t-1", state: "CONTEXT_BUILDING" });
    const orchestrator = makeOrchestrator();
    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      orchestrator,
      makeStore([task]),
    );

    await loop.pollStalledCodeGenTasks();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(orchestrator.resumeStalledCodeGenTask).toHaveBeenCalledTimes(1);
    expect(orchestrator.resumeStalledCodeGenTask).toHaveBeenCalledWith(makeTaskId("t-1"));
  });

  it("resumes code-gen tasks stuck in RETRY_CYCLE", async () => {
    const task = makeTask({ taskId: "t-2", state: "RETRY_CYCLE" });
    const orchestrator = makeOrchestrator();
    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      orchestrator,
      makeStore([task]),
    );

    await loop.pollStalledCodeGenTasks();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(orchestrator.resumeStalledCodeGenTask).toHaveBeenCalledWith(makeTaskId("t-2"));
  });

  it("ignores code-gen tasks in non-stalled states", async () => {
    const tasks = [
      makeTask({ taskId: "t-run", state: "AGENT_RUNNING" }),
      makeTask({ taskId: "t-rev", state: "IN_REVIEW" }),
      makeTask({ taskId: "t-fb", state: "FEEDBACK_PROCESSING" }),
    ];
    const orchestrator = makeOrchestrator();
    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      orchestrator,
      makeStore(tasks),
    );

    await loop.pollStalledCodeGenTasks();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(orchestrator.resumeStalledCodeGenTask).not.toHaveBeenCalled();
  });

  it("ignores code-review tasks even in CONTEXT_BUILDING/RETRY_CYCLE-like states", async () => {
    const task = makeTask({ taskId: "t-cr", state: "CONTEXT_BUILDING", taskType: "code-review" });
    const orchestrator = makeOrchestrator();
    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      orchestrator,
      makeStore([task]),
    );

    await loop.pollStalledCodeGenTasks();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(orchestrator.resumeStalledCodeGenTask).not.toHaveBeenCalled();
  });

  it("processes multiple stalled tasks and does not throw when a resume rejects", async () => {
    const tasks = [
      makeTask({ taskId: "t-a", state: "CONTEXT_BUILDING" }),
      makeTask({ taskId: "t-b", state: "RETRY_CYCLE" }),
    ];
    const orchestrator = makeOrchestrator();
    orchestrator.resumeStalledCodeGenTask
      .mockRejectedValueOnce(new Error("resume failed"))
      .mockResolvedValueOnce(undefined);
    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      orchestrator,
      makeStore(tasks),
    );

    await expect(loop.pollStalledCodeGenTasks()).resolves.toBeUndefined();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(orchestrator.resumeStalledCodeGenTask).toHaveBeenCalledTimes(2);
  });
});
