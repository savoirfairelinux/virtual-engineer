import { TaskList } from "./TaskList.tsx";
import { TaskDetail } from "./TaskDetail.tsx";
import type { ApiTask } from "../../types.ts";

interface TasksViewProps {
  tasks: ApiTask[];
  /** Currently-selected task id (from the URL hash route), or null to default to the first task. */
  selectedId: string | null;
  /** Called when the user selects a task; the parent updates the hash route. */
  onSelect: (id: string) => void;
}

export function TasksView({ tasks, selectedId, onSelect }: TasksViewProps) {
  // A task id in the URL must resolve to that exact task — never silently fall
  // back to a different one (that would break the deep-link contract). Only
  // default to the first task when no id is selected.
  const selectedTask = selectedId !== null ? tasks.find((t) => t.taskId === selectedId) ?? null : null;
  const task = selectedId === null ? (tasks[0] ?? null) : selectedTask;
  // Distinguish a genuinely-missing deep link from the initial loading window
  // (tasks empty) so we don't flash “not found” before the list arrives.
  const notFound = selectedId !== null && selectedTask === null && tasks.length > 0;

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      <TaskList tasks={tasks} selectedId={task?.taskId ?? null} onSelect={onSelect} />
      {task ? (
        <TaskDetail task={task} />
      ) : (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-ghost)", fontSize: "13px" }}>
          {notFound
            ? `Task ${selectedId} was not found — it may have been deleted.`
            : "Select a task to inspect its cycles and timeline."}
        </div>
      )}
    </div>
  );
}
