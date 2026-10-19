import { useEffect, useRef, useState } from "react";
import { TaskList, taskFiltersFromHash, taskMatchesStatusFilters } from "./TaskList.tsx";
import type { TaskListFilters } from "./TaskList.tsx";
import { TaskDetail } from "./TaskDetail.tsx";
import { shouldClearDeletedTask } from "./taskDetailRequests.ts";
import type { ApiTask } from "../../types.ts";

interface TasksViewProps {
  tasks: ApiTask[];
  onRefresh: () => void;
}

export function TasksView({ tasks, onRefresh }: TasksViewProps) {
  const [filters, setFilters] = useState<TaskListFilters>(() => taskFiltersFromHash(window.location.hash));
  const [compact, setCompact] = useState(() => window.matchMedia?.("(max-width: 700px)").matches ?? false);
  const [showCompactDetail, setShowCompactDetail] = useState(() => window.location.hash.startsWith("#tasks/"));
  const [selectedId, setSelectedId] = useState<string>(() => {
    const part = window.location.hash.split("/")[1] ?? "";
    const { statuses } = taskFiltersFromHash(window.location.hash);
    const firstVisible = tasks.find((t) => taskMatchesStatusFilters(t, statuses));
    return tasks.find((t) => t.taskId === part)?.taskId ?? firstVisible?.taskId ?? "";
  });

  const tasksRef = useRef(tasks);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);

  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 700px)");
    if (!media) return;
    const onChange = () => {
      setCompact(media.matches);
      if (media.matches) setShowCompactDetail(window.location.hash.startsWith("#tasks/"));
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (tasks.length === 0) return;
    if (selectedId && tasks.some((t) => t.taskId === selectedId)) return;
    const part = window.location.hash.split("/")[1] ?? "";
    const fromHash = tasks.find((t) => t.taskId === part)?.taskId;
    const id = fromHash ?? tasks[0]?.taskId ?? "";
    if (id) {
      setSelectedId(id);
      if (fromHash) setShowCompactDetail(true);
      else if (!compact) window.location.hash = `tasks/${id}`;
    }
  }, [compact, tasks, selectedId]);

  useEffect(() => {
    const onHashChange = () => {
      if (!window.location.hash.startsWith("#tasks")) return;
      const part = window.location.hash.split("/")[1] ?? "";
      const id = tasksRef.current.find((t) => t.taskId === part)?.taskId ?? "";
      if (id) setSelectedId(id);
      setShowCompactDetail(Boolean(id));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  function handleSelect(id: string) {
    setSelectedId(id);
    setShowCompactDetail(true);
    window.location.hash = `tasks/${id}`;
  }

  function handleDeleted(deletedTaskId: string) {
    if (!shouldClearDeletedTask(deletedTaskId, selectedIdRef.current)) return;
    setSelectedId("");
    window.location.hash = "tasks";
  }

  const task = selectedId ? tasks.find((t) => t.taskId === selectedId) ?? null : null;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: compact ? "column" : "row", minHeight: 0, minWidth: 0 }}>
      {(!compact || !showCompactDetail || !task) && (
        <TaskList tasks={tasks} filters={filters} onFiltersChange={setFilters} selectedId={selectedId} onSelect={handleSelect} compact={compact} />
      )}
      {task && (!compact || showCompactDetail) ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
          {compact && (
            <button className="btn ghost" style={{ alignSelf: "flex-start", margin: "8px 14px" }} onClick={() => {
              setShowCompactDetail(false);
              window.location.hash = "tasks";
            }}>Back to tasks</button>
          )}
          <TaskDetail task={task} onRefresh={onRefresh} onDeleted={handleDeleted} />
        </div>
      ) : !compact ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-ghost)", fontSize: "13px" }}>
          Select a task to inspect its cycles and timeline.
        </div>
      ) : null}
    </div>
  );
}
