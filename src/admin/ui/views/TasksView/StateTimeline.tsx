import { Icon } from "../../components/Icon.tsx";
import { StatePill } from "../../components/StatePill.tsx";
import { Tag } from "../../components/Tag.tsx";
import { TONE, STATES } from "../../states.ts";
import type { ApiTransition } from "../../types.ts";

interface StateTimelineProps {
  transitions: ApiTransition[];
}

function duration(from: string, to: string): string {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (ms < 1000) return "<1s";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

export function StateTimeline({ transitions }: StateTimelineProps) {
  if (transitions.length === 0) {
    return (
      <div className="placeholder" style={{ minHeight: "120px" }}>No state transitions recorded yet.</div>
    );
  }

  return (
    <div style={{ position: "relative", paddingLeft: "6px" }}>
      <div
        style={{
          position: "absolute", left: "12px", top: "10px", bottom: "10px",
          width: "2px", background: "var(--border)",
        }}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
        {transitions.map((tr, i) => {
          const isAction = !!tr.metadata?.["action"];
          const action = tr.metadata?.["action"] as string | undefined;
          const toMeta = STATES[tr.toState];
          const tone = isAction
            ? (action === "pause" ? "warn" : "info")
            : toMeta ? toMeta.tone : "muted";
          const c = TONE[tone].c;
          const isCurrent = i === transitions.length - 1;
          const prevAt = i > 0 ? transitions[i - 1]!.createdAt : tr.createdAt;

          return (
            <div
              key={tr.id}
              style={{
                display: "flex", gap: "14px", alignItems: "flex-start",
                padding: "10px 0", position: "relative",
              }}
            >
              <div
                style={{
                  flex: "none", width: "14px",
                  display: "flex", justifyContent: "center", paddingTop: "3px", zIndex: 1,
                }}
              >
                <span
                  className={isCurrent ? "live-dot" : ""}
                  style={{
                    width: isCurrent ? 12 : 10,
                    height: isCurrent ? 12 : 10,
                    borderRadius: 99, background: c,
                    border: "2px solid var(--panel)",
                    boxShadow: isCurrent ? `0 0 0 4px ${TONE[tone].bg}` : "none",
                  }}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  {isAction ? (
                    <Tag tone={tone} mono={false}>
                      {action === "pause"    ? "⏸ Paused"
                       : action === "retry"   ? "↺ Retried"
                       : action === "abandon" ? "✕ Abandoned"
                       : "▶ Resumed"}
                    </Tag>
                  ) : (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "7px" }}>
                      <span className="mono" style={{ fontSize: "11px", color: "var(--text-faint)" }}>
                        {tr.fromState}
                      </span>
                      <Icon name="arrow" size={12} style={{ color: "var(--text-ghost)" }} />
                      <StatePill state={tr.toState} size="sm" pulse={isCurrent} />
                    </span>
                  )}
                  {i > 0 && (
                    <span className="mono" style={{ fontSize: "10.5px", color: "var(--text-ghost)" }}>
                      +{duration(prevAt, tr.createdAt)}
                    </span>
                  )}
                  <div style={{ flex: 1 }} />
                  <span className="mono" style={{ fontSize: "11px", color: "var(--text-faint)" }}>
                    {new Date(tr.createdAt).toLocaleTimeString()}
                  </span>
                </div>
                {!!tr.metadata?.["note"] && (
                  <div style={{ fontSize: "12px", color: "var(--text-faint)", marginTop: "4px" }}>
                    {String(tr.metadata["note"])}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
