import { useEffect, useState } from "react";
import { Field, FieldInput } from "../../components/Modal.tsx";
import { api } from "../../api.ts";
import type { ApiConfig, ApiStatus } from "../../types.ts";

interface SystemSectionProps {
  config: ApiConfig["config"] | null;
  status: ApiStatus | null;
  onRefresh: () => void;
}

interface EditableSettings {
  pollingIntervalMs: number;
  maxAgentCycles: number;
  maxRetryAttempts: number;
}

export function SystemSection({ config, status, onRefresh }: SystemSectionProps) {
  const runtime = status?.runtime;
  const polling = status?.polling;

  const initialPollingSeconds = Math.max(
    1,
    Math.round((config?.pollingIntervalMs ?? polling?.intervalMs ?? 30000) / 1000)
  );
  const initialCycles = config?.maxAgentCycles ?? runtime?.maxAgentCycles ?? 3;
  const initialRetries = config?.maxRetryAttempts ?? runtime?.maxRetryAttempts ?? 5;

  const [pollingSeconds, setPollingSeconds] = useState(String(initialPollingSeconds));
  const [maxCycles, setMaxCycles] = useState(String(initialCycles));
  const [maxRetries, setMaxRetries] = useState(String(initialRetries));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Re-sync the form when the server-resolved values change (e.g. after a save,
  // an onRefresh(), or another admin updating settings) so inputs never show
  // stale values and `dirty` doesn't spuriously flip to true.
  useEffect(() => {
    setPollingSeconds(String(initialPollingSeconds));
    setMaxCycles(String(initialCycles));
    setMaxRetries(String(initialRetries));
  }, [initialPollingSeconds, initialCycles, initialRetries]);

  const dirty =
    Number(pollingSeconds) !== initialPollingSeconds ||
    Number(maxCycles) !== initialCycles ||
    Number(maxRetries) !== initialRetries;

  function validate(): EditableSettings | string {
    const seconds = Number(pollingSeconds);
    const cycles = Number(maxCycles);
    const retries = Number(maxRetries);
    if (!Number.isInteger(seconds) || seconds <= 0) return "Polling interval must be a positive whole number of seconds.";
    if (!Number.isInteger(cycles) || cycles <= 0) return "Max cycles must be a positive whole number.";
    if (!Number.isInteger(retries) || retries <= 0) return "Max retries must be a positive whole number.";
    return { pollingIntervalMs: seconds * 1000, maxAgentCycles: cycles, maxRetryAttempts: retries };
  }

  async function handleSave() {
    setError(null);
    setSaved(false);
    const result = validate();
    if (typeof result === "string") {
      setError(result);
      return;
    }
    setSaving(true);
    try {
      await api.put("/api/admin/settings", result);
      setSaved(true);
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const readOnlyRows: [string, string][] = [
    ["Polling state", polling?.running ? "running" : "stopped"],
    ["Environment", runtime?.nodeEnv ?? config?.nodeEnv ?? "unknown"],
    ["Log level", runtime?.logLevel ?? config?.logLevel ?? "unknown"],
  ];

  return (
    <>
      <div style={{ marginBottom: "22px" }}>
        <div className="eyebrow" style={{ marginBottom: "8px" }}>Configuration / System</div>
        <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 600, letterSpacing: "-0.01em" }}>System settings</h1>
        <p style={{ margin: "6px 0 0", color: "var(--text-faint)", fontSize: "13.5px" }}>
          Edit runtime workflow settings. Changes are applied immediately — no restart required.
        </p>
      </div>

      <div className="card" style={{ padding: "20px 18px", marginBottom: "22px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: "360px" }}>
          <Field label="Polling interval (seconds)" hint="How often the ticket sources are polled for new work.">
            <FieldInput
              type="number"
              min={1}
              step={1}
              value={pollingSeconds}
              onChange={(e) => { setPollingSeconds(e.target.value); setSaved(false); }}
            />
          </Field>

          <Field label="Max agent cycles" hint="Maximum agent cycles per task before it is marked failed.">
            <FieldInput
              type="number"
              min={1}
              step={1}
              value={maxCycles}
              onChange={(e) => { setMaxCycles(e.target.value); setSaved(false); }}
            />
          </Field>

          <Field label="Max retry attempts" hint="Maximum retries per ticket before polling skips it.">
            <FieldInput
              type="number"
              min={1}
              step={1}
              value={maxRetries}
              onChange={(e) => { setMaxRetries(e.target.value); setSaved(false); }}
            />
          </Field>

          {error && <div style={{ color: "var(--danger)", fontSize: "12.5px" }}>{error}</div>}
          {saved && !dirty && <div style={{ color: "var(--accent-strong)", fontSize: "12.5px" }}>Settings saved.</div>}

          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <button className="btn primary" onClick={() => void handleSave()} disabled={saving || !dirty}>
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </div>

      <div className="eyebrow" style={{ marginBottom: "8px" }}>Runtime</div>
      <div className="card" style={{ overflow: "hidden" }}>
        {readOnlyRows.map(([k, v], i) => (
          <div
            key={k}
            style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "14px 18px",
              borderBottom: i < readOnlyRows.length - 1 ? "1px solid var(--border-soft)" : "none",
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
