import { useEffect, useState } from "react";
import { Field, FieldInput } from "../../components/Modal.tsx";
import { api } from "../../api.ts";
import { useCurrentUser } from "../../authContext.tsx";
import type { ApiConfig, ApiStatus } from "../../types.ts";

interface SystemSectionProps {
  config: ApiConfig["config"] | null;
  status: ApiStatus | null;
  onRefresh: () => void;
  onDirtyChange: (dirty: boolean) => void;
}

interface EditableSettings {
  pollingIntervalMs: number;
  maxAgentCycles: number;
  maxRetryAttempts: number;
  agentTimeoutMs: number;
}

export function SystemSection({ config, status, onRefresh, onDirtyChange }: SystemSectionProps) {
  const { can } = useCurrentUser();
  const canWrite = can("system.write");
  const runtime = status?.runtime;
  const polling = status?.polling;

  const initialPollingSeconds = Math.max(
    1,
    Math.round((config?.pollingIntervalMs ?? polling?.intervalMs ?? 30000) / 1000)
  );
  const initialCycles = config?.maxAgentCycles ?? runtime?.maxAgentCycles ?? 3;
  const initialRetries = config?.maxRetryAttempts ?? runtime?.maxRetryAttempts ?? 5;
  const initialTimeoutMs = config?.agentTimeoutMs ?? 3_600_000;
  const initialTimeoutMinutes = Math.max(1, Math.round(initialTimeoutMs / 60_000));

  const [pollingSeconds, setPollingSeconds] = useState(String(initialPollingSeconds));
  const [maxCycles, setMaxCycles] = useState(String(initialCycles));
  const [maxRetries, setMaxRetries] = useState(String(initialRetries));
  const [agentTimeoutMinutes, setAgentTimeoutMinutes] = useState(String(initialTimeoutMinutes));
  const [baseline, setBaseline] = useState<EditableSettings>({
    pollingIntervalMs: initialPollingSeconds * 1000,
    maxAgentCycles: initialCycles,
    maxRetryAttempts: initialRetries,
    agentTimeoutMs: initialTimeoutMs,
  });
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
    setAgentTimeoutMinutes(String(initialTimeoutMinutes));
    setBaseline({
      pollingIntervalMs: initialPollingSeconds * 1000,
      maxAgentCycles: initialCycles,
      maxRetryAttempts: initialRetries,
      agentTimeoutMs: initialTimeoutMs,
    });
  }, [initialPollingSeconds, initialCycles, initialRetries, initialTimeoutMs, initialTimeoutMinutes]);

  const dirty =
    Number(pollingSeconds) * 1000 !== baseline.pollingIntervalMs ||
    Number(maxCycles) !== baseline.maxAgentCycles ||
    Number(maxRetries) !== baseline.maxRetryAttempts ||
    Number(agentTimeoutMinutes) * 60_000 !== baseline.agentTimeoutMs;

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  function validate(): EditableSettings | string {
    const seconds = Number(pollingSeconds);
    const cycles = Number(maxCycles);
    const retries = Number(maxRetries);
    const timeoutMinutes = Number(agentTimeoutMinutes);
    if (!Number.isInteger(seconds) || seconds <= 0) return "Polling interval must be a positive whole number of seconds.";
    if (!Number.isInteger(cycles) || cycles <= 0) return "Max cycles must be a positive whole number.";
    if (!Number.isInteger(retries) || retries <= 0) return "Max retries must be a positive whole number.";
    if (!Number.isInteger(timeoutMinutes) || timeoutMinutes <= 0) return "Agent timeout must be a positive whole number of minutes.";
    return {
      pollingIntervalMs: seconds * 1000,
      maxAgentCycles: cycles,
      maxRetryAttempts: retries,
      agentTimeoutMs: timeoutMinutes * 60_000,
    };
  }

  async function handleSave() {
    setError(null);
    setSaved(false);
    const result = validate();
    if (typeof result === "string") {
      setError(result);
      return;
    }
    // Build a partial patch with only the fields that actually changed so we
    // never accidentally overwrite a server-side value the user didn't touch.
    const patch: Partial<typeof result> = {};
    if (result.pollingIntervalMs !== baseline.pollingIntervalMs) patch.pollingIntervalMs = result.pollingIntervalMs;
    if (result.maxAgentCycles !== baseline.maxAgentCycles) patch.maxAgentCycles = result.maxAgentCycles;
    if (result.maxRetryAttempts !== baseline.maxRetryAttempts) patch.maxRetryAttempts = result.maxRetryAttempts;
    if (result.agentTimeoutMs !== baseline.agentTimeoutMs) patch.agentTimeoutMs = result.agentTimeoutMs;
    setSaving(true);
    try {
      await api.put("/api/admin/settings", patch);
      setBaseline(result);
      onDirtyChange(false);
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
              disabled={!canWrite}
              value={pollingSeconds}
              onChange={(e) => { setPollingSeconds(e.target.value); setSaved(false); }}
            />
          </Field>

          <Field label="Max agent cycles" hint="Maximum agent cycles per task before it is marked failed.">
            <FieldInput
              type="number"
              min={1}
              step={1}
              disabled={!canWrite}
              value={maxCycles}
              onChange={(e) => { setMaxCycles(e.target.value); setSaved(false); }}
            />
          </Field>

          <Field label="Max retry attempts" hint="Maximum retries per ticket before polling skips it.">
            <FieldInput
              type="number"
              min={1}
              step={1}
              disabled={!canWrite}
              value={maxRetries}
              onChange={(e) => { setMaxRetries(e.target.value); setSaved(false); }}
            />
          </Field>

          <Field label="Agent timeout (minutes)" hint="Maximum time an agent cycle may run before it is stopped.">
            <FieldInput
              type="number"
              min={1}
              step={1}
              disabled={!canWrite}
              value={agentTimeoutMinutes}
              onChange={(e) => { setAgentTimeoutMinutes(e.target.value); setSaved(false); }}
            />
          </Field>

          {error && <div style={{ color: "var(--danger)", fontSize: "12.5px" }}>{error}</div>}
          {saved && !dirty && <div style={{ color: "var(--accent-strong)", fontSize: "12.5px" }}>Settings saved.</div>}

          {canWrite && (
            <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
              <button className="btn primary" onClick={() => void handleSave()} disabled={saving || !dirty}>
                {saving ? "Saving…" : "Save changes"}
              </button>
            </div>
          )}
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
