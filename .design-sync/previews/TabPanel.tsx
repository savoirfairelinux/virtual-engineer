import React from "react";
import { TabPanel, Tabs } from "virtual-engineer";

export function WithContent() {
  const [tab, setTab] = React.useState("tasks");
  return (
    <div style={{ padding: 24 }}>
      <Tabs
        tabs={[
          { id: "tasks", label: "Tasks", count: 12 },
          { id: "config", label: "Config" },
          { id: "log", label: "Log" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div style={{ marginTop: 16 }}>
        {tab === "tasks" && (
          <TabPanel>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {["Fix auth session timeout", "Add webhook retry logic", "Update agent prompt"].map((t) => (
                <div
                  key={t}
                  className="card"
                  style={{ padding: "10px 14px", fontSize: 13, color: "var(--text-dim)" }}
                >
                  {t}
                </div>
              ))}
            </div>
          </TabPanel>
        )}
        {tab === "config" && (
          <TabPanel>
            <div className="card" style={{ padding: "12px 16px", fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text-faint)" }}>
              {"provider: github\nbase_branch: main\nauto_merge: true"}
            </div>
          </TabPanel>
        )}
        {tab === "log" && (
          <TabPanel>
            <div style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text-ghost)", lineHeight: 1.6 }}>
              {"[12:03] context building…\n[12:04] agent started\n[12:07] PR opened #42"}
            </div>
          </TabPanel>
        )}
      </div>
    </div>
  );
}
