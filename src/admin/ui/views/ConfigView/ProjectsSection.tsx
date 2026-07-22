import { Toggle } from "../../components/Toggle.tsx";
import { Tag } from "../../components/Tag.tsx";
import { Icon } from "../../components/Icon.tsx";
import { RowCard } from "../../components/RowCard.tsx";
import { api } from "../../api.ts";
import { useEffect, useState } from "react";
import { makeHasPermission, useCurrentUser } from "../../authContext.tsx";
import { ProjectFormModal } from "./ProjectFormModal.tsx";
import { ProjectDrawer } from "./ConfigDrawers.tsx";
import { ProjectStatisticsView } from "./ProjectStatisticsView.tsx";
import { FieldSelect, Modal } from "../../components/Modal.tsx";
import type { ApiMe, ApiProject } from "../../types.ts";
import type { ConfigSectionProps } from "./index.tsx";

interface ApiProjectDetail extends ApiProject {
  ticketSource?: {
    integration: { id: string; name: string; type: string } | null;
    ticketProjectKey: string;
  } | null;
  reviewConfig?: {
    integration: { id: string; name: string; type: string } | null;
    repos: string[];
    assignmentMode?: "manual" | "automatic";
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

export function canViewProjectStatistics(
  project: ApiProject,
  user: ApiMe | null,
  isAdmin: boolean,
  hasStatisticsPermission: boolean,
): boolean {
  return hasStatisticsPermission && (isAdmin || project.ownerUserId === user?.id);
}

export function ProjectsSection({ projects, agents, integrations, onRefresh, route, navigate, markClean }: ConfigSectionProps) {
  const [accessProject, setAccessProject] = useState<ApiProject | null>(null);
  const { can, isAdmin, user } = useCurrentUser();
  const hasStatisticsPermission = makeHasPermission(user)("project.statistics.read");
  const [busy, setBusy] = useState<string | null>(null);
  const [editingProject, setEditingProject] = useState<ApiProjectDetail | null>(null);
  const detailId = route.section === "projects" && route.mode === "detail" ? route.id : null;
  const editingId = route.section === "projects" && route.mode === "edit" ? route.id : null;
  const statisticsId = route.section === "projects" && route.mode === "statistics" ? route.id : null;
  const detailItem = detailId ? projects.find((project) => project.id === detailId) : undefined;
  const statisticsItem = statisticsId ? projects.find((project) => project.id === statisticsId) : undefined;

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

  async function resyncProject(id: string) {
    setBusy(id);
    try {
      const { resyncedCount } = await api.post<{ resyncedCount: number }>(`/api/admin/projects/${id}/resync`);
      onRefresh();
      alert(`Resynced ${resyncedCount} active task(s).`);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Resync failed");
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

  if (route.mode === "statistics") {
    if (!statisticsItem || !canViewProjectStatistics(statisticsItem, user, isAdmin, hasStatisticsPermission)) {
      return <ProjectMissing onBack={() => navigate({ section: "projects", mode: "list" })} />;
    }
    return (
      <ProjectStatisticsView
        project={statisticsItem}
        onBack={() => navigate({ section: "projects", mode: "detail", id: statisticsItem.id })}
      />
    );
  }

  if (route.mode === "detail") {
    if (!detailItem) return <ProjectMissing onBack={() => navigate({ section: "projects", mode: "list" })} />;
    if (accessProject) {
      return <ProjectAccessEditor project={accessProject} onClose={() => setAccessProject(null)} />;
    }
    return (
      <ProjectDrawer
        item={detailItem}
        agents={agents}
        onClose={() => navigate({ section: "projects", mode: "list" })}
        {...(can("project.owner", detailItem.id, detailItem.ownerUserId ?? null)
          ? { onAccess: () => setAccessProject(detailItem) }
          : {})}
        {...(canViewProjectStatistics(detailItem, user, isAdmin, hasStatisticsPermission)
          ? { onStatistics: () => navigate({ section: "projects", mode: "statistics", id: detailItem.id }) }
          : {})}
        {...(can("project.write", detailItem.id, detailItem.ownerUserId ?? null) ? { onEdit: () => navigate({ section: "projects", mode: "edit", id: detailItem.id }) } : {})}
        {...(can("project.operate", detailItem.id, detailItem.ownerUserId ?? null) ? { onToggle: () => { void toggleEnabled(detailItem.id, detailItem.enabled); } } : {})}
        {...(can("project.delete", detailItem.id, detailItem.ownerUserId ?? null) ? { onDelete: () => { void deleteProject(detailItem).then((deleted) => { if (deleted) navigate({ section: "projects", mode: "list" }); }); } } : {})}
        {...(can("project.operate", detailItem.id, detailItem.ownerUserId ?? null) && detailItem.type === "coding"
          ? { onResync: () => { void resyncProject(detailItem.id); } }
          : {})}
      />
    );
  }

  if (route.mode === "create" || route.mode === "edit") {
    if (route.mode === "edit" && !editingProject) {
      return <div className="placeholder config-page-loading">{busy ? "Loading project…" : "Project unavailable."}</div>;
    }
    if (route.mode === "edit" && editingProject && !can("project.write", editingProject.id, editingProject.ownerUserId ?? null)) {
      return <ProjectMissing onBack={() => navigate({ section: "projects", mode: "list" })} />;
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
          {can("project.create") && (
            <button className="btn primary" data-tour="projects-new-button" onClick={() => navigate({ section: "projects", mode: "create" })}>
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
              {can("project.operate", p.id, p.ownerUserId ?? null) && (
                <Toggle
                  on={p.enabled}
                  label={`Project ${p.name} enabled`}
                  disabled={busy === p.id}
                  onChange={() => void toggleEnabled(p.id, p.enabled)}
                />
              )}
            </div>
            {can("project.operate", p.id, p.ownerUserId ?? null) && p.type === "coding" && (
              <button
                className="iconbtn"
                title="Resync now (re-check active tasks instead of waiting for the next poll)"
                disabled={busy === p.id}
                onClick={(e) => { e.stopPropagation(); void resyncProject(p.id); }}
              >
                <Icon name="refresh" size={14} />
              </button>
            )}
            {can("project.write", p.id, p.ownerUserId ?? null) && (
              <button
                className="iconbtn"
                title="Edit"
                disabled={busy === p.id}
                onClick={(e) => { e.stopPropagation(); navigate({ section: "projects", mode: "edit", id: p.id }); }}
              >
                <Icon name="edit" size={14} />
              </button>
            )}
            {can("project.delete", p.id, p.ownerUserId ?? null) && (
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

const PROJECT_ACCESS_OPTIONS = [
  ["project.read", "Read project"],
  ["project.write", "Edit project"],
  ["project.operate", "Enable and disable"],
  ["project.delete", "Delete project"],
  ["project.owner", "Manage access"],
  ["task.read", "Read tasks"],
  ["task.operate", "Operate tasks"],
  ["task.delete", "Delete tasks"],
] as const;

const DEFAULT_PROJECT_ACCESS_PERMISSIONS = ["project.read", "task.read"];

interface ProjectAccessResponse {
  grants: Array<{ groupId: string; groupName: string; permissions: string[] }>;
  availableGroups: Array<{ id: string; name: string }>;
}

function ProjectAccessEditor({ project, onClose }: { project: ApiProject; onClose: () => void }) {
  const [data, setData] = useState<ProjectAccessResponse>({ grants: [], availableGroups: [] });
  const [groupId, setGroupId] = useState("");
  const [permissions, setPermissions] = useState<string[]>(DEFAULT_PROJECT_ACCESS_PERMISSIONS);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.get<ProjectAccessResponse>(`/api/admin/projects/${project.id}/access`)
      .then((response) => {
        if (cancelled) return;
        setData(response);
        setGroupId((current) => current || response.availableGroups[0]?.id || "");
      });
    return () => { cancelled = true; };
  }, [project.id]);

  useEffect(() => {
    const existing = data.grants.find((grant) => grant.groupId === groupId);
    setPermissions(existing ? [...existing.permissions] : [...DEFAULT_PROJECT_ACCESS_PERMISSIONS]);
  }, [data.grants, groupId]);

  const save = async (): Promise<void> => {
    if (!groupId || permissions.length === 0) return;
    setBusy(true);
    try {
      await api.put(`/api/admin/projects/${project.id}/access/groups/${groupId}`, { permissions });
      const response = await api.get<ProjectAccessResponse>(`/api/admin/projects/${project.id}/access`);
      setData(response);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      await api.delete(`/api/admin/projects/${project.id}/access/groups/${id}`);
      const response = await api.get<ProjectAccessResponse>(`/api/admin/projects/${project.id}/access`);
      setData(response);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Access · ${project.name}`}
      sub="Delegate project and task permissions to a group."
      onClose={onClose}
      footer={<button className="btn" onClick={onClose}>Done</button>}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {data.grants.map((grant) => (
          <div key={grant.groupId} style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{grant.groupName}</div>
              <div style={{ color: "var(--text-faint)", fontSize: "12px" }}>{grant.permissions.join(", ")}</div>
            </div>
            <button className="iconbtn" title="Remove access" disabled={busy} onClick={() => void remove(grant.groupId)}>
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}
        <FieldSelect value={groupId} onChange={(event) => setGroupId(event.target.value)}>
          <option value="">Select a group</option>
          {data.availableGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </FieldSelect>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "8px" }}>
          {PROJECT_ACCESS_OPTIONS.map(([permission, label]) => (
            <label key={permission} style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" }}>
              <input
                type="checkbox"
                checked={permissions.includes(permission)}
                onChange={(event) => setPermissions((current) => event.target.checked
                  ? [...current, permission]
                  : current.filter((item) => item !== permission))}
              />
              {label}
            </label>
          ))}
        </div>
        <button className="btn primary" disabled={busy || !groupId || permissions.length === 0} onClick={() => void save()}>
          Save access
        </button>
      </div>
    </Modal>
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
