import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Icon } from "../../components/Icon.tsx";
import { StatePill } from "../../components/StatePill.tsx";
import { ProviderGlyph } from "../../components/ProviderGlyph.tsx";
import { isActiveState } from "../../states.ts";
import { relativeTime } from "../../api.ts";
import type { ApiTask, TaskState } from "../../types.ts";
import { selectTaskIds, type BulkTaskAction } from "./taskSelection.ts";

const FILTERS: { id: string; label: string; states?: TaskState[] }[] = [
  { id: "all",      label: "All" },
  { id: "active",   label: "Active",   states: ["AGENT_RUNNING", "REVIEW_RUNNING", "CONTEXT_BUILDING", "FEEDBACK_PROCESSING", "RETRY_CYCLE", "REVIEW_COMMENTING"] },
  { id: "watching", label: "Watching", states: ["REVIEW_WATCHING", "IN_REVIEW", "REVIEW_PENDING", "DETECTED"] },
  { id: "done",     label: "Done",     states: ["DONE", "MERGED", "REVIEW_DONE"] },
  { id: "failed",   label: "Failed",   states: ["FAILED", "REVIEW_FAILED", "ABANDONED"] },
];

interface TaskRowProps {
  task: ApiTask;
  selected: boolean;
  checked: boolean;
  onClick: (event: MouseEvent<HTMLDivElement>) => void;
  onActivate: () => void;
  onMouseDown: (event: MouseEvent<HTMLDivElement>) => void;
  onMouseEnter: () => void;
  onMouseUp: () => void;
  onToggle: () => void;
}

function TaskRow({ task, selected, checked, onClick, onActivate, onMouseDown, onMouseEnter, onMouseUp, onToggle }: TaskRowProps) {
  const running = isActiveState(task.state);
  const primaryLink = task.ticketUrl ?? task.reviewUrl;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate();
        }
      }}
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
      onMouseUp={onMouseUp}
      style={{
        width: "100%", textAlign: "left", border: "none", cursor: "pointer",
        borderLeft: `2px solid ${checked || selected ? "var(--accent)" : "transparent"}`,
        background: checked ? "var(--accent-soft)" : selected ? "var(--panel-2)" : "transparent",
        padding: `${11 * (1)}px 14px`,
        display: "flex", flexDirection: "column", gap: "7px",
        borderBottom: "1px solid var(--border-soft)",
        transition: "background 0.12s var(--ease)", color: "inherit",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
        <input
          type="checkbox"
          checked={checked}
          aria-label={`Select ${task.ticketTitle || task.ticketId}`}
          onChange={(event) => { event.stopPropagation(); onToggle(); }}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          style={{ width: "14px", height: "14px", flex: "none", accentColor: "var(--accent)" }}
        />
        <ProviderGlyph provider={task.ticketSourceLabel} size={22} />
        {primaryLink ? (
          <a
            href={primaryLink}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            className="mono"
            style={{ fontSize: "11px", color: "var(--accent-strong)", textDecoration: "none" }}
            title="Open task/review"
          >
            {task.ticketSourceLabel.toUpperCase()} #{task.displayId ?? task.ticketId}
          </a>
        ) : (
          <span className="mono" style={{ fontSize: "11px", color: "var(--text-faint)" }}>
            {task.ticketSourceLabel.toUpperCase()} #{task.displayId ?? task.ticketId}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {running && <span className="live-dot" style={{ width: 6, height: 6, borderRadius: 99, background: "var(--accent-strong)" }} />}
      </div>
      <div
        style={{
          fontSize: "13px", fontWeight: 500, lineHeight: 1.35,
          color: selected ? "var(--text)" : "var(--text-dim)",
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
        }}
      >
        {task.ticketTitle || task.ticketId}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <StatePill state={task.state} size="sm" />
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: "10px", color: "var(--text-ghost)" }}>
          {relativeTime(task.updatedAt)}
        </span>
      </div>
    </div>
  );
}

interface TaskListProps {
  tasks: ApiTask[];
  selectedId: string | null;
  selectedIds: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onSelectionChange: (ids: Set<string>) => void;
  onBulkAction: (action: BulkTaskAction, taskIds: string[]) => void;
  canOperate: boolean;
  bulkBusy: boolean;
  bulkError: string | null;
}

