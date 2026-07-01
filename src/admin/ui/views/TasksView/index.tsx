import { useState } from "react";
import { TaskList } from "./TaskList.tsx";
import { TaskDetail } from "./TaskDetail.tsx";
import type { ApiTask } from "../../types.ts";

interface TasksViewProps {
  tasks: ApiTask[];
  onRefresh: () => void;
}

export function TasksView({ tasks, onRefresh }: TasksViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(
    tasks.length > 0 ? (tasks[0]?.taskId ?? null) : null
  );
  const task = tasks.find((t) => t.taskId === selectedId) ?? tasks[0] ?? null;

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      <TaskList tasks={tasks} selectedId={selectedId} onSelect={setSelectedId} />
      {task ? (
        <TaskDetail task={task} onRefresh={onRefresh} />
      ) : (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-ghost)", fontSize: "13px" }}>
          Select a task to inspect its cycles and timeline.
        </div>
      )}
    </div>
  );
}
