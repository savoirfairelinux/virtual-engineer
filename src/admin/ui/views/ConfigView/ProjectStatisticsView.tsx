import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import { Drawer, StatusBanner } from "../../components/Drawer.tsx";
import { Tag } from "../../components/Tag.tsx";
import type {
  ApiModelUsageEntry,
  ApiProject,
  ApiProjectStatistics,
  TaskState,
  TaskWorkflowBucket,
} from "../../types.ts";

const PERIOD_OPTIONS: ReadonlyArray<{ label: string; days: number | null }> = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "All time", days: null },
];

const BUCKET_LABELS: Record<TaskWorkflowBucket, string> = {
  active: "Active",
  watching: "Watching",
  done: "Done",
  failed: "Failed",
};

const BUCKET_TONES: Record<TaskWorkflowBucket, "active" | "warn" | "ok" | "danger"> = {
  active: "active",
  watching: "warn",
  done: "ok",
  failed: "danger",
};

const STATE_ORDER: readonly TaskState[] = [
  "DETECTED",
  "CONTEXT_BUILDING",
  "AGENT_RUNNING",
  "IN_REVIEW",
  "FEEDBACK_PROCESSING",
  "RETRY_CYCLE",
  "MERGED",
  "CLOSING",
  "DONE",
  "FAILED",
  "ABANDONED",
  "REVIEW_PENDING",
  "REVIEW_RUNNING",
  "REVIEW_COMMENTING",
  "REVIEW_WATCHING",
  "REVIEW_DONE",
  "REVIEW_FAILED",
];

function formatUsd(value: number): string {
  if (value <= 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes >= 10 ? 0 : 1)}m`;
  const hours = minutes / 60;
  return `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
}

function labelForState(state: TaskState): string {
  return state
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/(^| )\S/g, (letter) => letter.toUpperCase());
}

function tokenSummary(
  tokens: ApiProjectStatistics["cost"]["totalTokens"],
  runsWithTokens: number,
  totalRuns: number,
): string {
  if (runsWithTokens === 0) return "No token usage reported";
  const summary = `${formatTokens(tokens.input)} in · ${formatTokens(tokens.output)} out`;
  return runsWithTokens < totalRuns
    ? `${summary} · ${totalRuns - runsWithTokens} run${totalRuns - runsWithTokens === 1 ? "" : "s"} without usage`
    : summary;
}

function Metric({ label, value, detail }: { label: string; value: ReactNode; detail?: string }) {
  return (
    <div className="project-stat-metric">
      <span className="project-stat-label">{label}</span>
      <strong className="project-stat-value mono">{value}</strong>
      {detail && <span className="project-stat-detail">{detail}</span>}
    </div>
  );
}

function Panel({ title, icon, children }: { title: string; icon: string; children: ReactNode }) {
  return (
    <section className="project-stat-panel">
      <header className="project-stat-panel-head">
        <span className="project-stat-panel-icon"><Icon name={icon} size={14} /></span>
        <h2>{title}</h2>
      </header>
      {children}
    </section>
  );
}

function BucketList({ buckets }: { buckets: Record<TaskWorkflowBucket, number> }) {
  return (
    <div className="project-stat-bucket-list">
      {(Object.keys(BUCKET_LABELS) as TaskWorkflowBucket[]).map((bucket) => (
        <div className="project-stat-bucket" key={bucket}>
          <Tag tone={BUCKET_TONES[bucket]} mono={false}>{BUCKET_LABELS[bucket]}</Tag>
          <strong className="mono">{formatCount(buckets[bucket])}</strong>
        </div>
      ))}
    </div>
  );
}

function StateList({ states }: { states: Record<TaskState, number> }) {
  const populated = STATE_ORDER.filter((state) => states[state] > 0);
  if (populated.length === 0) {
    return <div className="project-stat-empty">No tasks in this set.</div>;
  }
  return (
    <div className="project-stat-state-list">
      {populated.map((state) => (
        <div className="project-stat-state" key={state}>
          <span>{labelForState(state)}</span>
          <strong className="mono">{formatCount(states[state])}</strong>
        </div>
      ))}
    </div>
  );
}

