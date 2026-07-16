import type { Task } from "../interfaces.js";
import { getLogger } from "../logger.js";

const log = getLogger("review-recovery");

export interface ReviewRecoveryOrchestrator {
  recoverReview(taskId: Task["taskId"]): Promise<void>;
}

export interface ReviewRecoveryResult {
  recovered: number;
  failed: number;
  unavailable: number;
}

export async function recoverActiveReviews(
  store: { getActiveTasks(): Promise<Task[]> },
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
      result.failed += 1;
      log.error({ err, taskId: task.taskId, state: task.state }, "review recovery failed");
    }
  }));

  return result;
}
