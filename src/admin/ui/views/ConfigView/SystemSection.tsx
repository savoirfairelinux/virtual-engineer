import type { ApiConfig, ApiStatus } from "../../types.ts";

interface SystemSectionProps {
  config: ApiConfig["config"] | null;
  status: ApiStatus | null;
}

export function SystemSection({ config, status }: SystemSectionProps) {
  const runtime = status?.runtime;
  const polling = status?.polling;
  const rows: [string, string][] = [
    ["Polling state", polling?.running ? "running" : "stopped"],
    ["Polling interval", `${Math.max(1, Math.round((polling?.intervalMs ?? config?.pollingIntervalMs ?? 30000) / 1000))}s`],
    ["Environment", runtime?.nodeEnv ?? config?.nodeEnv ?? "unknown"],
    ["Log level", runtime?.logLevel ?? config?.logLevel ?? "unknown"],
    ["Max cycles", String(runtime?.maxAgentCycles ?? config?.maxAgentCycles ?? "unknown")],
    ["Max retries", String(runtime?.maxRetryAttempts ?? config?.maxRetryAttempts ?? "unknown")],
    ...(config ? [
      ["Configured cycles", String(config.maxAgentCycles)] as [string, string],
      ["Configured retries", String(config.maxRetryAttempts)] as [string, string],
      ["Configured polling", `${Math.max(1, Math.round(config.pollingIntervalMs / 1000))}s`] as [string, string],
    ] : []),
  ];

  return (
    <>
      <div style={{ marginBottom: "22px" }}>
        <div className="eyebrow" style={{ marginBottom: "8px" }}>Configuration / System</div>
        <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 600, letterSpacing: "-0.01em" }}>System settings</h1>
        <p style={{ margin: "6px 0 0", color: "var(--text-faint)", fontSize: "13.5px" }}>
          Read-only runtime facts resolved from environment and process state.
        </p>
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        {rows.map(([k, v], i) => (
          <div
            key={k}
            style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "14px 18px",
              borderBottom: i < rows.length - 1 ? "1px solid var(--border-soft)" : "none",
            }}
          >
            <span style={{ fontSize: "13px", fontWeight: 500 }}>{k}</span>
            <span className="mono" style={{ fontSize: "12px", color: "var(--text-dim)" }}>{v}</span>
          </div>
        ))}
      </div>
    </>
  );
}
