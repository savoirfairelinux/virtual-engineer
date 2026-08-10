import { Toggle } from "../../components/Toggle.tsx";
import { Tag } from "../../components/Tag.tsx";
import { Icon } from "../../components/Icon.tsx";
import { RowCard } from "../../components/RowCard.tsx";
import { api } from "../../api.ts";
import { useEffect, useState } from "react";
import { useCurrentUser } from "../../authContext.tsx";
import { ProjectFormModal } from "./ProjectFormModal.tsx";
import { ProjectDrawer } from "./ConfigDrawers.tsx";
import type { ApiProject } from "../../types.ts";
import type { ConfigSectionProps } from "./index.tsx";

interface ApiProjectDetail extends ApiProject {
  ticketSource?: {
    integration: { id: string; name: string; type: string } | null;
    ticketProjectKey: string;
  } | null;
  reviewConfig?: {
    integration: { id: string; name: string; type: string } | null;
    repos: string[];
  } | null;
  pushTargets?: Array<{
    integrationId: string;
    repoKey: string;
    cloneUrl: string;
    targetBranch: string;
    role: "primary" | "submodule" | "dependency" | "related";
    commitOrder: number;
    localPath: string;
  }>;
  postCloneScript?: string;
  gerritTopicOverride?: string | null;
  useFullTicketUrlInCommits?: boolean;
  postReviewLinkToTicket?: boolean;
  reactToCiFailures?: boolean;
}

