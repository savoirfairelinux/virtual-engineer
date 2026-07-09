import { useEffect, useState } from "react";
import { api } from "../../api.ts";

interface RuntimeInfo {
  defaultRuntime: string;
  available: string[];
  supported: string[];
  gatewayHealthy?: boolean | undefined;
}

export function RuntimeSection() {
  const [info, setInfo] = useState<RuntimeInfo | null>(null);
  const [selected, setSelected] = useState<string>("docker");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function load() {
    setError(null);
    try {
      const data = await api.get<RuntimeInfo>("/api/admin/runtime");
      setInfo(data);
      setSelected(data.defaultRuntime);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load runtime info");
    }
  }

  useEffect(() => { void load(); }, []);

  const dirty = info !== null && selected !== info.defaultRuntime;

  async function handleSave() {
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      await api.put("/api/admin/runtime", { defaultRuntime: selected });
      setSaved(true);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const gateway = info?.gatewayHealthy;
  const gatewayLabel = gateway === undefined ? "n/a" : gateway ? "healthy" : "unreachable";
  const gatewayColor = gateway === undefined ? "var(--text-ghost)" : gateway ? "var(--ok, #3fb950)" : "var(--danger, #f85149)";

  return (
    <>
      <div style={{ marginBottom: "22px" }}>
        <div className="eyebrow" style={{ marginBottom: "8px" }}>Configuration / Runtime</div>
        <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 600, letterSpacing: "-0.01em" }}>Agent runtime</h1>
        <p style={{ margin: "6px 0 0", color: "var(--text-faint)", fontSize: "13.5px" }}>
          Choose the default execution backend. Docker runs agents in local containers; OpenShell
          runs them in policy-governed sandboxes. Projects and agents can override this per-item.
        </p>
      </div>

      {error && <div className="card" style={{ padding: "12px 14px", marginBottom: "16px", color: "var(--danger, #f85149)" }}>{error}</div>}

      <div className="card" style={{ padding: "20px 18px", marginBottom: "18px" }}>
        <div className="eyebrow" style={{ marginBottom: "12px" }}>Default runtime</div>
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", maxWidth: "460px" }}>
          {(info?.supported ?? ["docker", "openshell"]).map((id) => {
            const registered = info?.available.includes(id) ?? false;
            const active = selected === id;
            return (
              <label
                key={id}
                style={{
                  display: "flex", alignItems: "center", gap: "10px", padding: "11px 13px",
                  borderRadius: "var(--radius-sm)",
                  border: `1px solid ${active ? "var(--accent-strong)" : "var(--border-soft)"}`,
                  background: active ? "var(--panel-2)" : "transparent",
                  cursor: registered ? "pointer" : "not-allowed", opacity: registered ? 1 : 0.55,
                }}
              >
                <input
                  type="radio"
                  name="default-runtime"
                  value={id}
                  checked={active}
                  disabled={!registered}
                  onChange={() => { setSelected(id); setSaved(false); }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: "13.5px" }}>{id}</div>
                  <div style={{ fontSize: "11px", color: "var(--text-ghost)" }}>
                    {id === "docker" ? "Local Docker containers (default, always available)" : "OpenShell policy-governed sandboxes"}
                    {!registered ? " — no runner registered" : ""}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "16px" }}>
          <button className="btn btn-primary" disabled={!dirty || saving} onClick={() => void handleSave()}>
            {saving ? "Saving…" : "Save default"}
          </button>
          {saved && <span style={{ fontSize: "12px", color: "var(--ok, #3fb950)" }}>Saved</span>}
        </div>
      </div>

      <div className="card" style={{ padding: "16px 18px" }}>
        <div className="eyebrow" style={{ marginBottom: "10px" }}>OpenShell gateway</div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" }}>
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: gatewayColor }} />
          <span style={{ color: "var(--text-dim)" }}>Status: {gatewayLabel}</span>
        </div>
      </div>
    </>
  );
}
