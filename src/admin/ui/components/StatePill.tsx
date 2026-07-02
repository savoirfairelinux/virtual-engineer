import type { TaskState } from "../types.ts";
import { STATES, TONE } from "../states.ts";

interface StatePillProps {
  state: TaskState;
  size?: "sm" | "md";
  pulse?: boolean;
}

export function StatePill({ state, size = "md", pulse }: StatePillProps) {
  const meta = STATES[state] ?? { label: state, tone: "muted" as const, kind: "gen" as const };
  const t = TONE[meta.tone] ?? TONE.muted;
  const isLive = pulse ?? (meta.tone === "active");
  return (
    <span
      className="pill"
      style={{
        color: t.c,
        background: t.bg,
        borderColor: `color-mix(in oklab, ${t.b} 35%, transparent)`,
        fontSize: size === "sm" ? "10px" : "10.5px",
        padding: size === "sm" ? "2px 7px 2px 6px" : undefined,
      }}
    >
      <span className={`dot${isLive ? " live-dot" : ""}`} style={{ background: t.c }} />
      {meta.label}
    </span>
  );
}
