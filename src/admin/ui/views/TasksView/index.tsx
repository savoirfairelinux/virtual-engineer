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
  const task = tasks.find((t) => t.taskId === selectedId) ?? tasks[0] ?? null;

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      <TaskList tasks={tasks} selectedId={task?.taskId ?? null} onSelect={onSelect} />
      {task ? (
        <TaskDetail task={task} />
      ) : (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-ghost)", fontSize: "13px" }}>
          Select a task to inspect its cycles and timeline.
        </div>
      )}
    </div>
  );
}