export function TaskList({ tasks, selectedId, selectedIds, onSelect, onSelectionChange, onBulkAction, canOperate, bulkBusy, bulkError }: TaskListProps) {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const anchorIdRef = useRef<string | undefined>(undefined);
  const draggingRef = useRef(false);
  const dragMovedRef = useRef(false);
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;

  useEffect(() => {
    const stopDragging = () => { draggingRef.current = false; };
    window.addEventListener("mouseup", stopDragging);
    return () => window.removeEventListener("mouseup", stopDragging);
  }, []);

  const filtered = tasks.filter((t) => {
    const f = FILTERS.find((x) => x.id === filter);
    if (f?.states && !f.states.includes(t.state)) return false;
    if (query) {
      const q = query.toLowerCase();
      return (
        (t.ticketTitle ?? "").toLowerCase().includes(q) ||
        (t.ticketId ?? "").toLowerCase().includes(q) ||
        (t.displayId ?? "").toLowerCase().includes(q)
      );
    }
    return true;
  });
  const filteredIds = filtered.map((task) => task.taskId);

  function selectWithGesture(taskId: string, event: MouseEvent<HTMLDivElement>): void {
    if (dragMovedRef.current) {
      dragMovedRef.current = false;
      return;
    }
    const additive = event.ctrlKey || event.metaKey;
    const anchorId = anchorIdRef.current;
    onSelectionChange(selectTaskIds(
      filteredIds,
      selectedIdsRef.current,
      taskId,
      {
        additive,
        ...(event.shiftKey && anchorId !== undefined ? { anchorId } : {}),
      },
    ));
    if (!event.shiftKey || anchorId === undefined) anchorIdRef.current = taskId;
    onSelect(taskId);
  }

  function startDrag(taskId: string, event: MouseEvent<HTMLDivElement>): void {
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    draggingRef.current = true;
    dragMovedRef.current = false;
    anchorIdRef.current = taskId;
    onSelectionChange(selectTaskIds(filteredIds, selectedIdsRef.current, taskId));
    onSelect(taskId);
  }

  function extendDrag(taskId: string): void {
    if (!draggingRef.current) return;
    const anchorId = anchorIdRef.current;
    if (anchorId === undefined || anchorId === taskId) return;
    dragMovedRef.current = true;
    onSelectionChange(selectTaskIds(filteredIds, selectedIdsRef.current, taskId, { anchorId }));
  }

  function toggleTask(taskId: string): void {
    anchorIdRef.current = taskId;
    onSelectionChange(selectTaskIds(filteredIds, selectedIdsRef.current, taskId, { additive: true }));
  }

  function activateTask(taskId: string): void {
    anchorIdRef.current = taskId;
    onSelectionChange(new Set([taskId]));
    onSelect(taskId);
  }

  return (
    <div
      style={{
        width: "340px", flex: "none",
        borderRight: "1px solid var(--border-soft)", background: "var(--rail)",
        display: "flex", flexDirection: "column", minHeight: 0,
      }}
    >
      {/* header */}
      <div style={{ padding: "13px 14px 10px", borderBottom: "1px solid var(--border-soft)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "11px" }}>
          <span className="eyebrow">Task queue</span>
          <span className="mono" style={{ fontSize: "11px", color: "var(--text-faint)" }}>
            {filtered.length}/{tasks.length}
          </span>
        </div>

        {/* search */}
        <div style={{ position: "relative", marginBottom: "10px" }}>
          <Icon
            name="search" size={14}
            style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)", color: "var(--text-ghost)" }}
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by title or #id"
            style={{
              width: "100%",
              background: "var(--panel)", border: "1px solid var(--border-soft)",
              borderRadius: "var(--radius-sm)", color: "var(--text)",
              fontFamily: "var(--font-sans)", fontSize: "12.5px",
              padding: "7px 10px 7px 30px", outline: "none",
            }}
          />
        </div>

        {/* filter chips */}
        <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              style={{
                border: `1px solid ${filter === f.id ? "var(--accent-line)" : "var(--border-soft)"}`,
                background: filter === f.id ? "var(--accent-soft)" : "transparent",
                color: filter === f.id ? "var(--accent-strong)" : "var(--text-faint)",
                fontSize: "11.5px", fontWeight: 500, padding: "4px 10px",
                borderRadius: "99px", cursor: "pointer", transition: "all 0.13s var(--ease)",
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        {selectedIds.size > 0 && (
          <div style={{ marginTop: "10px", paddingTop: "10px", borderTop: "1px solid var(--border-soft)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
              <span className="mono" style={{ flex: 1, fontSize: "11px", color: "var(--text-faint)" }}>
                {selectedIds.size} selected
              </span>
              {canOperate && (
                <>
                  <button className="iconbtn" type="button" title="Retry selected tasks" aria-label="Retry selected tasks" disabled={bulkBusy} onClick={() => onBulkAction("retry", [...selectedIds])}>
                    <Icon name="refresh" size={14} />
                  </button>
                  <button className="iconbtn danger" type="button" title="Abandon selected tasks" aria-label="Abandon selected tasks" disabled={bulkBusy} onClick={() => onBulkAction("abandon", [...selectedIds])}>
                    <Icon name="x" size={14} />
                  </button>
                  <button className="iconbtn danger" type="button" title="Delete selected tasks" aria-label="Delete selected tasks" disabled={bulkBusy} onClick={() => onBulkAction("delete", [...selectedIds])}>
                    <Icon name="trash" size={14} />
                  </button>
                </>
              )}
              <button className="iconbtn" type="button" title="Clear task selection" aria-label="Clear task selection" disabled={bulkBusy} onClick={() => onSelectionChange(new Set())}>
                <Icon name="x" size={14} />
              </button>
            </div>
            {bulkError && <div style={{ marginTop: "7px", color: "var(--danger)", fontSize: "11px" }}>{bulkError}</div>}
          </div>
        )}
      </div>

      {/* list */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {filtered.length === 0 ? (
          <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-faint)", fontSize: "13px" }}>
            No tasks match the current filters.
          </div>
        ) : (
          filtered.map((t) => (
            <TaskRow
              key={t.taskId} task={t}
              selected={t.taskId === selectedId}
              checked={selectedIds.has(t.taskId)}
              onClick={(event) => selectWithGesture(t.taskId, event)}
              onActivate={() => activateTask(t.taskId)}
              onMouseDown={(event) => startDrag(t.taskId, event)}
              onMouseEnter={() => extendDrag(t.taskId)}
              onMouseUp={() => { draggingRef.current = false; }}
              onToggle={() => toggleTask(t.taskId)}
            />
          ))
        )}
      </div>
    </div>
  );
}
