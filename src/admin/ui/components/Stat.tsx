import { Icon } from "./Icon.tsx";
import { TONE, type ToneKey } from "../states.ts";

interface StatProps {
  label: string;
  value: number | string;
  sub?: string;
  tone?: ToneKey;
  icon?: string;
  big?: boolean;
}

export function Stat({ label, value, sub, tone, icon, big }: StatProps) {
  const t = tone ? TONE[tone] : null;
  return (
    <div
      className="card"
      style={{
        padding: big ? "18px 20px" : "15px 16px",
        display: "flex", flexDirection: "column", gap: "8px",
        flex: 1, minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span className="eyebrow">{label}</span>
        {icon && (
          <span style={{ color: t ? t.c : "var(--text-ghost)" }}>
            <Icon name={icon} size={15} />
          </span>
        )}
      </div>
      <div
        className="metric-val"
        style={{
          fontSize: big ? "34px" : "26px", fontWeight: 600, lineHeight: 1,
          color: t ? t.c : "var(--text)",
        }}
      >
        {value}
      </div>
      {sub && <div style={{ fontSize: "12px", color: "var(--text-faint)" }}>{sub}</div>}
    </div>
  );
}
