import type { ReactNode } from "react";

interface TabItem {
  id: string;
  label: string;
  count?: number | null;
}

interface TabsProps {
  tabs: TabItem[];
  value: string;
  onChange: (id: string) => void;
  size?: "sm" | "md";
}

export function Tabs({ tabs, value, onChange, size = "md" }: TabsProps) {
  return (
    <div style={{ display: "flex", gap: size === "sm" ? "2px" : "4px", alignItems: "center" }}>
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            style={{
              position: "relative", border: "none",
              background: active ? "var(--panel-2)" : "transparent",
              color: active ? "var(--text)" : "var(--text-faint)",
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
              fontSize: size === "sm" ? "12px" : "13px",
              fontWeight: active ? 600 : 500,
              padding: size === "sm" ? "5px 10px" : "7px 13px",
              borderRadius: "7px",
              transition: "all 0.14s var(--ease)",
              display: "inline-flex", alignItems: "center", gap: "7px",
            }}
          >
            {tab.label}
            {tab.count != null && (
              <span
                className="mono"
                style={{
                  fontSize: "10px",
                  color: active ? "var(--accent-strong)" : "var(--text-ghost)",
                  background: active ? "var(--accent-soft)" : "var(--panel-3)",
                  padding: "1px 6px", borderRadius: "99px",
                }}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

interface TabPanelProps {
  children: ReactNode;
}

export function TabPanel({ children }: TabPanelProps) {
  return <div className="fade-up">{children}</div>;
}
