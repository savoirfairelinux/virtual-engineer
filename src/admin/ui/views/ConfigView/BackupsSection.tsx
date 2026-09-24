import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import { Field, FieldInput } from "../../components/Modal.tsx";

interface BackupInfo {
  filename: string;
  createdAt: string;
  sizeBytes: number;
}

interface BackupSettings {
  enabled: boolean;
  intervalDays: number;
  timeOfDay: string;
  retentionCount: number;
}

interface BackupSettingsForm {
  enabled: boolean;
  intervalDays: string;
  timeOfDay: string;
  retentionCount: string;
}

interface BackupListResponse {
  backups: BackupInfo[];
  nextBackupAt: string | null;
}

interface BackupsSectionProps {
  onDirtyChange: (dirty: boolean) => void;
}

const SETTINGS_PATH = "/api/admin/backups/settings";
const BACKUPS_PATH = "/api/admin/backups";
const INITIAL_SETTINGS: BackupSettingsForm = {
  enabled: false,
  intervalDays: "1",
  timeOfDay: "03:00",
  retentionCount: "7",
};

function toForm(settings: BackupSettings): BackupSettingsForm {
  return {
    enabled: settings.enabled,
    intervalDays: String(settings.intervalDays),
    timeOfDay: settings.timeOfDay,
    retentionCount: String(settings.retentionCount),
  };
}

