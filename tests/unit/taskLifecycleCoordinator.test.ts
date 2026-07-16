import { describe, expect, it, vi } from "vitest";
import { makeProjectId, makeTaskId } from "../../src/interfaces.js";
import { TaskLifecycleCoordinator } from "../../src/orchestrator/taskLifecycleCoordinator.js";

describe("TaskLifecycleCoordinator", () => {
  it("marks a project deleting before waiting for an existing start lease", async () => {
    const coordinator = new TaskLifecycleCoordinator();
    const projectId = makeProjectId("project-1");
    const lease = await coordinator.acquireProjectStart(projectId);
    expect(lease).not.toBeNull();
    const deletion = vi.fn(async () => undefined);

    const deleting = coordinator.deleteProject(projectId, async () => [], deletion);
    await Promise.resolve();

    await expect(coordinator.acquireProjectStart(projectId)).resolves.toBeNull();
    expect(deletion).not.toHaveBeenCalled();
    lease?.release();
    await deleting;
    expect(deletion).toHaveBeenCalledOnce();
  });

  it("aborts and awaits an active task before applying a terminal mutation", async () => {
    const coordinator = new TaskLifecycleCoordinator();
    const taskId = makeTaskId("task-1");
    let operationFinished = false;
    const active = coordinator.runTask(taskId, async (signal) => {
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      operationFinished = true;
    });
    await Promise.resolve();
    const mutation = vi.fn(async () => {
      expect(operationFinished).toBe(true);
    });

    await coordinator.cancelTaskAndRun(taskId, mutation);
    await active;

    expect(mutation).toHaveBeenCalledOnce();
  });
});
