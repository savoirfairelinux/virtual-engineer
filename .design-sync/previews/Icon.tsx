import React from "react";
import { Icon } from "virtual-engineer";

const SAMPLE_ICONS = [
  "check", "x", "alert", "bolt", "arrow", "dot", "eye", "gear",
  "branch", "commit", "pr", "lock", "clock", "robot", "zap", "tag",
];

export function Grid() {
  return (
    <div style={{ padding: 24, display: "grid", gridTemplateColumns: "repeat(8, 32px)", gap: 12 }}>
      {SAMPLE_ICONS.map((name) => (
        <span
          key={name}
          title={name}
          style={{ width: 32, height: 32, display: "grid", placeItems: "center", color: "var(--text-dim)" }}
        >
          <Icon name={name} size={16} />
        </span>
      ))}
    </div>
  );
}

export function Sizes() {
  return (
    <div style={{ padding: 24, display: "flex", alignItems: "center", gap: 16 }}>
      {[12, 16, 20, 24].map((size) => (
        <div key={size} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <Icon name="bolt" size={size} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 10, color: "var(--text-ghost)" }}>{size}px</span>
        </div>
      ))}
    </div>
  );
}

export function Tones() {
  const pairs: Array<[string, string]> = [
    ["check", "var(--ok)"],
    ["alert", "var(--warn)"],
    ["x", "var(--danger)"],
    ["bolt", "var(--info)"],
    ["zap", "var(--accent)"],
    ["dot", "var(--text-ghost)"],
  ];
  return (
    <div style={{ padding: 24, display: "flex", gap: 12 }}>
      {pairs.map(([name, color]) => (
        <Icon key={name} name={name} size={18} style={{ color }} />
      ))}
    </div>
  );
}
