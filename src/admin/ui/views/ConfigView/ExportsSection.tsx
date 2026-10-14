import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { Field, FieldInput, FieldSelect, FormError } from "../../components/Modal.tsx";
import { useCurrentUser } from "../../authContext.tsx";
import { api } from "../../api.ts";
import { AuditExportSection } from "./AuditExportSection.tsx";
import type { ConfigRoute } from "./configRouting.ts";
import type { ApiProject } from "../../types.ts";

interface ExportsSectionProps {
  route: ConfigRoute;
  onNavigate: (route: ConfigRoute) => void;
  projects?: readonly ApiProject[] | undefined;
}

function AnalyticsExportPage({ onBack, projects }: { onBack: () => void; projects: readonly ApiProject[] }) {
  const [period, setPeriod] = useState("7");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [allProjects, setAllProjects] = useState(true);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [exporting, setExporting] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => { request.current?.abort(); }, []);

  function back(): void {
    request.current?.abort();
    onBack();
  }

  async function download(): Promise<void> {
    if (request.current !== null) return;
    if (period === "custom" && (!from || !to || from > to)) {
      setError("Select valid start and end dates, with the start before or equal to the end");
      return;
    }
    if (!allProjects && (projectIds.length === 0 || projectIds.length > 100)) {
      setError("Select at least one project and no more than 100 projects");
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setExporting(true);
    setDownloaded(false);
    setError(null);
    try {
      const query = new URLSearchParams();
      if (period === "custom") {
        query.set("from", from);
        query.set("to", to);
      } else if (period !== "all") query.set("days", period);
      if (!allProjects) projectIds.forEach((id) => query.append("projectId", id));
      const path = `/api/admin/overview/export.csv${query.size === 0 ? "" : `?${query.toString()}`}`;
      const blob = await api.download(path, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const suffix = period === "custom" ? `${from}_${to}` : period === "all" ? "all" : period === "1" ? "24h" : `${period}d`;
      link.download = `general-view-analytics-${suffix}.csv`;
      try {
        document.body.appendChild(link);
        link.click();
      } finally {
        link.remove();
        URL.revokeObjectURL(url);
      }
      setDownloaded(true);
    } catch (reason: unknown) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Failed to export analytics");
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setExporting(false);
      }
    }
  }

  function clearResult(): void { setError(null); setDownloaded(false); }
  const visibleProjects = projects.filter((project) => `${project.name} ${project.id}`.toLowerCase().includes(search.toLowerCase().trim()));

  return <>
    <header className="config-entity-head export-page-head">
      <button className="btn config-back" type="button" onClick={back}>
        <Icon name="chevron" size={14} style={{ transform: "rotate(180deg)" }} /> Back
      </button>
      <div className="titles">
        <div className="eyebrow" style={{ marginBottom: "8px" }}>Configuration / Exports / Analytics</div>
        <h1 className="config-entity-title" style={{ margin: 0 }}>Export analytics</h1>
      </div>
    </header>
    <form className="card export-filter-panel" data-tour="export-form" style={{ width: "100%", display: "flex", flexDirection: "column", gap: "18px" }}
      onSubmit={(event) => { event.preventDefault(); void download(); }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: "28px", alignItems: "start" }}>
        <section aria-label="Date range" style={{ display: "flex", flexDirection: "column", gap: "18px", minWidth: 0 }}>
          <Field label="Period">
            <FieldSelect value={period} disabled={exporting} onChange={(event) => {
              setPeriod(event.target.value); clearResult();
            }}>
              <option value="1">24h</option>
              <option value="7">7d</option>
              <option value="30">30d</option>
              <option value="all">All</option>
              <option value="custom">Custom dates</option>
            </FieldSelect>
          </Field>
          {period === "custom" && <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "14px" }}>
            <Field label="Start date (UTC)">
              <FieldInput type="date" value={from} disabled={exporting} onChange={(event) => { setFrom(event.target.value); clearResult(); }} />
            </Field>
            <Field label="End date (UTC)">
              <FieldInput type="date" value={to} min={from || undefined} disabled={exporting}
                onChange={(event) => { setTo(event.target.value); clearResult(); }} />
            </Field>
          </div>}
        </section>
        <fieldset disabled={exporting} style={{ margin: 0, padding: 0, border: 0, minWidth: 0 }}>
          <legend style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--text-dim)", marginBottom: "12px" }}>Projects</legend>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" }}>
            <input type="checkbox" checked={allProjects} onChange={(event) => { setAllProjects(event.target.checked); clearResult(); }} />
            All projects
          </label>
          {!allProjects && <div style={{ marginTop: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
            <FieldInput aria-label="Search projects" placeholder="Search projects" value={search} onChange={(event) => setSearch(event.target.value)} />
            <div className="mono" style={{ fontSize: "11px", color: "var(--text-faint)" }}>{projectIds.length} selected / {projects.length} projects</div>
            <div style={{ maxHeight: "280px", overflowY: "auto", borderTop: "1px solid var(--border)" }}>
              {visibleProjects.map((project) => <label key={project.id} style={{
                display: "flex", alignItems: "flex-start", gap: "8px", padding: "10px 0", borderBottom: "1px solid var(--border)",
                fontSize: "13px", overflowWrap: "anywhere",
              }}>
                <input type="checkbox" aria-label={`${project.name} (${project.id})`} checked={projectIds.includes(project.id)}
                  style={{ flex: "none", marginTop: "3px" }} onChange={(event) => {
                    setProjectIds((current) => event.target.checked ? [...current, project.id] : current.filter((id) => id !== project.id));
                    clearResult();
                  }} />
                <span style={{ minWidth: 0 }}>{project.name} <span className="mono" style={{ fontSize: "10px", color: "var(--text-faint)" }}>({project.id})</span></span>
              </label>)}
              {visibleProjects.length === 0 && <div style={{ padding: "12px 0", color: "var(--text-faint)", fontSize: "13px" }}>No projects found.</div>}
            </div>
          </div>}
        </fieldset>
      </div>
      <FormError msg={error} />
      {downloaded && <div role="status" style={{ color: "var(--ok)", fontSize: "13px" }}>CSV download started.</div>}
      <div style={{ paddingTop: "18px", display: "flex", justifyContent: "flex-end", gap: "10px", flexWrap: "wrap" }}>
        <button type="button" className="btn" onClick={back}>Cancel</button>
        <button type="submit" className="btn primary" disabled={exporting} aria-busy={exporting} style={{ minWidth: "150px" }}>
          <Icon name="file" size={14} /> {exporting ? "Downloading..." : "Download CSV"}
        </button>
      </div>
    </form>
  </>;
}

export function ExportsSection({ route, onNavigate, projects = [] }: ExportsSectionProps) {
  const { user, isAdmin, can } = useCurrentUser();
  const back = () => onNavigate({ section: "exports", mode: "list" });
  if (route.mode === "analytics" && isAdmin) return <AnalyticsExportPage key={user?.id} onBack={back} projects={projects} />;
  if (route.mode === "audit" && can("audit.read")) return <AuditExportSection key={user?.id} onBack={back} />;
  const choices = [
    ...(isAdmin ? [{ mode: "analytics" as const, label: "Analytics", icon: "grid", action: "Export analytics" }] : []),
    ...(can("audit.read") ? [{ mode: "audit" as const, label: "Audit trail", icon: "clock", action: "Export audit trail" }] : []),
  ];
  return <>
    <header style={{ marginBottom: "24px" }}>
      <div className="eyebrow" style={{ marginBottom: "8px" }}>Configuration / Operations &amp; audit</div>
      <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 600 }}>Exports</h1>
    </header>
    <section data-tour="exports-list" aria-label="Available exports" style={{ borderTop: "1px solid var(--border)", width: "100%" }}>
      {choices.map((choice) => <div key={choice.mode} style={{
        display: "flex", alignItems: "center", flexWrap: "wrap", gap: "14px", padding: "20px 0", borderBottom: "1px solid var(--border)",
      }}>
        <Icon name={choice.icon} size={20} style={{ color: "var(--text-faint)" }} />
        <h2 style={{ flex: 1, margin: 0, fontSize: "15px", fontWeight: 600 }}>{choice.label}</h2>
        <span className="mono" style={{ color: "var(--text-faint)", fontSize: "11px" }}>CSV</span>
        <button type="button" className="btn" data-tour="exports-open" aria-label={choice.action}
          onClick={() => onNavigate({ section: "exports", mode: choice.mode })}>
          <Icon name="chevron" size={14} /> Open
        </button>
      </div>)}
      {choices.length === 0 && <div role="status" style={{ padding: "20px 0" }}>No exports available.</div>}
    </section>
  </>;
}