function formatTimestamp(value: string | null): string {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not scheduled";
  return `${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date)} UTC`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

export function BackupsSection({ onDirtyChange }: BackupsSectionProps) {
  const [form, setForm] = useState<BackupSettingsForm>(INITIAL_SETTINGS);
  const [baseline, setBaseline] = useState<BackupSettingsForm>(INITIAL_SETTINGS);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [nextBackupAt, setNextBackupAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([
      api.get<{ settings: BackupSettings }>(SETTINGS_PATH),
      api.get<BackupListResponse>(BACKUPS_PATH),
    ])
      .then(([settingsResponse, backupsResponse]) => {
        if (!active) return;
        const loadedSettings = toForm(settingsResponse.settings);
        setForm(loadedSettings);
        setBaseline(loadedSettings);
        setBackups(backupsResponse.backups);
        setNextBackupAt(backupsResponse.nextBackupAt);
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason, "Failed to load backup settings"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const dirty = form.enabled !== baseline.enabled
    || form.intervalDays !== baseline.intervalDays
    || form.timeOfDay !== baseline.timeOfDay
    || form.retentionCount !== baseline.retentionCount;

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  function updateForm<K extends keyof BackupSettingsForm>(key: K, value: BackupSettingsForm[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
    setError(null);
    setNotice(null);
  }

  async function refreshBackups(): Promise<void> {
    const response = await api.get<BackupListResponse>(BACKUPS_PATH);
    setBackups(response.backups);
    setNextBackupAt(response.nextBackupAt);
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const intervalDays = Number(form.intervalDays);
    const retentionCount = Number(form.retentionCount);
    if (!Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 365) {
      setError("Interval must be a whole number between 1 and 365 days.");
      return;
    }
    if (!Number.isInteger(retentionCount) || retentionCount < 1 || retentionCount > 100) {
      setError("Retention must be a whole number between 1 and 100 archives.");
      return;
    }
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(form.timeOfDay)) {
      setError("Backup time must be a valid UTC time.");
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await api.put<{ settings: BackupSettings }>(SETTINGS_PATH, {
        enabled: form.enabled,
        intervalDays,
        timeOfDay: form.timeOfDay,
        retentionCount,
      });
      const savedSettings = toForm(response.settings);
      setForm(savedSettings);
      setBaseline(savedSettings);
      await refreshBackups();
      setNotice("Backup schedule saved.");
    } catch (reason: unknown) {
      setError(errorMessage(reason, "Failed to save backup settings"));
    } finally {
      setSaving(false);
    }
  }

  async function runBackup(): Promise<void> {
    setRunning(true);
    setError(null);
    setNotice(null);
    try {
      const response = await api.post<{ backup: BackupInfo }>(BACKUPS_PATH);
      setNotice(`Backup created: ${response.backup.filename}`);
      await refreshBackups();
    } catch (reason: unknown) {
      setError(errorMessage(reason, "Failed to create backup"));
    } finally {
      setRunning(false);
    }
  }

  async function downloadBackup(backup: BackupInfo): Promise<void> {
    setDownloading(backup.filename);
    setError(null);
    setNotice(null);
    try {
      const blob = await api.download(`${BACKUPS_PATH}/${encodeURIComponent(backup.filename)}/download`);
      triggerDownload(blob, backup.filename);
    } catch (reason: unknown) {
      setError(errorMessage(reason, "Failed to download backup"));
    } finally {
      setDownloading(null);
    }
  }

  async function deleteBackup(backup: BackupInfo): Promise<void> {
    if (!window.confirm(`Delete backup ${backup.filename}?`)) return;
    setDeleting(backup.filename);
    setError(null);
    setNotice(null);
    try {
      await api.delete(`${BACKUPS_PATH}/${encodeURIComponent(backup.filename)}`);
      await refreshBackups();
      setNotice("Backup deleted.");
    } catch (reason: unknown) {
      setError(errorMessage(reason, "Failed to delete backup"));
    } finally {
      setDeleting(null);
    }
  }

  const newestBackup = backups[0];

  return (
    <>
      <div style={{ marginBottom: "22px" }}>
        <div className="eyebrow" style={{ marginBottom: "8px" }}>Configuration / Operations / Backups</div>
        <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 600 }}>Backups</h1>
        <p style={{ margin: "6px 0 0", color: "var(--text-faint)", fontSize: "13.5px" }}>
          Manage scheduled snapshots and recovery archives.
        </p>
      </div>

      {error && (
        <div role="alert" style={{
          marginBottom: "14px", padding: "10px 14px", background: "var(--danger-soft)",
          border: "1px solid color-mix(in oklab,var(--danger) 30%, transparent)",
          borderRadius: "var(--radius-sm)", fontSize: "13px", color: "var(--danger)",
        }}>
          {error}
        </div>
      )}
      {notice && <div role="status" aria-live="polite" style={{ marginBottom: "14px", color: "var(--success, var(--accent-strong))", fontSize: "13px" }}>{notice}</div>}

      <section className="card" aria-labelledby="backup-schedule-title" data-tour="backups-schedule" style={{ maxWidth: "960px", padding: "20px 22px", marginBottom: "18px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px", marginBottom: "18px" }}>
          <div>
            <h2 id="backup-schedule-title" style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>Schedule</h2>
            <p style={{ margin: "5px 0 0", color: "var(--text-faint)", fontSize: "12.5px" }}>
              Next backup: {form.enabled ? formatTimestamp(nextBackupAt) : "Disabled"}
            </p>
            <p style={{ margin: "4px 0 0", color: "var(--text-faint)", fontSize: "12.5px" }}>
              Last backup: {newestBackup ? formatTimestamp(newestBackup.createdAt) : "None yet"}
            </p>
          </div>
          <button className="btn" type="button" data-tour="backups-run-now" onClick={() => void runBackup()} disabled={loading || running}>
            <Icon name="refresh" size={14} /> {running ? "Creating…" : "Run backup now"}
          </button>
        </div>

        <form onSubmit={(event) => void saveSettings(event)}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 190px), 1fr))", gap: "16px", alignItems: "end" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "9px", minHeight: "38px", fontSize: "13px", color: "var(--text-dim)" }}>
              <input
                type="checkbox"
                aria-label="Enable scheduled backups"
                checked={form.enabled}
                disabled={loading || saving}
                onChange={(event) => updateForm("enabled", event.target.checked)}
              />
              Enable scheduled backups
            </label>
            <Field label="Interval (days)">
              <FieldInput
                type="number"
                min={1}
                max={365}
                step={1}
                aria-label="Interval (days)"
                value={form.intervalDays}
                disabled={loading || saving}
                onChange={(event) => updateForm("intervalDays", event.target.value)}
              />
            </Field>
            <Field label="Backup time (UTC)">
              <FieldInput
                type="time"
                aria-label="Backup time (UTC)"
                value={form.timeOfDay}
                disabled={loading || saving}
                onChange={(event) => updateForm("timeOfDay", event.target.value)}
              />
            </Field>
            <Field label="Retention (archives)">
              <FieldInput
                type="number"
                min={1}
                max={100}
                step={1}
                aria-label="Retention (archives)"
                value={form.retentionCount}
                disabled={loading || saving}
                onChange={(event) => updateForm("retentionCount", event.target.value)}
              />
            </Field>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "18px" }}>
            <button className="btn primary" type="submit" disabled={loading || saving}>
              <Icon name="check" size={14} /> {saving ? "Saving…" : "Save schedule"}
            </button>
          </div>
        </form>
      </section>

      <section aria-labelledby="backup-archives-title" data-tour="backups-archives" style={{ maxWidth: "960px", marginBottom: "18px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginBottom: "10px" }}>
          <h2 id="backup-archives-title" style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>Archives</h2>
          <span className="mono" style={{ color: "var(--text-faint)", fontSize: "11.5px" }}>{backups.length} total</span>
        </div>
        {loading ? (
          <p style={{ color: "var(--text-faint)", fontSize: "13px" }}>Loading backups…</p>
        ) : backups.length === 0 ? (
          <p style={{ color: "var(--text-faint)", fontSize: "13px" }}>No backup archives yet.</p>
        ) : (
          <div role="list" aria-label="Backup archives">
            {backups.map((backup) => (
              <div
                role="listitem"
                key={backup.filename}
                style={{
                  display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 16px",
                  padding: "12px 0", borderBottom: "1px solid var(--border-soft)",
                }}
              >
                <div style={{ flex: "1 1 280px", minWidth: 0 }}>
                  <div className="mono" style={{ overflowWrap: "anywhere", fontSize: "12px", color: "var(--text)" }}>{backup.filename}</div>
                  <div style={{ marginTop: "4px", color: "var(--text-faint)", fontSize: "11.5px" }}>
                    {formatTimestamp(backup.createdAt)} · {formatBytes(backup.sizeBytes)}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "8px", marginLeft: "auto" }}>
                  <button
                    className="btn"
                    type="button"
                    aria-label={`Download backup ${backup.filename}`}
                    title="Download backup"
                    disabled={downloading === backup.filename}
                    onClick={() => void downloadBackup(backup)}
                  >
                    <Icon name="file" size={14} /> {downloading === backup.filename ? "Downloading…" : "Download"}
                  </button>
                  <button
                    className="iconbtn"
                    type="button"
                    aria-label={`Delete backup ${backup.filename}`}
                    title="Delete backup"
                    disabled={deleting === backup.filename}
                    onClick={() => void deleteBackup(backup)}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <aside
        aria-label="Backup recovery guidance"
        data-tour="backups-recovery-guidance"
        style={{ maxWidth: "960px", padding: "12px 14px", borderLeft: "3px solid var(--accent)", background: "var(--panel-2)", color: "var(--text-dim)", fontSize: "12.5px" }}
      >
        <p style={{ margin: 0 }}>Copy backup archives off this machine; local retention alone is not disaster recovery.</p>
        <p style={{ margin: "6px 0 0" }}>Stop the existing instance before restoring an archive. Restore requires the same ADMIN_AUTH_SECRET.</p>
      </aside>
    </>
  );
}