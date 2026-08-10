import { useEffect, useState } from "react";
import { RowCard } from "../../components/RowCard.tsx";
import { Tag } from "../../components/Tag.tsx";
import { Toggle } from "../../components/Toggle.tsx";
import { Icon } from "../../components/Icon.tsx";
import { api } from "../../api.ts";
import { useCurrentUser } from "../../authContext.tsx";
import { AgentFormModal } from "./AgentFormModal.tsx";
import { AgentDrawer } from "./ConfigDrawers.tsx";
import type { ApiAgent } from "../../types.ts";
import type { ConfigSectionProps } from "./index.tsx";

export function AgentsSection({ agents, integrations, plugins, prompts, onRefresh, route, navigate, markClean }: ConfigSectionProps) {
  const { can } = useCurrentUser();
  const canWrite = can("agent.write");
  const canDelete = can("agent.delete");
  const canOperate = can("agent.operate");
  const [busy, setBusy] = useState<string | null>(null);
  const [editingAgent, setEditingAgent] = useState<ApiAgent | null>(null);
  const detailId = route.section === "agents" && route.mode === "detail" ? route.id : null;
  const editingId = route.section === "agents" && route.mode === "edit" ? route.id : null;
  const detailItem = detailId ? agents.find((agent) => agent.id === detailId) : undefined;

  useEffect(() => {
    if (!editingId) {
      setEditingAgent(null);
      return;
    }
    let cancelled = false;
    setBusy(editingId);
    void api.get<{ agent: ApiAgent }>(`/api/admin/agents/${editingId}`)
      .then((response) => { if (!cancelled) setEditingAgent(response.agent); })
      .catch((error: unknown) => {
        if (cancelled) return;
        alert(error instanceof Error ? error.message : "Failed to load agent");
        navigate({ section: "agents", mode: "list" });
      })
      .finally(() => { if (!cancelled) setBusy(null); });
    return () => { cancelled = true; };
  }, [editingId, navigate]);

  async function toggleEnabled(id: string, enabled: boolean) {
    setBusy(id);
    try {
      await api.patch(`/api/admin/agents/${id}/${enabled ? "disable" : "enable"}`);
      onRefresh();
    } finally {
      setBusy(null);
    }
  }

  async function deleteAgent(a: ApiAgent): Promise<boolean> {
    if (!window.confirm(`Delete agent "${a.name}"? This cannot be undone.`)) return false;
    setBusy(a.id);
    try {
      await api.delete(`/api/admin/agents/${a.id}`);
      onRefresh();
      return true;
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
      return false;
    } finally {
      setBusy(null);
    }
  }

  function handleSaved() {
    markClean();
    onRefresh();
    navigate(editingId
      ? { section: "agents", mode: "detail", id: editingId }
      : { section: "agents", mode: "list" });
  }

  function promptLabel(id: string | null | undefined): string {
    if (!id) return "—";
    return prompts.find((p) => p.id === id)?.label ?? id.slice(0, 12);
  }

  if (route.mode === "detail") {
    if (!detailItem) return <AgentMissing onBack={() => navigate({ section: "agents", mode: "list" })} />;
    return (
      <AgentDrawer
        item={detailItem}
        prompts={prompts}
        onClose={() => navigate({ section: "agents", mode: "list" })}
        {...(canWrite ? { onEdit: () => navigate({ section: "agents", mode: "edit", id: detailItem.id }) } : {})}
        {...(canOperate ? { onToggle: () => { void toggleEnabled(detailItem.id, detailItem.enabled); } } : {})}
        {...(canDelete ? { onDelete: () => { void deleteAgent(detailItem).then((deleted) => { if (deleted) navigate({ section: "agents", mode: "list" }); }); } } : {})}
      />
    );
  }

  if (route.mode === "create" || route.mode === "edit") {
    if (route.mode === "edit" && !editingAgent) {
      return <div className="placeholder config-page-loading">{busy ? "Loading agent…" : "Agent unavailable."}</div>;
    }
    return (
      <AgentFormModal
        agent={route.mode === "edit" ? editingAgent ?? undefined : undefined}
        integrations={integrations}
        plugins={plugins}
        prompts={prompts}
        onClose={() => navigate(editingId
          ? { section: "agents", mode: "detail", id: editingId }
          : { section: "agents", mode: "list" })}
        onSaved={handleSaved}
      />
    );
  }

  return (
    <>
      <div style={{ marginBottom: "22px" }}>
        <div className="eyebrow" style={{ marginBottom: "8px" }}>Configuration / Agents</div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 600, letterSpacing: "-0.01em" }}>Agents library</h1>
            <p style={{ margin: "6px 0 0", color: "var(--text-faint)", fontSize: "13.5px" }}>Reusable agent definitions — model config, concurrency, and bound prompts.</p>
          </div>
          {canWrite && (
            <button className="btn primary" onClick={() => navigate({ section: "agents", mode: "create" })}>
              <Icon name="plus" size={14} /> New agent
            </button>
          )}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {agents.length === 0 && (
          <div className="placeholder" style={{ minHeight: "120px" }}>No agents configured.</div>
        )}
        {agents.map((a) => (
          <RowCard key={a.id} ariaLabel={`Open agent ${a.name}`} onClick={() => navigate({ section: "agents", mode: "detail", id: a.id })}>
            <span
              style={{
                width: 36, height: 36, borderRadius: "8px",
                display: "grid", placeItems: "center",
                background: "var(--accent-soft)", color: "var(--accent-strong)", flex: "none",
              }}
            >
              <Icon name="spark" size={18} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: "13.5px", fontWeight: 600 }}>{a.name}</div>
              <div className="mono" style={{ fontSize: "11.5px", color: "var(--text-faint)", marginTop: "3px" }}>
                {a.type} · {a.reviewStrategy === "copilot_native" ? "CLI-managed models" : a.model ?? "auto"}
              </div>
            </div>
            <div className="row-card-tags" style={{ display: "flex", gap: "8px" }}>
              <Tag tone={a.reviewStrategy === "copilot_native" ? "warn" : "muted"}>
                {a.reviewStrategy === "copilot_native" ? "Copilot native · experimental" : "VE direct"}
              </Tag>
              <Tag tone="info">System Prompt: {promptLabel(a.systemPromptId)}</Tag>
              <Tag tone="muted">Instructions Prompt: {promptLabel(a.instructionsPromptId)}</Tag>
            </div>
            <div style={{ textAlign: "right", minWidth: "70px" }}>
              <div className="eyebrow" style={{ fontSize: "9px" }}>Concurrency</div>
              <div className="mono" style={{ fontSize: "14px", fontWeight: 600 }}>
                {a.maxConcurrent ?? "∞"}
              </div>
            </div>
            <div onClick={(ev) => ev.stopPropagation()}>
              {canOperate && (
                <Toggle
                  on={a.enabled}
                  label={`Agent ${a.name} enabled`}
                  disabled={busy === a.id}
                  onChange={() => void toggleEnabled(a.id, a.enabled)}
                />
              )}
            </div>
            {canDelete && (
              <button
                className="iconbtn"
                title="Delete"
                disabled={busy === a.id}
                onClick={(ev) => { ev.stopPropagation(); void deleteAgent(a); }}
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

function AgentMissing({ onBack }: { onBack: () => void }) {
  return (
    <div className="config-missing">
      <div className="placeholder">This agent is unavailable or you do not have access.</div>
      <button className="btn" onClick={onBack}>Back to agents</button>
    </div>
  );
}
