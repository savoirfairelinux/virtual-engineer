import type { StateStore, Task, TaskState } from "../interfaces.js";
import { ProjectReconfigurationIncompatibleError } from "../domain/projectConfiguration.js";
import { getLogger } from "../logger.js";

const log = getLogger("review-recovery");

export interface ReviewRecoveryOrchestrator {
  recoverReview(taskId: Task["taskId"]): Promise<void>;
}

export interface ReviewTaskOrchestrator {
  runReview(taskId: Task["taskId"]): Promise<void>;
}

type ReviewTaskFailureStore = Pick<StateStore, "getTask" | "setFailureReason" | "transition">;

const ACTIVE_REVIEW_STATES = new Set<TaskState>([
  "REVIEW_PENDING",
  "REVIEW_RUNNING",
  "REVIEW_COMMENTING",
  "REVIEW_WATCHING",
]);

export async function failIncompatibleReviewTask(
  store: ReviewTaskFailureStore,
  taskId: Task["taskId"],
  error: ProjectReconfigurationIncompatibleError,
): Promise<boolean> {
  const task = await store.getTask(taskId);
  if (!task || task.taskType !== "code-review" || !ACTIVE_REVIEW_STATES.has(task.state)) {
    return false;
  }

  await store.transition(taskId, "REVIEW_FAILED", { error: error.message }, task.state);
  await store.setFailureReason(taskId, error.message);
  log.warn(
    { taskId, state: task.state, reason: error.message },
    "review task is incompatible with its project configuration",
  );
  return true;
}

export async function runReviewTask(
  store: ReviewTaskFailureStore,
  task: Task,
  buildOrchestrator: (task: Task) => Promise<ReviewTaskOrchestrator | null>,
): Promise<void> {
  try {
    const orchestrator = await buildOrchestrator(task);
    if (orchestrator === null) {
      log.warn({ taskId: task.taskId }, "review task runtime unavailable; task was not routed to code generation");
      return;
    }
    await orchestrator.runReview(task.taskId);
  } catch (error: unknown) {
    if (!(error instanceof ProjectReconfigurationIncompatibleError)) throw error;
    await failIncompatibleReviewTask(store, task.taskId, error);
  }
}

export interface ReviewRecoveryResult {
  recovered: number;
  failed: number;
  unavailable: number;
}

export async function recoverActiveReviews(
  store: Pick<StateStore, "getActiveTasks"> & ReviewTaskFailureStore,
  buildOrchestrator: (task: Task) => Promise<ReviewRecoveryOrchestrator | null>
): Promise<ReviewRecoveryResult> {
  const result: ReviewRecoveryResult = { recovered: 0, failed: 0, unavailable: 0 };
  const activeTasks = await store.getActiveTasks();
  const reviewTasks = activeTasks.filter((task) => task.taskType === "code-review");

  await Promise.all(reviewTasks.map(async (task) => {
    try {
      const orchestrator = await buildOrchestrator(task);
      if (orchestrator === null) {
        result.unavailable += 1;
        log.warn({ taskId: task.taskId }, "review recovery runtime unavailable");
        return;
      }
      await orchestrator.recoverReview(task.taskId);
      result.recovered += 1;
    } catch (err) {
      if (err instanceof ProjectReconfigurationIncompatibleError) {
        result.failed += 1;
        try {
          await failIncompatibleReviewTask(store, task.taskId, err);
        } catch (failureErr: unknown) {
          log.error(
            { err: failureErr, taskId: task.taskId, reason: err.message },
            "failed to persist review project incompatibility",
          );
        }
        return;
      }
      result.failed += 1;
      log.error({ err, taskId: task.taskId, state: task.state }, "review recovery failed");
    }
  }));

  return result;
}
