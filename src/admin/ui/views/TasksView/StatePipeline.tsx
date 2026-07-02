import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { STATES, TONE, GEN_PIPELINE, REV_PIPELINE, STATE_ANCHOR, TERM_DIVERGE, NODE_SHORT } from "../../states.ts";
import type { ApiTask, TaskState } from "../../types.ts";

interface StatePipelineProps {
  task: ApiTask;
}

export function StatePipeline({ task }: StatePipelineProps) {
  const isRev = task.taskType === "code-review";
  const base = isRev ? REV_PIPELINE : GEN_PIPELINE;
  const meta = STATES[task.state] ?? { label: task.state, tone: "muted" as const, kind: "gen" as const };
  const isTermBad = ["FAILED", "ABANDONED", "REVIEW_FAILED"].includes(task.state);

  const anchor = STATE_ANCHOR[task.state];
  const curState: TaskState = anchor ? anchor.anchor : task.state;
  let curIdx = base.indexOf(curState);
  if (isTermBad) {
    const divergeState = TERM_DIVERGE[task.state];
    if (divergeState) curIdx = base.indexOf(divergeState);
  }

  const loopActive = (anchor?.loop ?? false) || (!isTermBad && task.cycleCount > 1 && curIdx >= 0);
  const loopFrom: TaskState = isRev ? "REVIEW_RUNNING" : "AGENT_RUNNING";
  const loopTo: TaskState   = isRev ? "REVIEW_WATCHING" : "IN_REVIEW";

  const containerRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [arc, setArc] = useState<{ x1: number; x2: number } | null>(null);

  useEffect(() => {
    const measure = () => {
      const c = containerRef.current;
      const a = nodeRefs.current[loopFrom];
      const b = nodeRefs.current[loopTo];
      if (!c || !a || !b) { setArc(null); return; }
      const cb = c.getBoundingClientRect();
      const ab = a.getBoundingClientRect();
      const bb = b.getBoundingClientRect();
      setArc({
        x1: ab.left + ab.width / 2 - cb.left,
        x2: bb.left + bb.width / 2 - cb.left,
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [task.taskId, loopFrom, loopTo]);

  const tone = TONE[meta.tone] ?? TONE.muted;

  function nodeStatus(i: number): "done" | "current" | "future" | "skipped" {
    if (isTermBad && i > curIdx) return "skipped";
    if (i < curIdx) return "done";
    if (i === curIdx) return isTermBad ? "done" : "current";
    return "future";
  }

  return (
    <div ref={containerRef} style={{ position: "relative", padding: "30px 8px 6px" }}>
      {/* retry arc */}
      {loopActive && arc && (
        <svg
          width="100%" height="34"
          style={{ position: "absolute", top: 0, left: 0, overflow: "visible", pointerEvents: "none" }}
        >
          <path
            d={`M ${arc.x2} 30 C ${arc.x2} 4, ${arc.x1} 4, ${arc.x1} 30`}
            fill="none" stroke="var(--accent-line)" strokeWidth="1.6" strokeDasharray="4 4"
          />
          <path
            d={`M ${arc.x1 - 4} 24 L ${arc.x1} 31 L ${arc.x1 + 4} 24`}
            fill="none" stroke="var(--accent-strong)" strokeWidth="1.6"
          />
          <foreignObject x={(arc.x1 + arc.x2) / 2 - 44} y={-4} width="88" height="18">
            <div
              className="mono"
              style={{ textAlign: "center", fontSize: "9.5px", color: "var(--accent-strong)", letterSpacing: "0.03em" }}
            >
              ↻ retry ×{task.cycleCount}
            </div>
          </foreignObject>
        </svg>
      )}

      <div style={{ display: "flex", alignItems: "flex-start" }}>
        {base.map((st, i) => {
          const status = nodeStatus(i);
          const isCur = status === "current";
          const c = isCur ? tone.c : status === "done" ? "var(--ok)" : "var(--text-ghost)";
          return (
            <div key={st} style={{ display: "flex", alignItems: "flex-start", flex: i < base.length - 1 ? 1 : "0 0 auto" }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px", width: "62px" }}>
                <div
                  ref={(el) => { nodeRefs.current[st] = el; }}
                  style={{
                    width: 26, height: 26, borderRadius: "99px", display: "grid", placeItems: "center",
                    background: status === "done" ? "var(--ok-soft)" : isCur ? tone.bg : "var(--panel-2)",
                    border: `1.5px solid ${status === "future" || status === "skipped" ? "var(--border)" : c}`,
                    color: c, position: "relative", flex: "none",
                    opacity: status === "skipped" ? 0.4 : 1,
                    boxShadow: isCur && meta.tone === "active" ? `0 0 0 4px ${tone.bg}` : "none",
                    transition: "all 0.2s var(--ease)",
                  }}
                >
                  {status === "done"
                    ? <Icon name="check" size={13} />
                    : isCur && meta.tone === "active"
                      ? <span className="live-dot" style={{ width: 8, height: 8, borderRadius: 99, background: c }} />
                      : isCur
                        ? <span style={{ width: 7, height: 7, borderRadius: 99, background: c }} />
                        : <span className="mono" style={{ fontSize: "10px", color: "var(--text-ghost)" }}>{i + 1}</span>}
                </div>
                <span
                  style={{
                    fontSize: "10.5px", fontWeight: isCur ? 600 : 500,
                    color: isCur ? "var(--text)" : status === "done" ? "var(--text-dim)" : "var(--text-ghost)",
                    textAlign: "center", lineHeight: 1.1,
                  }}
                >
                  {NODE_SHORT[st] ?? st}
                </span>
              </div>
              {i < base.length - 1 && (
                <div style={{ flex: 1, height: 26, display: "flex", alignItems: "center", padding: "0 2px" }}>
                  <div
                    style={{
                      height: "2px", width: "100%", borderRadius: "2px",
                      background: i < curIdx ? "var(--ok)" : "var(--border)",
                      opacity: isTermBad && i >= curIdx ? 0.3 : 1,
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}

        {/* bad-terminal off-ramp node */}
        {isTermBad && (
          <>
            <div style={{ flex: "0 0 30px", height: 26, display: "flex", alignItems: "center" }}>
              <div style={{ height: "2px", width: "100%", background: "var(--danger)", borderRadius: 2, opacity: 0.6 }} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px", width: "62px" }}>
              <div
                style={{
                  width: 26, height: 26, borderRadius: 99, display: "grid", placeItems: "center",
                  background: TONE[meta.tone].bg, border: `1.5px solid ${TONE[meta.tone].c}`,
                  color: TONE[meta.tone].c,
                }}
              >
                <Icon name={task.state === "ABANDONED" ? "x" : "alert"} size={13} />
              </div>
              <span style={{ fontSize: "10.5px", fontWeight: 600, color: TONE[meta.tone].c, textAlign: "center" }}>
                {meta.label.replace("REVIEW_", "").replace(/_/g, " ")}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
