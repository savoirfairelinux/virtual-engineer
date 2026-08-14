export interface TaskSelectionOptions {
  additive?: boolean;
  anchorId?: string | undefined;
}

export function selectTaskIds(
  taskIds: readonly string[],
  current: ReadonlySet<string>,
  taskId: string,
  options: TaskSelectionOptions = {},
): Set<string> {
  const next = options.additive ? new Set(current) : new Set<string>();
  const anchorIndex = options.anchorId === undefined ? -1 : taskIds.indexOf(options.anchorId);
  const taskIndex = taskIds.indexOf(taskId);

  if (anchorIndex >= 0 && taskIndex >= 0) {
    const start = Math.min(anchorIndex, taskIndex);
    const end = Math.max(anchorIndex, taskIndex);
    for (const id of taskIds.slice(start, end + 1)) next.add(id);
    return next;
  }

  if (options.additive) {
    if (next.has(taskId)) next.delete(taskId);
    else next.add(taskId);
    return next;
  }

  next.add(taskId);
  return next;
}

export type BulkTaskAction = "retry" | "abandon" | "delete";