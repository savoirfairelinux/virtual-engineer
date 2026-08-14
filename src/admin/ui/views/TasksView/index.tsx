import { useEffect, useRef, useState } from "react";
import { TaskList } from "./TaskList.tsx";
import { TaskDetail } from "./TaskDetail.tsx";
import { shouldClearDeletedTask } from "./taskDetailRequests.ts";
import { api } from "../../api.ts";
import { useCurrentUser } from "../../authContext.tsx";
import { BULK_ACTION_PAST_TENSE, type BulkTaskAction } from "./taskSelection.ts";
import type { ApiTask } from "../../types.ts";

interface TasksViewProps {
  tasks: ApiTask[];
  onRefresh: () => void;
}

export function TasksView({ tasks, onRefresh }: TasksViewProps) {
  const { canOperate } = useCurrentUser();
  const [selectedId, setSelectedId] = useState<string>(() => {
    const part = window.location.hash.split("/")[1] ?? "";
    return tasks.find((t) => t.taskId === part)?.taskId ?? tasks[0]?.taskId ?? "";
  });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const tasksRef = useRef(tasks);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);

  useEffect(() => {
    const availableIds = new Set(tasks.map((task) => task.taskId));
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => availableIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [tasks]);

  useEffect(() => {
    if (tasks.length === 0) return;
    if (selectedId && tasks.some((t) => t.taskId === selectedId)) return;
    const part = window.location.hash.split("/")[1] ?? "";
    const fromHash = tasks.find((t) => t.taskId === part)?.taskId;
    const id = fromHash ?? tasks[0]?.taskId ?? "";
    if (id) {
      setSelectedId(id);
      if (!fromHash) window.location.hash = `tasks/${id}`;
    }
  }, [tasks, selectedId]);

  useEffect(() => {
    const onHashChange = () => {
      if (!window.location.hash.startsWith("#tasks")) return;
      const part = window.location.hash.split("/")[1] ?? "";
      const id = tasksRef.current.find((t) => t.taskId === part)?.taskId ?? "";
      if (id) setSelectedId(id);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  function handleSelect(id: string) {
    setSelectedId(id);
    window.location.hash = `tasks/${id}`;
  }

  function handleDeleted(deletedTaskId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      next.delete(deletedTaskId);
      return next;
    });
    if (!shouldClearDeletedTask(deletedTaskId, selectedIdRef.current)) return;
    setSelectedId("");
    window.location.hash = "tasks";
  }

  async function handleBulkAction(action: BulkTaskAction, taskIds: string[]): Promise<void> {
    if (bulkBusy || taskIds.length === 0) return;
    const actionLabel = action === "retry" ? "retry" : action === "abandon" ? "abandon" : "delete";
    if (action !== "retry" && !window.confirm(`${actionLabel[0]?.toUpperCase() ?? actionLabel}${actionLabel.slice(1)} ${taskIds.length} selected task${taskIds.length === 1 ? "" : "s"}?`)) return;

    setBulkBusy(true);
    setBulkError(null);
    const results = await Promise.allSettled(taskIds.map((taskId) => {
      const path = `/api/admin/tasks/${taskId}/${action}`;
      return action === "delete" ? api.delete<void>(`/api/admin/tasks/${taskId}`) : api.post<void>(path);
    }));
    const completedIds: string[] = [];
    let failureCount = 0;
    let firstFailure: unknown;
    results.forEach((result, index) => {
      const taskId = taskIds[index];
      if (taskId === undefined) return;
      if (result.status === "fulfilled") completedIds.push(taskId);
      else {
        failureCount += 1;
        firstFailure ??= result.reason;
      }
    });
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const taskId of completedIds) next.delete(taskId);
      return next;
    });
    if (action === "delete" && completedIds.includes(selectedIdRef.current)) {
      setSelectedId("");
      window.location.hash = "tasks";
    }
    if (failureCount > 0) {
      const message = firstFailure instanceof Error ? firstFailure.message : "Operation failed";
        setBulkError(`${failureCount} task${failureCount === 1 ? "" : "s"} could not be ${BULK_ACTION_PAST_TENSE[action]}: ${message}`);
    }
    setBulkBusy(false);
    onRefresh();
  }

  const task = selectedId ? tasks.find((t) => t.taskId === selectedId) ?? null : null;

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      <TaskList
        tasks={tasks}
        selectedId={selectedId}
        selectedIds={selectedIds}
        onSelect={handleSelect}
        onSelectionChange={setSelectedIds}
        onBulkAction={(action, taskIds) => { void handleBulkAction(action, taskIds); }}
        canOperate={canOperate}
        bulkBusy={bulkBusy}
        bulkError={bulkError}
      />
      {task ? (
        <TaskDetail task={task} onRefresh={onRefresh} onDeleted={handleDeleted} />
      ) : (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-ghost)", fontSize: "13px" }}>
          Select a task to inspect its cycles and timeline.
        </div>
      )}
    </div>
  );
}
