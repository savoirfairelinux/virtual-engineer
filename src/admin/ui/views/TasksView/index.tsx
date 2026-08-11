import { useEffect, useRef, useState } from "react";
import { TaskList } from "./TaskList.tsx";
import { TaskDetail } from "./TaskDetail.tsx";
import { shouldClearDeletedTask } from "./taskDetailRequests.ts";
import type { ApiTask } from "../../types.ts";

interface TasksViewProps {
  tasks: ApiTask[];
  onRefresh: () => void;
}

export function TasksView({ tasks, onRefresh }: TasksViewProps) {
  const [selectedId, setSelectedId] = useState<string>(() => {
    const part = window.location.hash.split("/")[1] ?? "";
    return tasks.find((t) => t.taskId === part)?.taskId ?? tasks[0]?.taskId ?? "";
  });

  const tasksRef = useRef(tasks);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);

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
    if (!shouldClearDeletedTask(deletedTaskId, selectedIdRef.current)) return;
    setSelectedId("");
    window.location.hash = "tasks";
  }

  const task = selectedId ? tasks.find((t) => t.taskId === selectedId) ?? null : null;

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      <TaskList tasks={tasks} selectedId={selectedId} onSelect={handleSelect} />
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
