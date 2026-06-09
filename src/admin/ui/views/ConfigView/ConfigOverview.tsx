import { Stat } from "../../components/Stat.tsx";
import type { ConfigViewData } from "./index.tsx";

export function ConfigOverview({ integrations, agents, projects, config }: ConfigViewData) {
  const total  = integrations.length;
  const active = integrations.filter((i) => i.enabled).length;
  const byCat: Record<string, { t: number; a: number }> = {};
  for (const i of integrations) {
    const c = byCat[i.category] ?? { t: 0, a: 0 };
    c.t++;
    if (i.enabled) c.a++;
    byCat[i.category] = c;
  }

  return (
    <>
      <div style={{ marginBottom: "22px" }}>
        <div className="eyebrow" style={{ marginBottom: "8px" }}>Configuration / Overview</div>
        <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 600, letterSpacing: "-0.01em" }}>Overview</h1>
        <p style={{ margin: "6px 0 0", color: "var(--text-faint)", fontSize: "13.5px" }}>High-level configuration posture across the admin surface.</p>
      </div>

      <div style={{ display: "flex", gap: "14px", marginBottom: "20px" }}>
        <Stat label="Integrations" value={total}  sub="registered providers" icon="server" />
        <Stat label="Active"       value={active} sub="enabled & connected" tone="ok" icon="check" />
        <Stat label="Agents"       value={agents.filter((a) => a.enabled).length} sub="enabled" tone="active" icon="spark" />
        <Stat label="Projects"     value={projects.filter((p) => p.enabled).length} sub="execution units" icon="box" />
      </div>

      {config && (
        <div className="card" style={{ padding: "18px 20px", marginBottom: "16px" }}>
          <div className="eyebrow" style={{ marginBottom: "16px" }}>Runtime configuration</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1px", background: "var(--border-soft)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
            {([
              ["Environment",   config.nodeEnv],
              ["Log level",     config.logLevel],
              ["Max cycles",    String(config.maxAgentCycles)],
              ["Max retries",   String(config.maxRetryAttempts)],
              ["Polling interval", `${config.pollingIntervalMs / 1000}s`],
            ] as [string, string][]).map(([k, v]) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", background: "var(--panel)" }}>
                <span style={{ fontSize: "12.5px", fontWeight: 500 }}>{k}</span>
                <span className="mono" style={{ fontSize: "12px", color: "var(--text-dim)" }}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {Object.keys(byCat).length > 0 && (
        <div className="card" style={{ padding: "18px 20px" }}>
          <div className="eyebrow" style={{ marginBottom: "14px" }}>Integrations by category</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {Object.entries(byCat).map(([cat, n]) => (
              <div key={cat} style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <span style={{ width: "90px", fontSize: "12.5px", textTransform: "capitalize", color: "var(--text-dim)" }}>{cat}</span>
                <div style={{ flex: 1, height: "8px", background: "var(--panel-2)", borderRadius: "99px", overflow: "hidden" }}>
                  <div style={{ width: `${(n.a / n.t) * 100}%`, height: "100%", background: "var(--accent)", borderRadius: "99px" }} />
                </div>
                <span className="mono" style={{ fontSize: "11.5px", color: "var(--text-faint)" }}>{n.a}/{n.t} active</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
