import { useEffect, useState } from "react";
import { Stat } from "../components/Stat.tsx";
import { Bars } from "../components/Bars.tsx";
import { Tag } from "../components/Tag.tsx";
import { StatePill } from "../components/StatePill.tsx";
import { ProviderGlyph } from "../components/ProviderGlyph.tsx";
import { Icon } from "../components/Icon.tsx";
import { TONE, STATES, isActiveState } from "../states.ts";
import { api } from "../api.ts";
import type { ApiOverview, ApiTask, ApiProvider, ApiCostSummary, ApiModelUsageSummary } from "../types.ts";

interface OverviewViewProps {
  overview: ApiOverview | null;
  tasks: ApiTask[];
  providers: ApiProvider[];
  activeIntegrationCount: number;
  pollingIntervalMs: number;
  onNavigate: (v: "tasks" | "config") => void;
}

function StateDistribution({ tasks }: { tasks: ApiTask[] }) {
  const counts: Record<string, number> = {};
  for (const t of tasks) {
    const meta = STATES[t.state];
    if (!meta) continue;
    counts[meta.tone] = (counts[meta.tone] ?? 0) + 1;
  }
  const order = ["active", "warn", "ok", "info", "danger", "muted"] as const;
  const labels: Record<string, string> = {
    active: "Running", warn: "Watching", ok: "Completed", info: "Queued", danger: "Failed", muted: "Abandoned",
  };
  const total = tasks.length;
  return (
    <div className="card" style={{ padding: "18px 20px", flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
        <span className="eyebrow">Task distribution</span>
        <span className="mono" style={{ fontSize: "11px", color: "var(--text-faint)" }}>{total} total</span>
      </div>
      {total === 0 ? (
        <div style={{ height: "10px", borderRadius: "99px", background: "var(--panel-2)", marginBottom: "18px" }} />
      ) : (
        <div style={{ display: "flex", height: "10px", borderRadius: "99px", overflow: "hidden", gap: "2px", marginBottom: "18px" }}>
          {order.map((o) => counts[o] ? (
            <div key={o} title={labels[o]} style={{ flex: counts[o], background: TONE[o].c, opacity: 0.9 }} />
          ) : null)}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 22px" }}>
        {order.filter((o) => counts[o]).map((o) => (
          <div key={o} style={{ display: "flex", alignItems: "center", gap: "9px" }}>
            <span style={{ width: 9, height: 9, borderRadius: 99, background: TONE[o].c, flex: "none" }} />
            <span style={{ fontSize: "12.5px", color: "var(--text-dim)", flex: 1 }}>{labels[o]}</span>
            <span className="mono metric-val" style={{ fontSize: "12.5px", fontWeight: 600 }}>{counts[o]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function VoteBreakdown({ votes }: { votes: ApiOverview["reviewVotes"] }) {
  const rows = [
    { k: "+2", v: votes.plus2,  tone: "ok" as const },
    { k: "+1", v: votes.plus1,  tone: "ok" as const },
    { k: "−1", v: votes.minus1, tone: "danger" as const },
    { k: "−2", v: votes.minus2, tone: "danger" as const },
  ];
  const max = Math.max(...rows.map((r) => r.v), 1);
  return (
    <div className="card" style={{ padding: "18px 20px", flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
        <span className="eyebrow">Review votes · 7d</span>
        <Icon name="comment" size={14} style={{ color: "var(--text-ghost)" }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "11px" }}>
        {rows.map((r) => (
          <div key={r.k} style={{ display: "flex", alignItems: "center", gap: "11px" }}>
            <span className="mono" style={{ width: "22px", fontSize: "12px", fontWeight: 600, color: TONE[r.tone].c }}>{r.k}</span>
            <div style={{ flex: 1, height: "8px", background: "var(--panel-2)", borderRadius: "99px", overflow: "hidden" }}>
              <div style={{ width: `${(r.v / max) * 100}%`, height: "100%", background: TONE[r.tone].c, opacity: 0.85, borderRadius: "99px" }} />
            </div>
            <span className="mono metric-val" style={{ width: "26px", textAlign: "right", fontSize: "12px", fontWeight: 600 }}>{r.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RuntimeFacts({ runtime }: { runtime: ApiOverview["runtime"] }) {
  const rows: [string, string][] = [
    ["Environment",   runtime.environment],
    ["Max cycles",    String(runtime.maxCycles)],
    ["Max retries",   String(runtime.maxRetries)],
    ["Polling",       runtime.pollingInterval],
    ["Uptime",        runtime.uptime],
    ["DB size",       runtime.dbSize],
  ];
  return (
    <div className="card" style={{ padding: "18px 20px", flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "14px" }}>
      <span className="eyebrow">Runtime</span>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", fontSize: "12.5px" }}>
          <span style={{ color: "var(--text-faint)", whiteSpace: "nowrap" }}>{k}</span>
          <span className="mono" style={{ fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap" }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

const COST_PERIODS: { label: string; days: number | null }[] = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "All", days: null },
];

const MODEL_PERIODS: { label: string; days: number | null }[] = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "All", days: null },
];

function formatUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

const MODEL_BAR_COLORS = [
  "var(--accent-strong)",
  TONE.ok.c,
  TONE.warn.c,
  TONE.info.c,
  TONE.danger.c,
  TONE.muted.c,
];

function modelLabel(modelId: string | null): string {
  return modelId ?? "unknown";
}

function CostSummaryCard() {
  const [days, setDays] = useState<number | null>(30);
  const [summary, setSummary] = useState<ApiCostSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    const path = days === null ? "/api/admin/cost-summary" : `/api/admin/cost-summary?days=${days}`;
    api
      .get<ApiCostSummary>(path)
      .then((data) => {
        if (!cancelled) setSummary(data);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const projects = summary
    ? summary.perProject.filter((p) => p.usd > 0 || p.runCount > 0)
    : [];
  const maxUsd = Math.max(...projects.map((p) => p.usd), 0.0001);

  return (
    <div className="card" style={{ padding: "18px 20px", flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px", gap: "10px" }}>
        <span className="eyebrow">AI cost</span>
        <div style={{ display: "flex", gap: "4px" }}>
          {COST_PERIODS.map((p) => (
            <button
              key={p.label}
              onClick={() => setDays(p.days)}
              className="mono"
              style={{
                cursor: "pointer",
                fontSize: "11px",
                fontWeight: 600,
                padding: "3px 8px",
                borderRadius: "6px",
                border: "1px solid var(--border)",
                background: days === p.days ? "var(--accent)" : "transparent",
                color: days === p.days ? "var(--accent-fg, #fff)" : "var(--text-faint)",
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div style={{ fontSize: "12.5px", color: "var(--text-faint)" }}>Failed to load cost summary.</div>
      ) : loading && !summary ? (
        <div style={{ fontSize: "12.5px", color: "var(--text-faint)" }}>Loading…</div>
      ) : summary ? (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: "10px", marginBottom: "4px" }}>
            <span className="mono" style={{ fontSize: "28px", fontWeight: 600, letterSpacing: "-0.02em" }}>
              {formatUsd(summary.totalUsd)}
            </span>
            <span style={{ fontSize: "12px", color: "var(--text-faint)" }}>instance total</span>
          </div>
          <div style={{ fontSize: "11.5px", color: "var(--text-faint)", marginBottom: "16px" }}>
            {summary.totalRuns} run{summary.totalRuns === 1 ? "" : "s"}
            {summary.totalAiCredits > 0 ? ` · ${summary.totalAiCredits.toFixed(2)} credits` : ""}
          </div>
          {projects.length === 0 ? (
            <div style={{ fontSize: "12.5px", color: "var(--text-faint)" }}>No recorded cost in this period.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "11px" }}>
              {projects.map((p) => (
                <div key={p.projectId ?? "__unassigned__"} style={{ display: "flex", alignItems: "center", gap: "11px" }}>
                  <span style={{ flex: "0 0 30%", fontSize: "12.5px", color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.projectName ?? (p.projectId ? p.projectId : "Unassigned")}
                  </span>
                  <div style={{ flex: 1, height: "8px", background: "var(--panel-2)", borderRadius: "99px", overflow: "hidden" }}>
                    <div style={{ width: `${(p.usd / maxUsd) * 100}%`, height: "100%", background: TONE.active.c, opacity: 0.85, borderRadius: "99px" }} />
                  </div>
                  <span className="mono metric-val" style={{ flex: "none", width: "62px", textAlign: "right", fontSize: "12px", fontWeight: 600 }}>
                    {formatUsd(p.usd)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function ModelUsageCard() {
  const [days, setDays] = useState<number | null>(30);
  const [summary, setSummary] = useState<ApiModelUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    const path = days === null ? "/api/admin/model-usage" : `/api/admin/model-usage?days=${days}`;
    api
      .get<ApiModelUsageSummary>(path)
      .then((data) => {
        if (!cancelled) setSummary(data);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const models = summary ? summary.byModel : [];
  const totalRuns = summary?.totalRuns ?? 0;
  const colorFor = (i: number): string => MODEL_BAR_COLORS[i % MODEL_BAR_COLORS.length] as string;
  const projects = summary
    ? summary.perProject.filter((p) => p.models.some((m) => m.runCount > 0))
    : [];

  return (
    <div className="card" style={{ padding: "18px 20px", flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px", gap: "10px" }}>
        <span className="eyebrow">Model usage</span>
        <div style={{ display: "flex", gap: "4px" }}>
          {MODEL_PERIODS.map((p) => (
            <button
              key={p.label}
              onClick={() => setDays(p.days)}
              className="mono"
              style={{
                cursor: "pointer",
                fontSize: "11px",
                fontWeight: 600,
                padding: "3px 8px",
                borderRadius: "6px",
                border: "1px solid var(--border)",
                background: days === p.days ? "var(--accent)" : "transparent",
                color: days === p.days ? "var(--accent-fg, #fff)" : "var(--text-faint)",
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div style={{ fontSize: "12.5px", color: "var(--text-faint)" }}>Failed to load model usage.</div>
      ) : loading && !summary ? (
        <div style={{ fontSize: "12.5px", color: "var(--text-faint)" }}>Loading…</div>
      ) : !summary || models.length === 0 ? (
        <div style={{ fontSize: "12.5px", color: "var(--text-faint)" }}>No model usage in this period.</div>
      ) : (
        <>
          <div style={{ display: "flex", height: "10px", borderRadius: "99px", overflow: "hidden", gap: "2px", marginBottom: "16px" }}>
            {models.map((m, i) =>
              m.runCount > 0 ? (
                <div
                  key={m.modelId ?? "\x00null"}
                  title={`${modelLabel(m.modelId)} · ${m.runCount} runs`}
                  style={{ flex: m.runCount, background: colorFor(i), opacity: 0.9 }}
                />
              ) : null
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {models.map((m, i) => {
              const pct = totalRuns > 0 ? Math.round((m.runCount / totalRuns) * 100) : 0;
              return (
                <div key={m.modelId ?? "\x00null"} style={{ display: "flex", alignItems: "center", gap: "9px" }}>
                  <span style={{ width: 9, height: 9, borderRadius: 99, background: colorFor(i), flex: "none" }} />
                  <span style={{ fontSize: "12.5px", color: "var(--text-dim)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {modelLabel(m.modelId)}
                  </span>
                  <span className="mono" style={{ fontSize: "11.5px", color: "var(--text-faint)" }}>{pct}%</span>
                  <span className="mono metric-val" style={{ width: "44px", textAlign: "right", fontSize: "12px", fontWeight: 600 }}>{m.runCount}</span>
                  <span className="mono" style={{ width: "58px", textAlign: "right", fontSize: "11.5px", color: "var(--text-faint)" }}>{formatUsd(m.usd)}</span>
                </div>
              );
            })}
          </div>

          {projects.length > 0 && (
            <div style={{ marginTop: "18px", borderTop: "1px solid var(--border)", paddingTop: "14px", display: "flex", flexDirection: "column", gap: "12px" }}>
              <span className="eyebrow">By project</span>
              {projects.map((p) => {
                const projTotal = p.models.reduce((s, m) => s + m.runCount, 0);
                return (
                  <div key={p.projectId ?? "__unassigned__"} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px" }}>
                      <span style={{ color: "var(--text-dim)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.projectName ?? (p.projectId ? p.projectId : "Unassigned")}
                      </span>
                      <span className="mono" style={{ color: "var(--text-faint)" }}>{projTotal} runs</span>
                    </div>
                    <div style={{ display: "flex", height: "7px", borderRadius: "99px", overflow: "hidden", gap: "2px" }}>
                      {p.models.map((m, i) => {
                        if (m.runCount <= 0) return null;
                        const globalIdx = models.findIndex((g) => g.modelId === m.modelId);
                        return (
                          <div
                            key={m.modelId ?? "\x00null"}
                            title={`${modelLabel(m.modelId)} · ${m.runCount} runs · ${formatUsd(m.usd)}`}
                            style={{ flex: m.runCount, background: colorFor(globalIdx >= 0 ? globalIdx : i), opacity: 0.85 }}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ActivityFeed({ tasks, onOpen }: { tasks: ApiTask[]; onOpen: (v: "tasks") => void }) {
  const recent = tasks
    .filter((t) => isActiveState(t.state) || ["DETECTED", "FEEDBACK_PROCESSING", "RETRY_CYCLE"].includes(t.state))
    .slice(0, 6);
  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", overflow: "hidden", flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: "9px", padding: "15px 18px", borderBottom: "1px solid var(--border-soft)" }}>
        <span className="live-dot" style={{ width: 8, height: 8, borderRadius: 99, background: "var(--ok)" }} />
        <span style={{ fontSize: "13px", fontWeight: 600 }}>In flight now</span>
        <div style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => onOpen("tasks")}>
          Open queue <Icon name="arrow" size={13} />
        </button>
      </div>
      {recent.length === 0 ? (
        <div style={{ padding: "24px 18px", color: "var(--text-ghost)", fontSize: "13px" }}>No active tasks.</div>
      ) : (
        recent.map((t) => (
          <button
            key={t.taskId}
            onClick={() => onOpen("tasks")}
            style={{
              display: "flex", alignItems: "center", gap: "12px", padding: "13px 18px",
              borderBottom: "1px solid var(--border-soft)",
              background: "transparent", border: "none", cursor: "pointer",
              textAlign: "left", color: "inherit", width: "100%",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--panel-2)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <ProviderGlyph provider={t.ticketSourceLabel} size={26} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: "12.5px", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t.ticketTitle || t.ticketId}
              </div>
              <div className="mono" style={{ fontSize: "10.5px", color: "var(--text-faint)", marginTop: "2px" }}>
                {t.ticketSourceLabel.toUpperCase()} #{t.displayId ?? t.ticketId}
              </div>
            </div>
            <StatePill state={t.state} size="sm" />
          </button>
        ))
      )}
    </div>
  );
}

function ProviderHealth({ providers, onOpen }: { providers: ApiProvider[]; onOpen: (v: "config") => void }) {
  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", overflow: "hidden", flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: "9px", padding: "15px 18px", borderBottom: "1px solid var(--border-soft)" }}>
        <Icon name="server" size={15} style={{ color: "var(--text-faint)" }} />
        <span style={{ fontSize: "13px", fontWeight: 600 }}>Provider health</span>
        <div style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => onOpen("config")}>
          Manage <Icon name="arrow" size={13} />
        </button>
      </div>
      {providers.slice(0, 8).map((p) => {
        const tone = p.status === "ready" ? "ok" : p.status === "disabled" ? "muted" : "danger";
        return (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "12px 18px", borderBottom: "1px solid var(--border-soft)" }}>
            <span
              className={tone === "ok" && p.enabled ? "live-dot" : ""}
              style={{ width: 8, height: 8, borderRadius: 99, background: TONE[tone].c, flex: "none" }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: "12.5px", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.name}
              </div>
              <div style={{ fontSize: "10.5px", color: "var(--text-faint)", marginTop: "1px" }}>
                {p.details.slice(0, 1).join(", ")}
              </div>
            </div>
            <Tag tone={tone}>{p.status}</Tag>
          </div>
        );
      })}
    </div>
  );
}

export function OverviewView({ overview, tasks, providers, activeIntegrationCount, pollingIntervalMs, onNavigate }: OverviewViewProps) {
  const active   = tasks.filter((t) => isActiveState(t.state)).length;
  const watching = tasks.filter((t) => ["REVIEW_WATCHING", "IN_REVIEW", "REVIEW_PENDING"].includes(t.state)).length;
  const failed   = tasks.filter((t) => ["FAILED", "REVIEW_FAILED"].includes(t.state)).length;
  const done     = tasks.filter((t) => ["DONE", "MERGED", "REVIEW_DONE"].includes(t.state)).length;

  return (
    <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
      <div
        style={{
          maxWidth: "1280px", margin: "0 auto",
          padding: "26px 28px 36px",
          display: "flex", flexDirection: "column", gap: "18px",
        }}
      >
        {/* header */}
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "20px", flexWrap: "wrap" }}>
          <div>
            <div className="eyebrow" style={{ marginBottom: "6px" }}>Orchestrator</div>
            <h1 style={{ margin: 0, fontSize: "26px", fontWeight: 600, letterSpacing: "-0.02em" }}>General View</h1>
            <p style={{ margin: "6px 0 0", color: "var(--text-faint)", fontSize: "13.5px" }}>
              Autonomous code generation &amp; review across{" "}
              {activeIntegrationCount} active integrations.
            </p>
          </div>
          {overview && (
            <div style={{ textAlign: "right" }}>
              <div className="eyebrow">
                Throughput · last {overview.throughput.length} ticks (~{Math.max(1, Math.round((overview.throughput.length * pollingIntervalMs) / 60000))}m)
              </div>
              <div style={{ width: "180px", marginTop: "8px" }}>
                <Bars data={overview.throughput} height={40} />
              </div>
            </div>
          )}
        </div>

        {/* stat row */}
        <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
          <Stat label="Active now"    value={active}   sub="agent cycles in flight" tone="active" icon="bolt" big />
          <Stat label="Watching"      value={watching} sub="awaiting next patchset"  tone="warn"   icon="eye"  big />
          <Stat label="Completed · 7d" value={overview ? overview.stats.completedLast7d : done} sub="merged or reviewed" tone="ok" icon="check" big />
          <Stat label="Failed · 7d"   value={overview ? overview.stats.failedLast7d : failed} sub="needs attention" tone="danger" icon="alert" big />
        </div>

        {/* mid row */}
        {overview && (
          <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
            <StateDistribution tasks={tasks} />
            <VoteBreakdown votes={overview.reviewVotes} />
            <RuntimeFacts runtime={overview.runtime} />
          </div>
        )}

        {/* cost row */}
        <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
          <CostSummaryCard />
        </div>

        {/* model usage row */}
        <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
          <ModelUsageCard />
        </div>
        {/* bottom row */}
        <div style={{ display: "flex", gap: "14px", flexWrap: "wrap", alignItems: "flex-start" }}>
          <ActivityFeed tasks={tasks} onOpen={onNavigate} />
          <ProviderHealth providers={providers} onOpen={onNavigate} />
        </div>
      </div>
    </div>
  );
}
