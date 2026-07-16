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