function ModelList({ models }: { models: ApiModelUsageEntry[] }) {
  if (models.length === 0) {
    return <div className="project-stat-empty">No model usage recorded in this period.</div>;
  }
  return (
    <div className="project-stat-model-list">
      {models.map((model) => (
        <div className="project-stat-model" key={`${model.modelId ?? "unknown"}:${model.workflowBucket}`}>
          <div style={{ minWidth: 0 }}>
            <strong>{model.modelId ?? "Unknown model"}</strong>
            <div className="project-stat-detail">
              {BUCKET_LABELS[model.workflowBucket]} · {formatCount(model.runCount)} run{model.runCount === 1 ? "" : "s"}
            </div>
          </div>
          <span className="mono">{formatUsd(model.usd)}</span>
        </div>
      ))}
    </div>
  );
}

export function ProjectStatisticsView({ project, onBack }: { project: ApiProject; onBack: () => void }) {
  const [days, setDays] = useState<number | null>(30);
  const [refreshKey, setRefreshKey] = useState(0);
  const [statistics, setStatistics] = useState<ApiProjectStatistics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const path = days === null
      ? `/api/admin/projects/${project.id}/statistics`
      : `/api/admin/projects/${project.id}/statistics?days=${days}`;
    void api.get<ApiProjectStatistics>(path)
      .then((data) => {
        if (!cancelled) setStatistics(data);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : "Unable to load project statistics");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [days, project.id, refreshKey]);

  const emptyPeriod = statistics !== null &&
    statistics.period.tasksCreated === 0 &&
    statistics.period.terminalTasks === 0 &&
    statistics.execution.cycles === 0 &&
    statistics.cost.totalRuns === 0;

  return (
    <Drawer
      eyebrow={`Project statistics · ${project.type}`}
      title={project.name}
      glyph={
        <span className="project-statistics-glyph">
          <Icon name="pulse" size={18} />
        </span>
      }
      onClose={onBack}
      footer={
        <>
          <button className="btn" onClick={onBack}>
            <Icon name="chevron" size={13} style={{ transform: "rotate(180deg)" }} /> Back to project
          </button>
          <span className="spacer" />
          <button className="btn" onClick={() => setRefreshKey((value) => value + 1)} disabled={loading}>
            <Icon name="refresh" size={13} /> Refresh
          </button>
        </>
      }
    >
      <div className="project-statistics" aria-busy={loading}>
        <div className="project-statistics-toolbar">
          <div>
            <div className="eyebrow">Activity window</div>
            <div className="project-statistics-subtitle">Current workload is live; execution metrics follow the selected period.</div>
          </div>
          <div className="project-stat-periods" role="group" aria-label="Statistics period">
            {PERIOD_OPTIONS.map((option) => (
              <button
                className={days === option.days ? "btn primary sm" : "btn sm"}
                key={option.label}
                aria-pressed={days === option.days}
                onClick={() => setDays(option.days)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {loading && statistics === null && <div className="placeholder" role="status">Loading project statistics…</div>}
        {error && statistics === null && (
          <div className="project-stat-error" role="alert">
            <StatusBanner tone="danger" icon="alert" title="Failed to load project statistics." sub={error} />
            <button className="btn" onClick={() => setRefreshKey((value) => value + 1)}>Retry</button>
          </div>
        )}
        {error && statistics !== null && <div className="project-stat-inline-error" role="alert">Refresh failed: {error}</div>}

        {statistics && (
          <>
            {emptyPeriod && (
              <StatusBanner
                tone="muted"
                icon="clock"
                title="No activity in this period"
                sub="The project has no created tasks, terminal outcomes, or agent cycles in the selected window."
              />
            )}

            <div className="project-stat-panel-grid">
              <Panel title="Current workload" icon="pulse">
                <div className="project-stat-metric-grid">
                  <Metric label="Tasks" value={formatCount(statistics.current.taskCount)} detail="all time" />
                  <Metric label="Active" value={formatCount(statistics.current.byBucket.active)} />
                  <Metric label="Watching" value={formatCount(statistics.current.byBucket.watching)} />
                  <Metric label="Done" value={formatCount(statistics.current.byBucket.done)} />
                  <Metric label="Failed" value={formatCount(statistics.current.byBucket.failed)} />
                </div>
                <BucketList buckets={statistics.current.byBucket} />
                <StateList states={statistics.current.byState} />
              </Panel>

              <Panel title="Period outcomes" icon="tasks">
                <div className="project-stat-metric-grid">
                  <Metric label="Created" value={formatCount(statistics.period.tasksCreated)} />
                  <Metric label="Terminal" value={formatCount(statistics.period.terminalTasks)} />
                  <Metric label="Completed" value={formatCount(statistics.period.terminalByBucket.done)} />
                  <Metric label="Failed" value={formatCount(statistics.period.terminalByBucket.failed)} />
                </div>
                <BucketList buckets={statistics.period.terminalByBucket} />
                <StateList states={statistics.period.terminalByState} />
              </Panel>

              <Panel title="Execution" icon="bolt">
                <div className="project-stat-metric-grid">
                  <Metric label="Cycles" value={formatCount(statistics.execution.cycles)} />
                  <Metric label="Tasks run" value={formatCount(statistics.execution.tasksWithCycles)} />
                  <Metric label="Retries" value={formatCount(statistics.execution.retryTasks)} />
                  <Metric label="Avg cycles / task" value={statistics.execution.averageCyclesPerTask === null ? "—" : statistics.execution.averageCyclesPerTask.toFixed(2)} />
                </div>
                <div className="project-stat-validation">
                  <span className="project-stat-label">Validation samples</span>
                  <div className="project-stat-validation-values">
                    <Tag tone="ok" mono={false}>Passed {statistics.execution.validation.passed}</Tag>
                    <Tag tone="danger" mono={false}>Failed {statistics.execution.validation.failed}</Tag>
                    <Tag tone="muted" mono={false}>Skipped {statistics.execution.validation.skipped}</Tag>
                  </div>
                </div>
              </Panel>

              <Panel title="Timing & concurrency" icon="clock">
                <div className="project-stat-metric-grid">
                  <Metric label="Avg to terminal" value={formatDuration(statistics.timing.averageSeconds)} detail={`${statistics.timing.samples} sample${statistics.timing.samples === 1 ? "" : "s"}`} />
                  <Metric label="Median to terminal" value={formatDuration(statistics.timing.medianSeconds)} />
                  <Metric label="Live concurrency" value={statistics.liveConcurrency === null ? "—" : `${statistics.liveConcurrency.active} live`} detail={statistics.liveConcurrency === null ? "unavailable" : "current snapshot"} />
                </div>
              </Panel>

              <Panel title="Cost & tokens" icon="spark">
                <div className="project-stat-metric-grid">
                  <Metric label="Cost" value={formatUsd(statistics.cost.totalUsd)} />
                  <Metric label="Runs" value={formatCount(statistics.cost.totalRuns)} />
                  <Metric label="AI credits" value={statistics.cost.totalAiCredits.toFixed(2)} />
                  <Metric label="Premium requests" value={formatCount(statistics.cost.totalPremiumRequests)} />
                </div>
                <div className="project-stat-token-summary">
                  <span className="project-stat-label">Usage coverage</span>
                  <span className="mono">{tokenSummary(statistics.cost.totalTokens, statistics.cost.totalRunsWithTokens, statistics.cost.totalRuns)}</span>
                </div>
              </Panel>

              <Panel title="Models" icon="grid">
                <ModelList models={statistics.models} />
              </Panel>
            </div>
          </>
        )}
      </div>
    </Drawer>
  );
}
