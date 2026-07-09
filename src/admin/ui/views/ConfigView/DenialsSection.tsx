import { useEffect, useState } from "react";
import { api } from "../../api.ts";

interface PolicyDenial {
  id: number;
  taskId: string | null;
  projectId: string | null;
  runtime: string;
  category: string;
  host: string;
  method: string;
  path: string;
  decision: string;
  reason: string;
  createdAt: string | number;
}

export function DenialsSection() {
  const [denials, setDenials] = useState<PolicyDenial[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setError(null);
    setLoading(true);
    try {
      const data = await api.get<{ denials: PolicyDenial[] }>("/api/admin/runtime/denials?limit=200");
      setDenials(data.denials);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load denials");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  return (
    <>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "22px" }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: "8px" }}>Configuration / Policy denials</div>
          <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 600, letterSpacing: "-0.01em" }}>Policy denials</h1>
          <p style={{ margin: "6px 0 0", color: "var(--text-faint)", fontSize: "13.5px", maxWidth: "560px" }}>
            Deny-by-default egress and sandbox blocks recorded by the runtime policy engine.
            Secrets are scrubbed before storage.
          </p>
        </div>
        <button className="btn" disabled={loading} onClick={() => void load()}>{loading ? "Refreshing…" : "Refresh"}</button>
      </div>

      {error && <div className="card" style={{ padding: "12px 14px", marginBottom: "16px", color: "var(--danger, #f85149)" }}>{error}</div>}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {denials.length === 0 ? (
          <div style={{ padding: "22px", color: "var(--text-ghost)", fontSize: "13px" }}>No policy denials recorded.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12.5px" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-ghost)" }}>
                  <th style={{ padding: "10px 14px" }}>When</th>
                  <th style={{ padding: "10px 14px" }}>Runtime</th>
                  <th style={{ padding: "10px 14px" }}>Category</th>
                  <th style={{ padding: "10px 14px" }}>Method</th>
                  <th style={{ padding: "10px 14px" }}>Host / path</th>
                  <th style={{ padding: "10px 14px" }}>Reason</th>
                </tr>
              </thead>
              <tbody>
                {denials.map((d) => (
                  <tr key={d.id} style={{ borderTop: "1px solid var(--border-soft)" }}>
                    <td style={{ padding: "9px 14px", whiteSpace: "nowrap", color: "var(--text-ghost)" }}>{formatWhen(d.createdAt)}</td>
                    <td style={{ padding: "9px 14px" }}>{d.runtime || "—"}</td>
                    <td style={{ padding: "9px 14px" }}>{d.category || "—"}</td>
                    <td style={{ padding: "9px 14px" }}>{d.method || "—"}</td>
                    <td style={{ padding: "9px 14px" }}><code style={{ fontSize: "11.5px" }}>{d.host}{d.path}</code></td>
                    <td style={{ padding: "9px 14px", color: "var(--text-dim)" }}>{d.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function formatWhen(value: string | number): string {
  const ms = typeof value === "number" ? value * 1000 : Date.parse(value);
  if (!Number.isFinite(ms)) return String(value);
  return new Date(ms).toLocaleString();
}
