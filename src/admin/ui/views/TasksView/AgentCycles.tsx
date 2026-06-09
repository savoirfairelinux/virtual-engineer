import { useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { Tag } from "../../components/Tag.tsx";
import { TONE } from "../../states.ts";
import type { ApiCycle } from "../../types.ts";

interface ReviewComment {
  file: string;
  line: number;
  sev: string;
  body: string;
  suggestion?: string | undefined;
}

interface ReviewSummary {
  vote: number | null;
  commentCount: number;
}

const SEV_TONE: Record<string, "danger" | "warn" | "info"> = {
  Critical: "danger",
  Error: "danger",
  Warning: "warn",
  Suggestion: "warn",
  Nit: "info",
};

function CodeBlock({ children }: { children: string }) {
  return (
    <pre
      className="mono"
      style={{
        margin: "8px 0 0", padding: "10px 12px",
        background: "var(--bg)", border: "1px solid var(--border-soft)",
        borderRadius: "var(--radius-sm)", fontSize: "11.5px",
        lineHeight: 1.6, color: "var(--text-dim)",
        overflowX: "auto", whiteSpace: "pre",
      }}
    >
      {children}
    </pre>
  );
}

function ReviewCommentBlock({ c }: { c: ReviewComment }) {
  const tone = SEV_TONE[c.sev] ?? "muted";
  return (
    <div style={{ borderLeft: `2px solid ${TONE[tone].c}`, paddingLeft: "14px", marginTop: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "9px", flexWrap: "wrap", marginBottom: "6px" }}>
        <span className="mono" style={{ fontSize: "11.5px", color: "var(--accent-strong)" }}>
          {c.file}<span style={{ color: "var(--text-faint)" }}>:{c.line}</span>
        </span>
        <Tag tone={tone} mono={false}>{c.sev}</Tag>
      </div>
      <div style={{ fontSize: "12.5px", color: "var(--text-dim)", lineHeight: 1.55 }}>{c.body}</div>
      {c.suggestion && <CodeBlock>{c.suggestion}</CodeBlock>}
    </div>
  );
}

function extractReviewComments(cycle: ApiCycle): ReviewComment[] {
  const metadata = cycle.result.metadata;
  const metadataComments = (metadata && typeof metadata === "object" && Array.isArray((metadata as Record<string, unknown>)["comments"]))
    ? ((metadata as Record<string, unknown>)["comments"] as unknown[])
    : [];

  const comments: ReviewComment[] = metadataComments
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      file: String(item["file"] ?? ""),
      line: Number(item["line"] ?? 0),
      sev: String(item["severity"] ?? item["sev"] ?? "Suggestion"),
      body: String(item["message"] ?? item["body"] ?? ""),
      suggestion: item["suggestion"] ? String(item["suggestion"]) : undefined,
    }))
    .filter((c) => c.file.length > 0 && c.body.length > 0);

  if (comments.length > 0) return comments;

  const events = cycle.result.agentEvents ?? [];
  const eventComments: ReviewComment[] = [];
  for (const ev of events) {
    if ((ev.type === "REVIEW_COMMENT" || ev.type === "review.comment") && ev.data && typeof ev.data === "object") {
      const d = ev.data as Record<string, unknown>;
      eventComments.push({
        file: String(d["file"] ?? ""),
        line: Number(d["line"] ?? 0),
        sev: String(d["severity"] ?? d["sev"] ?? "Suggestion"),
        body: String(d["message"] ?? d["body"] ?? ""),
        suggestion: d["suggestion"] ? String(d["suggestion"]) : undefined,
      });
    }
  }
  return eventComments;
}

function extractReviewSummary(cycle: ApiCycle, commentCount: number): ReviewSummary {
  const metadata = cycle.result.metadata;
  if (metadata && typeof metadata === "object") {
    const m = metadata as Record<string, unknown>;
    const voteRaw = m["vote"] ?? m["score"];
    const metadataVote = typeof voteRaw === "number" && Number.isFinite(voteRaw) ? voteRaw : null;
    const metadataCountRaw = m["commentCount"];
    const metadataCount = typeof metadataCountRaw === "number" && Number.isFinite(metadataCountRaw)
      ? metadataCountRaw
      : commentCount;
    return { vote: metadataVote, commentCount: metadataCount };
  }
  return { vote: null, commentCount };
}

