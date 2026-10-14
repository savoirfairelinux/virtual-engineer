import { Icon } from "../../components/Icon.tsx";
import { StatePill } from "../../components/StatePill.tsx";
import { Tag } from "../../components/Tag.tsx";
import { ProviderGlyph } from "../../components/ProviderGlyph.tsx";
import { classifyWorkflowBucket, isActiveState } from "../../states.ts";
import { relativeTime } from "../../api.ts";
import type { ApiTask, TaskType, TaskWorkflowBucket } from "../../types.ts";

const FILTERS: { id: "all" | TaskWorkflowBucket; label: string }[] = [
  { id: "all",      label: "All" },
  { id: "active",   label: "Active" },
  { id: "watching", label: "Watching" },
  { id: "done",     label: "Done" },
  { id: "failed",   label: "Failed" },
];

const TASK_TYPES: { id: "all" | TaskType; label: string }[] = [
  { id: "all", label: "All" },
  { id: "code-gen", label: "Coding" },
  { id: "code-review", label: "Review" },
];

export interface TaskListFilters {
  statuses: readonly TaskWorkflowBucket[];
  taskType: "all" | TaskType;
  queuedOnly: boolean;
  query: string;
}

export const DEFAULT_TASK_FILTERS: TaskListFilters = {
  statuses: [],
  taskType: "all",
  queuedOnly: false,
  query: "",
};

interface TaskRowProps {
  task: ApiTask;
  selected: boolean;
  onClick: () => void;
}

