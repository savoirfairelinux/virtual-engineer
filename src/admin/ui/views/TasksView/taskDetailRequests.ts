export interface TaskRequestIdentity {
  taskId: string;
  requestSequence: number;
}

export function isCurrentTaskRequest(
  requestedTaskId: string,
  requestSequence: number,
  currentTaskId: string,
  currentSequence: number,
): boolean {
  return requestedTaskId === currentTaskId && requestSequence === currentSequence;
}

export function shouldStartTaskRequest(
  requestedTaskId: string,
  pendingRequest: TaskRequestIdentity | null,
): boolean {
  return pendingRequest?.taskId !== requestedTaskId;
}

export function isSameTaskRequest(
  left: TaskRequestIdentity | null,
  right: TaskRequestIdentity,
): boolean {
  return left?.taskId === right.taskId && left.requestSequence === right.requestSequence;
}

export function shouldClearDeletedTask(deletedTaskId: string, selectedTaskId: string): boolean {
  return deletedTaskId === selectedTaskId;
}

export interface LogsPanelAccess {
  taskId: string;
  opened: boolean;
}

/**
 * The live-log panel opens its stream when it mounts, so it mounts only once
 * the Logs tab is opened for the selected task, then stays mounted across tab
 * switches until another task is selected.
 */
export function nextLogsPanelAccess(
  previous: LogsPanelAccess,
  taskId: string,
  logsTabActive: boolean,
): LogsPanelAccess {
  if (previous.taskId !== taskId) return { taskId, opened: logsTabActive };
  return logsTabActive && !previous.opened ? { taskId, opened: true } : previous;
}