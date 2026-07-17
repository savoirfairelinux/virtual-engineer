import type { ProjectId, TaskId } from "../interfaces.js";

export interface ProjectStartLease {
  release(): void;
}

export class TaskLifecycleCoordinator {
  private readonly taskTails = new Map<TaskId, Promise<unknown>>();
  private readonly activeTaskControllers = new Map<TaskId, AbortController>();
  private readonly pendingTaskCancellations = new Map<TaskId, unknown>();
  private readonly deletedTaskIds = new Set<TaskId>();
  private readonly projectStartTails = new Map<ProjectId, Promise<void>>();
  private readonly deletingProjects = new Set<ProjectId>();

  async runTask<T>(taskId: TaskId, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const previous = this.taskTails.get(taskId) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(async () => {
      const controller = new AbortController();
      this.activeTaskControllers.set(taskId, controller);
      if (this.pendingTaskCancellations.has(taskId)) {
        const reason = this.pendingTaskCancellations.get(taskId);
        this.pendingTaskCancellations.delete(taskId);
        controller.abort(reason);
      }
      try {
        return await operation(controller.signal);
      } finally {
        if (this.activeTaskControllers.get(taskId) === controller) {
          this.activeTaskControllers.delete(taskId);
        }
      }
    });
    const tracked = queued.finally(() => {
      if (this.taskTails.get(taskId) === tracked) this.taskTails.delete(taskId);
    });
    this.taskTails.set(taskId, tracked);
    return tracked;
  }

  async cancelTaskAndRun<T>(taskId: TaskId, operation: () => Promise<T>): Promise<T> {
    const reason = new Error(`Task ${taskId} was cancelled`);
    const controller = this.activeTaskControllers.get(taskId);
    if (controller !== undefined) {
      controller.abort(reason);
    } else if (this.taskTails.has(taskId)) {
      this.pendingTaskCancellations.set(taskId, reason);
    }
    return this.runTask(taskId, async () => operation());
  }

  wasTaskDeleted(taskId: TaskId): boolean {
    return this.deletedTaskIds.has(taskId);
  }

  async acquireProjectStart(projectId: ProjectId): Promise<ProjectStartLease | null> {
    if (this.deletingProjects.has(projectId)) return null;
    const previous = this.projectStartTails.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = previous.catch(() => undefined).then(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    this.projectStartTails.set(projectId, current);
    await previous.catch(() => undefined);
    if (this.deletingProjects.has(projectId)) {
      release();
      if (this.projectStartTails.get(projectId) === current) this.projectStartTails.delete(projectId);
      return null;
    }
    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        release();
        if (this.projectStartTails.get(projectId) === current) this.projectStartTails.delete(projectId);
      },
    };
  }

  async deleteProject(
    projectId: ProjectId,
    getTaskIds: () => Promise<TaskId[]>,
    operation: () => Promise<void>,
  ): Promise<void> {
    if (this.deletingProjects.has(projectId)) throw new Error(`Project ${projectId} is already being deleted`);
    this.deletingProjects.add(projectId);
    try {
      await (this.projectStartTails.get(projectId) ?? Promise.resolve()).catch(() => undefined);
      const taskIds = [...new Set(await getTaskIds())].sort();
      for (const taskId of taskIds) {
        this.activeTaskControllers.get(taskId)?.abort(new Error(`Project ${projectId} is being deleted`));
      }
      await this.runTaskBarrier(taskIds, operation);
      for (const taskId of taskIds) this.deletedTaskIds.add(taskId);
    } catch (err) {
      this.deletingProjects.delete(projectId);
      throw err;
    }
  }

  private async runTaskBarrier(taskIds: TaskId[], operation: () => Promise<void>): Promise<void> {
    if (taskIds.length === 0) {
      await operation();
      return;
    }
    const previous = taskIds.map((taskId) => this.taskTails.get(taskId) ?? Promise.resolve());
    const queued = Promise.all(previous.map((tail) => tail.catch(() => undefined))).then(operation);
    const tracked = queued.finally(() => {
      for (const taskId of taskIds) {
        if (this.taskTails.get(taskId) === tracked) this.taskTails.delete(taskId);
      }
    });
    for (const taskId of taskIds) this.taskTails.set(taskId, tracked);
    await tracked;
  }
}