function TaskRow({ task, selected, onClick }: TaskRowProps) {
  const running = isActiveState(task.state);
  const primaryLink = task.ticketUrl ?? task.reviewUrl;
  return (
    <div
      style={{
        position: "relative", width: "100%", textAlign: "left", cursor: "pointer",
        borderLeft: `2px solid ${selected ? "var(--accent)" : "transparent"}`,
        background: selected ? "var(--panel-2)" : "transparent",
        padding: `${11 * (1)}px 14px`,
        display: "flex", flexDirection: "column", gap: "7px",
        borderBottom: "1px solid var(--border-soft)",
        transition: "background 0.12s var(--ease)", color: "inherit",
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "color-mix(in oklab, var(--panel-2) 55%, transparent)"; }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
    >
      <button
        type="button"
        aria-label={`Inspect task ${task.ticketTitle || task.ticketId}`}
        onClick={onClick}
        style={{ position: "absolute", inset: 0, zIndex: 1, width: "100%", border: 0, background: "transparent", cursor: "pointer" }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
        <ProviderGlyph provider={task.ticketSourceLabel} size={22} />
        {primaryLink ? (
          <a
            href={primaryLink}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="mono"
            style={{ position: "relative", zIndex: 2, fontSize: "11px", color: "var(--accent-strong)", textDecoration: "none" }}
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
        {task.waitingForAgentSlot && <Tag tone="warn">Queued</Tag>}
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
  filters: TaskListFilters;
  onFiltersChange: (filters: TaskListFilters) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  compact?: boolean | undefined;
}

export function TaskList({ tasks, filters, onFiltersChange, selectedId, onSelect, compact = false }: TaskListProps) {
  const query = filters.query.toLowerCase();
  const matchingTasks = tasks.filter((t) => {
    if (filters.taskType !== "all" && t.taskType !== filters.taskType) return false;
    if (filters.queuedOnly && t.waitingForAgentSlot !== true) return false;
    if (query) {
      return (
        (t.ticketTitle ?? "").toLowerCase().includes(query) ||
        (t.ticketId ?? "").toLowerCase().includes(query) ||
        (t.displayId ?? "").toLowerCase().includes(query)
      );
    }
    return true;
  });
  const filtered = matchingTasks.filter((task) =>
    filters.statuses.length === 0 || filters.statuses.includes(classifyWorkflowBucket(task.state)));
  const hasFilters = filters.statuses.length > 0 || filters.taskType !== "all" || filters.queuedOnly || filters.query.length > 0;

  function toggleStatus(status: "all" | TaskWorkflowBucket): void {
    const statuses = status === "all" ? [] : filters.statuses.includes(status)
      ? filters.statuses.filter((selected) => selected !== status)
      : [...filters.statuses, status];
    onFiltersChange({ ...filters, statuses: statuses.length === FILTERS.length - 1 ? [] : statuses });
  }

  return (
    <div
      style={{
        width: compact ? "100%" : "340px", flex: compact ? 1 : "none",
        borderRight: "1px solid var(--border-soft)", background: "var(--rail)",
        display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0,
      }}
    >
      {/* header */}
      <div style={{ padding: "10px 14px 8px", borderBottom: "1px solid var(--border-soft)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
          <span className="eyebrow">Task queue</span>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <output aria-label="Task results" className="mono" style={{ fontSize: "11px", color: "var(--text-faint)" }}>
              {filtered.length}/{tasks.length}
            </output>
            <div style={{ width: "30px", height: "30px" }}>
              {hasFilters && (
                <button type="button" className="iconbtn" aria-label="Reset filters" title="Reset filters"
                  onClick={() => onFiltersChange(DEFAULT_TASK_FILTERS)}>
                  <Icon name="refresh" size={14} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* search */}
        <div style={{ position: "relative", marginBottom: "8px" }}>
          <Icon
            name="search" size={14}
            style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)", color: "var(--text-ghost)" }}
          />
          <input
            aria-label="Search tasks"
            value={filters.query}
            onChange={(e) => onFiltersChange({ ...filters, query: e.target.value })}
            placeholder="Filter by title or #id"
            style={{
              width: "100%",
              background: "var(--panel)", border: "1px solid var(--border-soft)",
              borderRadius: "var(--radius-sm)", color: "var(--text)",
              fontFamily: "var(--font-sans)", fontSize: "12px",
              padding: "5px 10px 5px 30px",
            }}
          />
        </div>

        <div role="group" aria-label="Task type" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "2px", minWidth: 0, marginBottom: "6px" }}>
          {TASK_TYPES.map((type) => (
            <button key={type.id} type="button" className="btn sm" aria-pressed={filters.taskType === type.id}
              onClick={() => onFiltersChange({ ...filters, taskType: type.id })}
              style={{
                justifyContent: "center", minWidth: 0, height: "24px", fontSize: "11px", lineHeight: 1, padding: "2px 6px",
                borderColor: filters.taskType === type.id ? "var(--accent-line)" : "var(--border-soft)",
                background: filters.taskType === type.id ? "var(--accent-soft)" : "transparent",
                color: filters.taskType === type.id ? "var(--accent-strong)" : "var(--text-faint)",
              }}>
              {type.label}
            </button>
          ))}
        </div>

        <div role="group" aria-label="Workflow status" style={{ display: "grid", gridTemplateColumns: "0.65fr 1fr 1.4fr 0.9fr 0.95fr 1fr", gap: "3px" }}>
          {[...FILTERS, { id: "queued", label: "Queued" } as const].map((filter) => {
            const selected = filter.id === "queued" ? filters.queuedOnly
              : filter.id === "all" ? filters.statuses.length === 0 : filters.statuses.includes(filter.id);
            return (
              <button key={filter.id} type="button" aria-label={filter.id === "queued" ? "Queued only" : filter.label} aria-pressed={selected}
                title={filter.id === "queued" ? "Queued only" : undefined}
                onClick={() => filter.id === "queued"
                  ? onFiltersChange({ ...filters, queuedOnly: !filters.queuedOnly })
                  : toggleStatus(filter.id)}
                style={{
                  border: `1px solid ${selected ? "var(--accent-line)" : "var(--border-soft)"}`,
                  background: selected ? "var(--accent-soft)" : "transparent",
                  color: selected ? "var(--accent-strong)" : "var(--text-faint)",
                  display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 0, height: "24px", whiteSpace: "nowrap",
                  fontSize: "10.5px", fontWeight: 500, lineHeight: 1, padding: "2px 2px",
                  borderRadius: "var(--radius-sm)", cursor: "pointer", transition: "all 0.13s var(--ease)",
                }}>
                {filter.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* list */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {filtered.length === 0 ? (
          <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-faint)", fontSize: "13px" }}>
            No tasks match the current filters.
            {hasFilters && (
              <button type="button" className="btn sm" style={{ display: "flex", margin: "12px auto 0" }}
                onClick={() => onFiltersChange(DEFAULT_TASK_FILTERS)}>
                <Icon name="refresh" size={14} /> Clear all filters
              </button>
            )}
          </div>
        ) : (
          filtered.map((t) => (
            <TaskRow
              key={t.taskId} task={t}
              selected={t.taskId === selectedId}
              onClick={() => onSelect(t.taskId)}
            />
          ))
        )}
      </div>
    </div>
  );
}
