import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api.ts";
import type { ApiSystemUpdate, ApiUpdateState } from "../../types.ts";

const POLL_INTERVAL_MS = 5_000;

const STATE_LABELS: Record<ApiUpdateState, string> = {
  preparing: "Preparing",
  draining: "Waiting for running agent cycles",
  starting: "Starting the new version",
  verifying: "Verifying the new version",
  rolling_back: "Rolling back",
  succeeded: "Update complete",
  failed: "Update failed",
  rolled_back: "Update rolled back",
};

const ROW_STYLE = {
  display: "flex", justifyContent: "space-between", alignItems: "center", gap: "16px",
  padding: "12px 18px", borderBottom: "1px solid var(--border-soft)",
} as const;

function formatBuild(current: ApiSystemUpdate["current"]): string {
  return [`v${current.version}`, current.gitSha].filter(Boolean).join(" · ");
}

interface UpdatesPanelProps {
  canWrite: boolean;
  /** Overrides the status poll interval (tests). */
  pollIntervalMs?: number | undefined;
}

/**
 * Release updates. Updates run on the host (`scripts/update.sh`): the button
 * only files a request that the host updater service picks up, so the panel
 * keeps polling through the orchestrator restart.
 */
export function UpdatesPanel({ canWrite, pollIntervalMs = POLL_INTERVAL_MS }: UpdatesPanelProps) {
  const [data, setData] = useState<ApiSystemUpdate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [updatedTo, setUpdatedTo] = useState<string | null>(null);
  const startedFrom = useRef<string | null>(null);

  const load = useCallback(async (refresh: boolean): Promise<void> => {
    try {
      const next = await api.get<ApiSystemUpdate>(`/api/admin/system/update${refresh ? "?refresh=1" : ""}`);
      if (next.inProgress) startedFrom.current ??= next.current.version;
      if (startedFrom.current !== null && next.current.version !== startedFrom.current) {
        setUpdatedTo(next.current.version);
        startedFrom.current = null;
      }
      setData(next);
      setRestarting(false);
      setError(null);
    } catch (e) {
      if (startedFrom.current !== null) {
        setRestarting(true);
        return;
      }
      setError(e instanceof Error ? e.message : "Failed to load update information");
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const polling = restarting || data?.inProgress === true;
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => { void load(false); }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [polling, load, pollIntervalMs]);

  async function handleCheck(): Promise<void> {
    setChecking(true);
    try {
      await load(true);
    } finally {
      setChecking(false);
    }
  }

  async function handleUpdate(version: string): Promise<void> {
    const confirmed = window.confirm(
      `Update Virtual Engineer to v${version}?\n\n`
      + "Running agent cycles finish first and no new work starts meanwhile. The admin UI is unavailable "
      + "for about a minute while the new version starts. If it fails its health check, the previous "
      + "version and database are restored.",
    );
    if (!confirmed) return;
    setError(null);
    setRequesting(true);
    try {
      const next = await api.post<ApiSystemUpdate>("/api/admin/system/update", { version });
      startedFrom.current = next.current.version;
      setData(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the update");
    } finally {
      setRequesting(false);
    }
  }

  if (!data) {
    return error ? <div style={{ color: "var(--danger)", fontSize: "12.5px", marginBottom: "22px" }}>{error}</div> : null;
  }

  const status = data.status;
  const latestVersion = data.latest?.version;
  const showStatus = status !== null && (data.inProgress || startedFrom.current !== null || status.state !== "succeeded");
  const statusFailed = status?.state === "failed" || status?.state === "rolled_back";

  return (
    <>
      <div className="eyebrow" style={{ marginBottom: "8px" }}>Updates</div>
      <div className="card" data-testid="system-updates" style={{ overflow: "hidden", marginBottom: "22px" }}>
        <div style={ROW_STYLE}>
          <span style={{ fontSize: "13px", fontWeight: 500 }}>Running version</span>
          <span className="mono" style={{ fontSize: "12px", color: "var(--text-dim)" }}>{formatBuild(data.current)}</span>
        </div>
        <div style={ROW_STYLE}>
          <span style={{ fontSize: "13px", fontWeight: 500 }}>Latest release</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "12px" }}>
            {data.latest ? (
              <a className="mono" href={data.latest.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: "12px" }}>
                v{data.latest.version}
              </a>
            ) : (
              <span className="mono" style={{ fontSize: "12px", color: "var(--text-faint)" }}>unknown</span>
            )}
            <button className="btn" onClick={() => void handleCheck()} disabled={checking}>
              {checking ? "Checking…" : "Check now"}
            </button>
          </span>
        </div>
        <div style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: "10px", fontSize: "12.5px" }}>
          {data.latestError && <div style={{ color: "var(--warn)" }}>{data.latestError}</div>}
          {updatedTo && (
            <div role="status" style={{ color: "var(--accent-strong)", display: "flex", alignItems: "center", gap: "10px" }}>
              Updated to v{updatedTo}. Reload to use the new admin UI.
              <button className="btn" onClick={() => window.location.reload()}>Reload</button>
            </div>
          )}
          {restarting && <div role="status" style={{ color: "var(--text-dim)" }}>The orchestrator is restarting…</div>}
          {!restarting && data.request && (
            <div role="status" style={{ color: "var(--text-dim)" }}>Update to v{data.request.version} requested; waiting for the host updater…</div>
          )}
          {!restarting && !data.request && showStatus && status && (
            <div role="status" style={{ color: statusFailed ? "var(--danger)" : "var(--text-dim)" }}>
              <b>{STATE_LABELS[status.state]}</b>{status.message ? ` — ${status.message}` : ""}
            </div>
          )}
          {!data.updateAvailable && data.latest && !data.inProgress && (
            <div style={{ color: "var(--text-faint)" }}>This is the latest release.</div>
          )}
          {data.updateAvailable && data.latest && !data.updaterInstalled && (
            <div style={{ color: "var(--text-faint)" }}>
              To update from here, install the host updater once with{" "}
              <span className="mono">./scripts/update.sh --install-service</span>, or run{" "}
              <span className="mono">./scripts/update.sh</span> on the host.
            </div>
          )}
          {error && <div style={{ color: "var(--danger)" }}>{error}</div>}
          {canWrite && data.updateAvailable && latestVersion && data.updaterInstalled && !data.inProgress && !restarting && (
            <div>
              <button className="btn primary" onClick={() => void handleUpdate(latestVersion)} disabled={requesting}>
                {requesting ? "Requesting…" : `Update to v${latestVersion}`}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
