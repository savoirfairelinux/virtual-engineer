import { Toggle } from "../../components/Toggle.tsx";
import { Tag } from "../../components/Tag.tsx";
import { Icon } from "../../components/Icon.tsx";
import { RowCard } from "../../components/RowCard.tsx";
import { api } from "../../api.ts";
import { useState } from "react";
import { ProjectFormModal } from "./ProjectFormModal.tsx";
import { ProjectDrawer } from "./ConfigDrawers.tsx";
import type { ApiProject } from "../../types.ts";
import type { ConfigViewData } from "./index.tsx";

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
  skillDiscoveryEnabled?: boolean;
}

export function ProjectsSection({ projects, agents, integrations, onRefresh }: ConfigViewData) {
  const [busy, setBusy] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editingProject, setEditingProject] = useState<ApiProjectDetail | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);

  const drawerItem = drawerId ? projects.find((p) => p.id === drawerId) : undefined;

  async function toggleEnabled(id: string, enabled: boolean) {
    setBusy(id);
    try {
      await api.patch(`/api/admin/projects/${id}/${enabled ? "disable" : "enable"}`);
      onRefresh();
    } finally {
      setBusy(null);
    }
  }

  async function deleteProject(p: ApiProject) {
    if (!window.confirm(`Delete project "${p.name}"? All tasks for this project will be orphaned.`)) return;
    setBusy(p.id);
    try {
      await api.delete(`/api/admin/projects/${p.id}`);
      onRefresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(null);
    }
  }

  async function openEditProject(projectId: string) {
    setBusy(projectId);
    try {
      const { project } = await api.get<{ project: ApiProjectDetail }>(`/api/admin/projects/${projectId}`);
      setEditingProject(project);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to load project details");
    } finally {
      setBusy(null);
    }
  }

  function agentName(id: string | null | undefined): string {
    if (!id) return "—";
    return agents.find((a) => a.id === id)?.name ?? id.slice(0, 12);
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
          <button className="btn primary" onClick={() => setShowAdd(true)}>
            <Icon name="plus" size={14} /> New project
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {projects.length === 0 && (
          <div className="placeholder" style={{ minHeight: "120px" }}>No projects configured.</div>
        )}
        {projects.map((p) => (
          <RowCard key={p.id} onClick={() => setDrawerId(p.id)}>
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
              <Toggle
                on={p.enabled}
                disabled={busy === p.id}
                onChange={() => void toggleEnabled(p.id, p.enabled)}
              />
            </div>
            <button
              className="iconbtn"
              title="Edit"
              disabled={busy === p.id}
              onClick={(e) => { e.stopPropagation(); void openEditProject(p.id); }}
            >
              <Icon name="edit" size={14} />
            </button>
            <button
              className="iconbtn"
              title="Delete"
              disabled={busy === p.id}
              onClick={(e) => { e.stopPropagation(); void deleteProject(p); }}
            >
              <Icon name="trash" size={14} />
            </button>
          </RowCard>
        ))}
      </div>

      {/* Detail drawer */}
      {drawerItem && (
        <ProjectDrawer
          item={drawerItem}
          agents={agents}
          onClose={() => setDrawerId(null)}
          onEdit={() => { setDrawerId(null); void openEditProject(drawerItem.id); }}
          onToggle={() => { void toggleEnabled(drawerItem.id, drawerItem.enabled); setDrawerId(null); }}
          onDelete={() => { void deleteProject(drawerItem); setDrawerId(null); }}
        />
      )}

      {showAdd && (
        <ProjectFormModal
          agents={agents}
          integrations={integrations}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); onRefresh(); }}
        />
      )}

      {editingProject && (
        <ProjectFormModal
          agents={agents}
          integrations={integrations}
          project={editingProject}
          onClose={() => setEditingProject(null)}
          onSaved={() => { setEditingProject(null); onRefresh(); }}
        />
      )}
    </>
  );
}