export function ProjectsSection({ projects, agents, integrations, onRefresh, route, navigate, markClean }: ConfigSectionProps) {
  const { can } = useCurrentUser();
  const [busy, setBusy] = useState<string | null>(null);
  const [editingProject, setEditingProject] = useState<ApiProjectDetail | null>(null);
  const detailId = route.section === "projects" && route.mode === "detail" ? route.id : null;
  const editingId = route.section === "projects" && route.mode === "edit" ? route.id : null;
  const detailItem = detailId ? projects.find((project) => project.id === detailId) : undefined;

  useEffect(() => {
    if (!editingId) {
      setEditingProject(null);
      return;
    }
    let cancelled = false;
    setBusy(editingId);
    void api.get<{ project: ApiProjectDetail }>(`/api/admin/projects/${editingId}`)
      .then(({ project }) => { if (!cancelled) setEditingProject(project); })
      .catch((error: unknown) => {
        if (cancelled) return;
        alert(error instanceof Error ? error.message : "Failed to load project details");
        navigate({ section: "projects", mode: "list" });
      })
      .finally(() => { if (!cancelled) setBusy(null); });
    return () => { cancelled = true; };
  }, [editingId, navigate]);

  async function toggleEnabled(id: string, enabled: boolean) {
    setBusy(id);
    try {
      await api.patch(`/api/admin/projects/${id}/${enabled ? "disable" : "enable"}`);
      onRefresh();
    } finally {
      setBusy(null);
    }
  }

  async function deleteProject(p: ApiProject): Promise<boolean> {
    if (!window.confirm(`Delete project "${p.name}"? All tasks for this project will be orphaned.`)) return false;
    setBusy(p.id);
    try {
      await api.delete(`/api/admin/projects/${p.id}`);
      onRefresh();
      return true;
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
      return false;
    } finally {
      setBusy(null);
    }
  }

  function agentName(id: string | null | undefined): string {
    if (!id) return "—";
    return agents.find((a) => a.id === id)?.name ?? id.slice(0, 12);
  }

  function handleSaved() {
    markClean();
    onRefresh();
    navigate(editingId
      ? { section: "projects", mode: "detail", id: editingId }
      : { section: "projects", mode: "list" });
  }

  if (route.mode === "detail") {
    if (!detailItem) return <ProjectMissing onBack={() => navigate({ section: "projects", mode: "list" })} />;
    return (
      <ProjectDrawer
        item={detailItem}
        agents={agents}
        onClose={() => navigate({ section: "projects", mode: "list" })}
        {...(can("project.write", detailItem.id) ? { onEdit: () => navigate({ section: "projects", mode: "edit", id: detailItem.id }) } : {})}
        {...(can("project.operate", detailItem.id) ? { onToggle: () => { void toggleEnabled(detailItem.id, detailItem.enabled); } } : {})}
        {...(can("project.delete", detailItem.id) ? { onDelete: () => { void deleteProject(detailItem).then((deleted) => { if (deleted) navigate({ section: "projects", mode: "list" }); }); } } : {})}
      />
    );
  }

  if (route.mode === "create" || route.mode === "edit") {
    if (route.mode === "edit" && !editingProject) {
      return <div className="placeholder config-page-loading">{busy ? "Loading project…" : "Project unavailable."}</div>;
    }
    return (
      <ProjectFormModal
        agents={agents}
        integrations={integrations}
        {...(route.mode === "edit" && editingProject ? { project: editingProject } : {})}
        onClose={() => navigate(editingId
          ? { section: "projects", mode: "detail", id: editingId }
          : { section: "projects", mode: "list" })}
        onSaved={handleSaved}
      />
    );
  }

  return (
    <>
      <div style={{ marginBottom: "22px" }}>
        <div className="eyebrow" style={{ marginBottom: "8px" }}>Configuration / Projects</div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 600, letterSpacing: "-0.01em" }}>Projects</h1>
            <p style={{ margin: "6px 0 0", color: "var(--text-faint)", fontSize: "13.5px" }}>Execution units binding an agent to ticket sources and push / review targets.</p>
          </div>
          {can("project.write") && (
            <button className="btn primary" onClick={() => navigate({ section: "projects", mode: "create" })}>
              <Icon name="plus" size={14} /> New project
            </button>
          )}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {projects.length === 0 && (
          <div className="placeholder" style={{ minHeight: "120px" }}>No projects configured.</div>
        )}
        {projects.map((p) => (
          <RowCard key={p.id} ariaLabel={`Open project ${p.name}`} onClick={() => navigate({ section: "projects", mode: "detail", id: p.id })}>
            <span
              style={{
                width: 36, height: 36, borderRadius: "8px",
                display: "grid", placeItems: "center",
                background: "var(--panel-2)", color: "var(--text-faint)",
                border: "1px solid var(--border-soft)", flex: "none",
              }}
            >
              <Icon name="box" size={17} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
                <span style={{ fontSize: "13.5px", fontWeight: 600 }}>{p.name}</span>
                <Tag tone={p.type === "review" ? "warn" : "active"} mono={false}>{p.type}</Tag>
              </div>
              <div style={{ fontSize: "12px", color: "var(--text-faint)", marginTop: "3px" }}>
                Agent: {agentName(p.agentId)} · created {new Date(p.createdAt).toLocaleDateString()}
              </div>
            </div>
            <div onClick={(e) => e.stopPropagation()}>
              {can("project.operate", p.id) && (
                <Toggle
                  on={p.enabled}
                  label={`Project ${p.name} enabled`}
                  disabled={busy === p.id}
                  onChange={() => void toggleEnabled(p.id, p.enabled)}
                />
              )}
            </div>
            {can("project.write", p.id) && (
              <button
                className="iconbtn"
                title="Edit"
                disabled={busy === p.id}
                onClick={(e) => { e.stopPropagation(); navigate({ section: "projects", mode: "edit", id: p.id }); }}
              >
                <Icon name="edit" size={14} />
              </button>
            )}
            {can("project.delete", p.id) && (
              <button
                className="iconbtn"
                title="Delete"
                disabled={busy === p.id}
                onClick={(e) => { e.stopPropagation(); void deleteProject(p); }}
              >
                <Icon name="trash" size={14} />
              </button>
            )}
          </RowCard>
        ))}
      </div>

    </>
  );
}

function ProjectMissing({ onBack }: { onBack: () => void }) {
  return (
    <div className="config-missing">
      <div className="placeholder">This project is unavailable or you do not have access.</div>
      <button className="btn" onClick={onBack}>Back to projects</button>
    </div>
  );
}
