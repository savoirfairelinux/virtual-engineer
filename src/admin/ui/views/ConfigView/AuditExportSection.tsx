import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { Field, FieldInput, FieldSelect } from "../../components/Modal.tsx";
import { api } from "../../api.ts";
import type { ApiAuditOptions } from "../../types.ts";

interface AuditExportSectionProps {
  onBack: () => void;
}

interface AuditExportFilters {
  actor: string;
  action: string;
  targetType: string;
  integration: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: AuditExportFilters = {
  actor: "",
  action: "",
  targetType: "",
  integration: "",
  from: "",
  to: "",
};

function exportPath(filters: AuditExportFilters): string {
  const params = new URLSearchParams();
  if (filters.actor) params.set("actor", filters.actor);
  if (filters.action) params.set("action", filters.action);
  if (filters.targetType) params.set("targetType", filters.targetType);
  if (filters.integration) params.set("integration", filters.integration);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  return `/api/admin/audit/export.csv?${params.toString()}`;
}

function triggerDownload(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "audit-export.csv";
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function AuditExportSection({ onBack }: AuditExportSectionProps) {
  const [options, setOptions] = useState<ApiAuditOptions | null>(null);
  const [filters, setFilters] = useState<AuditExportFilters>(EMPTY_FILTERS);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api.get<ApiAuditOptions>("/api/admin/audit/options")
      .then((result) => {
        if (active) setOptions(result);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Failed to load audit filters");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  function updateFilter<K extends keyof AuditExportFilters>(key: K, value: AuditExportFilters[K]): void {
    setFilters((current) => ({ ...current, [key]: value }));
    setError(null);
  }

  async function download(): Promise<void> {
    if (filters.from && filters.to && filters.from > filters.to) {
      setError("Start date must be before or equal to end date");
      return;
    }
    setExporting(true);
    setError(null);
    try {
      const blob = await api.download(exportPath(filters));
      triggerDownload(blob);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Failed to export audit log");
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <div style={{ marginBottom: "22px" }}>
        <div className="eyebrow" style={{ marginBottom: "8px" }}>Configuration / Audit / Export</div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 600, letterSpacing: "-0.01em" }}>Export audit trail</h1>
            <p style={{ margin: "6px 0 0", color: "var(--text-faint)", fontSize: "13.5px" }}>
              Choose the entries to include in the CSV download.
            </p>
          </div>
          <button className="btn" type="button" onClick={onBack} aria-label="Back to audit">
            <Icon name="chevron" size={14} style={{ transform: "rotate(180deg)" }} /> Back to audit
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            marginBottom: "14px", padding: "10px 14px",
            background: "var(--danger-soft)",
            border: "1px solid color-mix(in oklab,var(--danger) 30%, transparent)",
            borderRadius: "var(--radius-sm)", fontSize: "13px", color: "var(--danger)",
          }}
        >
          {error}
        </div>
      )}

      <div className="card" style={{ maxWidth: "900px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px" }}>
          <Field label="User">
            <FieldSelect
              aria-label="Filter by user"
              value={filters.actor}
              disabled={loading}
              onChange={(event) => updateFilter("actor", event.target.value)}
            >
              <option value="">All users</option>
              {options?.actors.map((actor) => <option key={actor} value={actor}>{actor}</option>)}
            </FieldSelect>
          </Field>
          <Field label="Action">
            <FieldSelect
              aria-label="Filter by action"
              value={filters.action}
              disabled={loading}
              onChange={(event) => updateFilter("action", event.target.value)}
            >
              <option value="">All actions</option>
              {options?.actions.map((action) => <option key={action} value={action}>{action}</option>)}
            </FieldSelect>
          </Field>
          <Field label="Target type">
            <FieldSelect
              aria-label="Filter by target type"
              value={filters.targetType}
              disabled={loading}
              onChange={(event) => updateFilter("targetType", event.target.value)}
            >
              <option value="">All target types</option>
              {options?.targetTypes.map((targetType) => <option key={targetType} value={targetType}>{targetType}</option>)}
            </FieldSelect>
          </Field>
          <Field label="Integration">
            <FieldSelect
              aria-label="Filter by integration"
              value={filters.integration}
              disabled={loading}
              onChange={(event) => updateFilter("integration", event.target.value)}
            >
              <option value="">All integrations</option>
              {options?.integrations.map((integration) => (
                <option key={integration.id} value={integration.id}>{integration.name} ({integration.id})</option>
              ))}
            </FieldSelect>
          </Field>
          <Field label="Start date">
            <FieldInput
              type="date"
              aria-label="Start date"
              value={filters.from}
              onChange={(event) => updateFilter("from", event.target.value)}
            />
          </Field>
          <Field label="End date">
            <FieldInput
              type="date"
              aria-label="End date"
              value={filters.to}
              min={filters.from || undefined}
              onChange={(event) => updateFilter("to", event.target.value)}
            />
          </Field>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "22px" }}>
          <button className="btn primary" type="button" onClick={() => void download()} disabled={loading || exporting}>
            <Icon name="file" size={14} /> {exporting ? "Preparing CSV…" : "Download CSV"}
          </button>
        </div>
      </div>
    </>
  );
}
