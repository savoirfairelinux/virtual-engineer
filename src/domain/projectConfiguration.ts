import type { TaskType } from "../interfaces.js";
import type { TaskState } from "./tasks.js";

export const PROJECT_RECONFIGURATION_FAILURE_PREFIX =
  "Project reconfiguration made this task incompatible:";

export interface ActiveProjectTaskSummary {
  taskId: string;
  ticketId: string;
  ticketTitle: string;
  taskType: TaskType;
  state: TaskState;
}

export class ActiveProjectTasksConfirmationRequiredError extends Error {
  readonly code = "ACTIVE_TASKS_CONFIRMATION_REQUIRED";

  constructor(readonly activeTasks: ActiveProjectTaskSummary[]) {
    super(`This execution configuration change affects ${activeTasks.length} active project task(s).`);
    this.name = "ActiveProjectTasksConfirmationRequiredError";
  }
}

export class ProjectReconfigurationIncompatibleError extends Error {
  readonly code = "PROJECT_RECONFIGURATION_INCOMPATIBLE";

  constructor(message: string) {
    super(`${PROJECT_RECONFIGURATION_FAILURE_PREFIX} ${message}`);
    this.name = "ProjectReconfigurationIncompatibleError";
  }
}