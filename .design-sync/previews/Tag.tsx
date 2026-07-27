import React from "react";
import { Tag } from "virtual-engineer";

export function Tones() {
  return (
    <div style={{ padding: 24, display: "flex", flexWrap: "wrap", gap: 8 }}>
      <Tag tone="active">active</Tag>
      <Tag tone="ok">merged</Tag>
      <Tag tone="warn">review</Tag>
      <Tag tone="danger">failed</Tag>
      <Tag tone="info">running</Tag>
      <Tag tone="muted">closed</Tag>
    </div>
  );
}

export function Mono() {
  return (
    <div style={{ padding: 24, display: "flex", flexWrap: "wrap", gap: 8 }}>
      <Tag tone="active" mono>fix/auth-session</Tag>
      <Tag tone="info" mono>feat/webhook-events</Tag>
      <Tag tone="ok" mono>v2.1.4</Tag>
      <Tag mono>docs/update</Tag>
    </div>
  );
}

export function InContext() {
  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 13, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "var(--text-faint)", fontSize: 12 }}>Labels:</span>
        <Tag tone="info">bug</Tag>
        <Tag tone="warn">needs-review</Tag>
        <Tag tone="ok">approved</Tag>
      </div>
      <div style={{ fontSize: 13, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "var(--text-faint)", fontSize: 12 }}>Branch:</span>
        <Tag tone="active" mono>feat/dark-mode</Tag>
      </div>
    </div>
  );
}
