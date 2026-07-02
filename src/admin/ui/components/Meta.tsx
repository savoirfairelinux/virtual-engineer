import type { ReactNode } from "react";

interface MetaProps {
  label: string;
  children: ReactNode;
  mono?: boolean;
  accent?: boolean;
}

export function Meta({ label, children, mono, accent }: MetaProps) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="eyebrow" style={{ marginBottom: "5px" }}>{label}</div>
      <div
        className={mono ? "mono" : ""}
        style={{
          fontSize: mono ? "12.5px" : "14px",
          fontWeight: 500,
          color: accent ? "var(--accent-strong)" : "var(--text)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: mono ? "nowrap" : "normal",
        }}
      >
        {children}
      </div>
    </div>
  );
}