function cycleDuration(cycle: ApiCycle): string {
  if (cycle.durationMs != null && cycle.durationMs > 0) {
    const ms = cycle.durationMs;
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  }
  // Fallback: derive from agentEvents (for cycles serialised before durationMs was added)
  const start = new Date(cycle.createdAt).getTime();
  const last = cycle.result.agentEvents?.at(-1);
  if (!last) return "—";
  const ms = Math.max(0, new Date(last.timestamp).getTime() - start);
  if (ms === 0) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

interface CycleCardProps {
  cycle: ApiCycle;
  open: boolean;
  onToggle: () => void;
}

function CycleCard({ cycle, open, onToggle }: CycleCardProps) {
  const running = cycle.result.status === "failed" && !cycle.result.agentLogs;
  const tone = running ? "active" : cycle.result.status === "success" ? "ok" : cycle.result.status === "no_change" ? "warn" : "danger";
  const reviewComments = extractReviewComments(cycle);
  const reviewSummary = extractReviewSummary(cycle, reviewComments.length);

  return (
    <div className="card" style={{ overflow: "hidden", borderColor: open ? "var(--border)" : "var(--border-soft)" }}>
      <button
        onClick={onToggle}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: "12px", padding: "14px 16px",
          background: "transparent", border: "none", cursor: "pointer", textAlign: "left", color: "inherit",
        }}
      >
        <Icon
          name="chevron" size={14}
          style={{ color: "var(--text-faint)", transform: open ? "rotate(90deg)" : "none", transition: "transform 0.18s var(--ease)" }}
        />
        <span style={{ fontSize: "13.5px", fontWeight: 600 }}>Cycle {cycle.cycleNumber}</span>
        {running ? (
          <span className="pill" style={{ color: "var(--accent-strong)", background: "var(--accent-soft)", borderColor: "var(--accent-line)" }}>
            <span className="dot live-dot" /> running
          </span>
        ) : (
          <Tag tone={tone} mono={false}>{cycle.result.status}</Tag>
        )}
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: "14px", alignItems: "center", fontSize: "11.5px", color: "var(--text-faint)" }}>
          {reviewSummary.commentCount > 0 && (
            <span style={{ display: "inline-flex", gap: "5px", alignItems: "center" }}>
              <Icon name="comment" size={13} />{reviewSummary.commentCount}
            </span>
          )}
          {reviewSummary.vote !== null && (
            <Tag tone={reviewSummary.vote >= 0 ? "ok" : "danger"} mono={false}>
              vote {reviewSummary.vote > 0 ? "+" : ""}{reviewSummary.vote}
            </Tag>
          )}
          <span style={{ display: "inline-flex", gap: "5px", alignItems: "center" }}>
            <Icon name="clock" size={13} />{cycleDuration(cycle)}
          </span>
        </div>
      </button>

      {open && (
        <div className="fade-up" style={{ padding: "0 16px 18px 42px" }}>
          {running ? (
            <div style={{ display: "flex", alignItems: "center", gap: "10px", color: "var(--text-faint)", fontSize: "12.5px", padding: "8px 0" }}>
              <span className="live-dot" style={{ width: 7, height: 7, borderRadius: 99, background: "var(--accent-strong)" }} />
              Agent is running. Results will stream into the log below.
            </div>
          ) : (
            <>
              {cycle.result.summary && (
                <>
                  <div className="eyebrow" style={{ marginBottom: "8px" }}>Summary</div>
                  <div
                    style={{
                      fontSize: "12.5px", lineHeight: 1.6, color: "var(--text-dim)",
                      background: "var(--panel-2)", borderRadius: "var(--radius-sm)", padding: "12px 14px",
                    }}
                  >
                    {cycle.result.summary}
                  </div>
                </>
              )}
              <div style={{ display: "flex", gap: "14px", alignItems: "center", marginTop: "12px", color: "var(--text-faint)", fontSize: "11.5px" }}>
                <span className="mono">Started: {new Date(cycle.createdAt).toLocaleString()}</span>
                {reviewSummary.vote !== null && <span className="mono">Vote: {reviewSummary.vote > 0 ? "+" : ""}{reviewSummary.vote}</span>}
              </div>
              {reviewComments.length > 0 && (
                <>
                  <div className="eyebrow" style={{ margin: "20px 0 2px" }}>Review comments · {reviewComments.length}</div>
                  {reviewComments.map((c, i) => <ReviewCommentBlock key={i} c={c} />)}
                </>
              )}
              {/* modified files */}
              {Array.isArray(cycle.result.modifiedFiles) && cycle.result.modifiedFiles.length > 0 && (
                <>
                  <div className="eyebrow" style={{ margin: "20px 0 8px" }}>Modified files</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                    {(cycle.result.modifiedFiles as string[]).map((f) => (
                      <div key={f} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <Icon name="file" size={13} style={{ color: "var(--text-ghost)" }} />
                        <span className="mono" style={{ fontSize: "11.5px", color: "var(--text-dim)" }}>{f}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface AgentCyclesProps {
  cycles: ApiCycle[];
}

export function AgentCycles({ cycles }: AgentCyclesProps) {
  const [open, setOpen] = useState<Record<number, boolean>>(() => {
    const o: Record<number, boolean> = {};
    if (cycles.length > 0) o[cycles[cycles.length - 1]!.cycleNumber] = true;
    return o;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {[...cycles].reverse().map((c) => (
        <CycleCard
          key={c.id} cycle={c}
          open={!!open[c.cycleNumber]}
          onToggle={() => setOpen((s) => ({ ...s, [c.cycleNumber]: !s[c.cycleNumber] }))}
        />
      ))}
    </div>
  );
}
