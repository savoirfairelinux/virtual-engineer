import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { StatePill } from "../../components/StatePill.tsx";
import { Tag } from "../../components/Tag.tsx";
import { Meta } from "../../components/Meta.tsx";
import { Tabs, TabPanel } from "../../components/Tabs.tsx";
import { ProviderGlyph } from "../../components/ProviderGlyph.tsx";
import { StatePipeline } from "./StatePipeline.tsx";
import { AgentCycles } from "./AgentCycles.tsx";
import { StateTimeline } from "./StateTimeline.tsx";
import { LiveLogs } from "./LiveLogs.tsx";
import { sumCycleCosts, formatUsd } from "./costFormat.ts";
import { api } from "../../api.ts";
import { isActiveState, isTerminalState } from "../../states.ts";
import type { ApiTask, ApiCycle, ApiTransition } from "../../types.ts";

interface TaskDetailProps {
  task: ApiTask;
  onRefresh: () => void;
  onDeleted: () => void;
}

type TabId = "cycles" | "timeline" | "logs";

export function TaskDetail({ task, onRefresh, onDeleted }: TaskDetailProps) {
  const [tab, setTab] = useState<TabId>("cycles");
  const [taskDetails, setTaskDetails] = useState<ApiTask | null>(null);
  const [cycles, setCycles] = useState<ApiCycle[] | null>(null);
  const [transitions, setTransitions] = useState<ApiTransition[] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadDetails = useCallback((id: string, fallbackTask: ApiTask) => {
    void api.get<{ task: ApiTask }>(`/api/admin/tasks/${id}`)
      .then((r) => setTaskDetails(r.task))
      .catch(() => setTaskDetails(fallbackTask));
    void api.get<{ cycles: ApiCycle[] }>(`/api/admin/tasks/${id}/cycles`)
      .then((r) => setCycles(r.cycles))
      .catch(() => setCycles([]));
    void api.get<{ transitions: ApiTransition[] }>(`/api/admin/tasks/${id}/transitions`)
      .then((r) => setTransitions(r.transitions))
      .catch(() => setTransitions([]));
  }, []);

  useEffect(() => {
    setTaskDetails(null);
    setCycles(null);
    setTransitions(null);
  }, [task.taskId]);

  useEffect(() => {
    loadDetails(task.taskId, task);
  }, [task.taskId, task.state, task.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps -- loadDetails is stable

  async function doAction(path: string, method: "PATCH" | "POST" | "DELETE") {
    setActionError(null);
    try {
      await api[method === "PATCH" ? "patch" : method === "POST" ? "post" : "delete"](path);
      if (method === "DELETE") {
        onDeleted();
      } else {
        loadDetails(task.taskId, task);
      }
      onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed");
    }
  }

  const displayTitle = task.ticketTitle || task.displayId || task.taskId;
  const sourceLabel  = task.ticketSourceLabel.toUpperCase();
  const taskWithDetails = taskDetails ?? task;
  const running   = isActiveState(taskWithDetails.state);
  const terminal  = isTerminalState(taskWithDetails.state);
  const loadedCycleCount = cycles ? Math.max(cycles.length, ...cycles.map((cycle) => cycle.cycleNumber)) : 0;
  const effectiveCycleCount = Math.max(taskWithDetails.cycleCount, loadedCycleCount);
  const repoReviewLinks = (taskWithDetails.changesPerRepo ?? []).filter((c) => typeof c.reviewUrl === "string" && c.reviewUrl.length > 0);
  const primaryLink = taskWithDetails.ticketUrl ?? taskWithDetails.reviewUrl;
  const footerRefLabel = taskWithDetails.taskType === "code-review"
    ? (taskWithDetails.gerritChangeId ?? taskWithDetails.displayId ?? taskWithDetails.ticketId)
    : (taskWithDetails.displayId ?? taskWithDetails.ticketId);

  const costTotals = cycles ? sumCycleCosts(cycles) : null;
  const costValue = costTotals && costTotals.usd > 0
    ? `${costTotals.priced ? "" : "~"}${formatUsd(costTotals.usd)}`
    : "—";

  const metaCells = [
    { label: "Type",        value: task.taskType === "code-review" ? "Code review" : "Code generation", mono: false },
    { label: "Patchset",    value: String(taskWithDetails.currentPatchset || "—"),    mono: true },
    { label: "Total cost",  value: costValue,                                          mono: true },
    { label: "Reviewed PS", value: String(taskWithDetails.reviewedPatchset ?? "—"),    mono: true },
    { label: "Cycles",      value: String(effectiveCycleCount),                        mono: true },
    { label: "Ticket",      value: task.displayId ?? task.ticketId,                    mono: true },
    { label: "Updated",     value: new Date(taskWithDetails.updatedAt).toLocaleString(), mono: true },
  ];

  const tabItems = [
    { id: "cycles",   label: "Agent cycles",  count: cycles?.length ?? taskWithDetails.cycleCount },
    { id: "timeline", label: "State timeline", count: transitions?.length ?? null },
    { id: "logs",     label: "Live logs" },
  ];

  return (
    <div key={task.taskId} className="fade-up" style={{ flex: 1, overflowY: "auto", minWidth: 0, padding: "20px 24px 28px" }}>
      <div style={{ maxWidth: "1080px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "16px" }}>

        {/* header card */}
        <div className="card" style={{ padding: "20px 22px" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: "16px" }}>
            <ProviderGlyph provider={task.ticketSourceLabel} size={40} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "9px", marginBottom: "6px" }}>
                {primaryLink ? (
                  <a
                    href={primaryLink}
                    target="_blank"
                    rel="noreferrer"
                    className="mono"
                    style={{ fontSize: "11.5px", color: "var(--accent-strong)", textDecoration: "none" }}
                    title="Open task/review"
                  >
                    {sourceLabel} · #{task.displayId ?? task.ticketId}
                  </a>
                ) : (
                  <span className="mono" style={{ fontSize: "11.5px", color: "var(--text-faint)" }}>
                    {sourceLabel} · #{task.displayId ?? task.ticketId}
                  </span>
                )}
              </div>
              <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 600, lineHeight: 1.3, letterSpacing: "-0.01em" }}>
                {displayTitle}
              </h1>
              {taskWithDetails.gerritChangeId && (
                <div className="mono" style={{ fontSize: "11.5px", color: "var(--text-faint)", marginTop: "8px", display: "flex", gap: "8px", alignItems: "center" }}>
                  <Icon name="link" size={12} />
                  <span>Change-Id: {taskWithDetails.gerritChangeId}</span>
                </div>
              )}
              {repoReviewLinks.length > 0 && (
                <div style={{ marginTop: "9px", display: "flex", flexWrap: "wrap", gap: "8px" }}>
                  {repoReviewLinks.map((change) => (
                    <a
                      key={`${change.repoKey}:${change.changeId}:${change.commitIndex}`}
                      href={change.reviewUrl as string}
                      target="_blank"
                      rel="noreferrer"
                      className="mono"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "5px",
                        fontSize: "10.5px",
                        color: "var(--text-dim)",
                        border: "1px solid var(--border-soft)",
                        borderRadius: "99px",
                        padding: "3px 9px",
                        textDecoration: "none",
                        background: "var(--panel-2)",
                      }}
                      title={`Open review for ${change.repoKey}`}
                    >
                      <Icon name="link" size={11} />
                      {change.repoKey}
                    </a>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "12px" }}>
              <StatePill state={taskWithDetails.state} />
              {/* action bar */}
              <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                {running && (
                  <button className="iconbtn danger" title="Abandon" onClick={() => void doAction(`/api/admin/tasks/${task.taskId}/abandon`, "POST")}><Icon name="x" size={15} /></button>
                )}
                {!terminal && !running && (
                  <>
                    <button className="iconbtn" title="Retry" onClick={() => void doAction(`/api/admin/tasks/${task.taskId}/retry`, "POST")}><Icon name="refresh" size={15} /></button>
                    <button className="iconbtn danger" title="Abandon" onClick={() => void doAction(`/api/admin/tasks/${task.taskId}/abandon`, "POST")}><Icon name="x" size={15} /></button>
                  </>
                )}
                {terminal && taskWithDetails.state !== "MERGED" && (
                  <button className="iconbtn" title="Retry" onClick={() => void doAction(`/api/admin/tasks/${task.taskId}/retry`, "POST")}><Icon name="refresh" size={15} /></button>
                )}
                <div style={{ width: 1, height: 20, background: "var(--border-soft)", margin: "0 3px" }} />
                <button
                  className="iconbtn danger"
                  title="Delete task"
                  onClick={() => void doAction(`/api/admin/tasks/${task.taskId}`, "DELETE")}
                >
                  <Icon name="trash" size={15} />
                </button>
              </div>
            </div>
          </div>

          {/* state pipeline */}
          <div style={{ marginTop: "10px", borderTop: "1px solid var(--border-soft)", paddingTop: "4px" }}>
            <StatePipeline task={taskWithDetails} />
          </div>
        </div>

        {/* meta strip */}
        <div className="card" style={{ display: "grid", gridTemplateColumns: `repeat(${metaCells.length}, 1fr)`, padding: 0 }}>
          {metaCells.map((m, i) => (
            <div key={m.label} style={{ padding: "14px 16px", borderRight: i < metaCells.length - 1 ? "1px solid var(--border-soft)" : "none" }}>
              <Meta label={m.label} mono={m.mono}>{m.value}</Meta>
            </div>
          ))}
        </div>

        {/* failure banner */}
        {taskWithDetails.failureReason && (
          <div
            style={{
              display: "flex", gap: "11px", alignItems: "center", padding: "12px 16px",
              borderRadius: "var(--radius)", background: "var(--danger-soft)",
              border: "1px solid color-mix(in oklab,var(--danger) 30%, transparent)",
            }}
          >
            <Icon name="alert" size={16} style={{ color: "var(--danger)", flex: "none" }} />
            <div>
              <span className="eyebrow" style={{ color: "var(--danger)" }}>Failure reason</span>
              <div className="mono" style={{ fontSize: "12.5px", color: "var(--text)", marginTop: "2px" }}>
                {taskWithDetails.failureReason}
              </div>
            </div>
          </div>
        )}

        {actionError && (
          <div style={{ color: "var(--danger)", fontSize: "12.5px", padding: "8px 0" }}>
            {actionError}
          </div>
        )}

        {/* tabs */}
        <div style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--border-soft)", paddingBottom: "10px" }}>
          <Tabs tabs={tabItems} value={tab} onChange={(id) => setTab(id as TabId)} />
        </div>

        {/* tab body */}
        <TabPanel>
          {tab === "cycles" && (
            cycles === null
              ? <div style={{ color: "var(--text-faint)", fontSize: "13px" }}>Loading…</div>
              : cycles.length === 0
                ? <div className="placeholder" style={{ minHeight: "120px" }}>No agent cycles yet.</div>
                : <AgentCycles key={cycles.length} cycles={cycles} />
          )}
          {tab === "timeline" && (
            transitions === null
              ? <div style={{ color: "var(--text-faint)", fontSize: "13px" }}>Loading…</div>
              : <div className="card" style={{ padding: "16px 20px" }}><StateTimeline transitions={transitions} /></div>
          )}
          {tab === "logs" && (
            <LiveLogs key={effectiveCycleCount} taskId={task.taskId} running={running} />
          )}
        </TabPanel>

        <Tag tone="info" mono={false}>
          {task.taskType === "code-review" ? "review" : "task"}: {footerRefLabel}
        </Tag>

      </div>
    </div>
  );
}
