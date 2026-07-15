import { describe, expect, it, vi } from "vitest";
import { recoverActiveReviews } from "../../src/review/reviewRecovery.js";
import { makeTaskId, type Task } from "../../src/interfaces.js";

function makeTask(overrides: Partial<Task>): Task {
  return {
    taskId: makeTaskId("review-1"),
    ticketId: "ticket-1" as Task["ticketId"],
    displayId: "1",
    ticketTitle: "Review",
    ticketDescription: "",
    state: "REVIEW_PENDING",
    taskType: "code-review",
    ticketSourceLabel: "gerrit:gerrit-1",
    externalChangeId: null,
    currentPatchset: 1,
    reviewedPatchset: null,
    pushRef: null,
    projectId: null,
    cycleCount: 0,
    failureReason: null,
    ticketUrl: null,
    reviewUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("recoverActiveReviews", () => {
  it("recovers only active review tasks and isolates per-task failures", async () => {
    const pending = makeTask({ taskId: makeTaskId("review-pending") });
    const running = makeTask({ taskId: makeTaskId("review-running"), state: "REVIEW_RUNNING" });
    const watching = makeTask({ taskId: makeTaskId("review-watching"), state: "REVIEW_WATCHING" });
    const codeGen = makeTask({
      taskId: makeTaskId("code-gen"),
      taskType: "code-gen",
      state: "DETECTED",
    });
    const recoverReview = vi.fn(async (taskId: Task["taskId"]) => {
      if (taskId === running.taskId) throw new Error("gateway unavailable");
    });
    const buildOrchestrator = vi.fn(async () => ({ recoverReview }));

    const result = await recoverActiveReviews(
      { getActiveTasks: vi.fn(async () => [pending, codeGen, running, watching]) },
      buildOrchestrator
    );

    expect(buildOrchestrator).toHaveBeenCalledTimes(3);
    expect(recoverReview).toHaveBeenNthCalledWith(1, pending.taskId);
    expect(recoverReview).toHaveBeenNthCalledWith(2, running.taskId);
    expect(recoverReview).toHaveBeenNthCalledWith(3, watching.taskId);
    expect(result).toEqual({ recovered: 2, failed: 1, unavailable: 0 });
  });

  it("counts a missing review runtime without blocking other tasks", async () => {
    const first = makeTask({ taskId: makeTaskId("review-first") });
    const second = makeTask({ taskId: makeTaskId("review-second") });
    const recoverReview = vi.fn(async () => undefined);
    const buildOrchestrator = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ recoverReview });

    const result = await recoverActiveReviews(
      { getActiveTasks: vi.fn(async () => [first, second]) },
      buildOrchestrator
    );

    expect(recoverReview).toHaveBeenCalledWith(second.taskId);
    expect(result).toEqual({ recovered: 1, failed: 0, unavailable: 1 });
  });
});
