import { describe, expect, it, vi } from "vitest";
import { recoverActiveReviews, runReviewTask } from "../../src/review/reviewRecovery.js";
import { ProjectReconfigurationIncompatibleError } from "../../src/domain/projectConfiguration.js";
import { makeTaskId, type Task, type TaskState } from "../../src/interfaces.js";

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

function makeStore(activeTasks: Task[]) {
  return {
    getActiveTasks: vi.fn(async () => activeTasks),
    getTask: vi.fn(async (taskId: Task["taskId"]) => activeTasks.find((task) => task.taskId === taskId) ?? null),
    setFailureReason: vi.fn(async () => undefined),
    transition: vi.fn(async (taskId: Task["taskId"], state: TaskState) => {
      const task = activeTasks.find((candidate) => candidate.taskId === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      return { ...task, state };
    }),
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

    const store = makeStore([pending, codeGen, running, watching]);
    const result = await recoverActiveReviews(store, buildOrchestrator);

    expect(buildOrchestrator).toHaveBeenCalledTimes(3);
    expect(recoverReview).toHaveBeenNthCalledWith(1, pending.taskId);
    expect(recoverReview).toHaveBeenNthCalledWith(2, running.taskId);
    expect(recoverReview).toHaveBeenNthCalledWith(3, watching.taskId);
    expect(result).toEqual({ recovered: 2, failed: 1, unavailable: 0 });
    expect(store.setFailureReason).not.toHaveBeenCalled();
    expect(store.transition).not.toHaveBeenCalled();
  });

  it("counts a missing review runtime without blocking other tasks", async () => {
    const first = makeTask({ taskId: makeTaskId("review-first") });
    const second = makeTask({ taskId: makeTaskId("review-second") });
    const recoverReview = vi.fn(async () => undefined);
    const buildOrchestrator = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ recoverReview });

    const store = makeStore([first, second]);
    const result = await recoverActiveReviews(store, buildOrchestrator);

    expect(recoverReview).toHaveBeenCalledWith(second.taskId);
    expect(result).toEqual({ recovered: 1, failed: 0, unavailable: 1 });
    expect(store.setFailureReason).not.toHaveBeenCalled();
    expect(store.transition).not.toHaveBeenCalled();
  });

  it("persists a project-binding incompatibility as REVIEW_FAILED", async () => {
    const task = makeTask({ taskId: makeTaskId("review-reconfigured") });
    const store = makeStore([task]);
    const incompatibility = new ProjectReconfigurationIncompatibleError(
      "Review integration changed while task review-reconfigured was active.",
    );

    const result = await recoverActiveReviews(store, async () => {
      throw incompatibility;
    });

    expect(store.setFailureReason).toHaveBeenCalledWith(task.taskId, incompatibility.message);
    expect(store.transition).toHaveBeenCalledWith(
      task.taskId,
      "REVIEW_FAILED",
      { error: incompatibility.message },
      "REVIEW_PENDING",
    );
    expect(result).toEqual({ recovered: 0, failed: 1, unavailable: 0 });
  });

  it("leaves a task unchanged when the admin review runtime is unavailable", async () => {
    const task = makeTask({ taskId: makeTaskId("review-runtime-unavailable") });
    const store = makeStore([task]);

    await runReviewTask(store, task, async () => null);

    expect(store.setFailureReason).not.toHaveBeenCalled();
    expect(store.transition).not.toHaveBeenCalled();
  });

  it("persists an admin-triggered project incompatibility as REVIEW_FAILED", async () => {
    const task = makeTask({ taskId: makeTaskId("review-admin-incompatible") });
    const store = makeStore([task]);
    const incompatibility = new ProjectReconfigurationIncompatibleError(
      "Review integration changed while task review-admin-incompatible was active.",
    );

    await runReviewTask(store, task, async () => {
      throw incompatibility;
    });

    expect(store.setFailureReason).toHaveBeenCalledWith(task.taskId, incompatibility.message);
    expect(store.transition).toHaveBeenCalledWith(
      task.taskId,
      "REVIEW_FAILED",
      { error: incompatibility.message },
      "REVIEW_PENDING",
    );
  });

  it("does not overwrite a task that became terminal before incompatibility handling", async () => {
    const task = makeTask({ taskId: makeTaskId("review-finished-during-recovery") });
    const terminalTask = makeTask({ ...task, state: "REVIEW_DONE" });
    const store = makeStore([terminalTask]);
    const incompatibility = new ProjectReconfigurationIncompatibleError("Review binding changed.");

    await runReviewTask(store, task, async () => {
      throw incompatibility;
    });

    expect(store.setFailureReason).not.toHaveBeenCalled();
    expect(store.transition).not.toHaveBeenCalled();
  });

  it("does not persist a failure reason when the state transition loses a race", async () => {
    const task = makeTask({ taskId: makeTaskId("review-raced-transition") });
    const store = makeStore([task]);
    store.transition.mockRejectedValue(new Error("Task state changed concurrently"));
    const incompatibility = new ProjectReconfigurationIncompatibleError("Review binding changed.");

    await expect(runReviewTask(store, task, async () => {
      throw incompatibility;
    })).rejects.toThrow("Task state changed concurrently");

    expect(store.setFailureReason).not.toHaveBeenCalled();
  });

  it("starts review recoveries concurrently", async () => {
    const first = makeTask({ taskId: makeTaskId("review-blocked") });
    const second = makeTask({ taskId: makeTaskId("review-ready") });
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const recoverReview = vi.fn(async (taskId: Task["taskId"]) => {
      if (taskId === first.taskId) await firstBlocked;
    });

    const recovery = recoverActiveReviews(makeStore([first, second]), vi.fn(async () => ({ recoverReview })));

    await vi.waitFor(() => expect(recoverReview).toHaveBeenCalledWith(second.taskId));
    releaseFirst?.();
    await expect(recovery).resolves.toEqual({ recovered: 2, failed: 0, unavailable: 0 });
  });
});
