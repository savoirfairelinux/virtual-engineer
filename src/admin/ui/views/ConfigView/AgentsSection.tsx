import { useState } from "react";
import { RowCard } from "../../components/RowCard.tsx";
import { Tag } from "../../components/Tag.tsx";
import { Toggle } from "../../components/Toggle.tsx";
import { Icon } from "../../components/Icon.tsx";
import { api } from "../../api.ts";
import { useCurrentUser } from "../../authContext.tsx";
import { AgentFormModal } from "./AgentFormModal.tsx";
import { AgentDrawer } from "./ConfigDrawers.tsx";
import type { ApiAgent } from "../../types.ts";
import type { ConfigViewData } from "./index.tsx";

export function AgentsSection({ agents, integrations, prompts, onRefresh }: ConfigViewData) {
  const { canOperate } = useCurrentUser();
  const [busy, setBusy] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);

  const editingAgent = editingId ? agents.find((a) => a.id === editingId) : undefined;
  const drawerItem = drawerId ? agents.find((a) => a.id === drawerId) : undefined;

  async function toggleEnabled(id: string, enabled: boolean) {
    setBusy(id);
    try {
      await api.patch(`/api/admin/agents/${id}/${enabled ? "disable" : "enable"}`);
      onRefresh();
    } finally {
      setBusy(null);
    }
  }

  async function deleteAgent(a: ApiAgent) {
    if (!window.confirm(`Delete agent "${a.name}"? This cannot be undone.`)) return;
    setBusy(a.id);
    try {
      await api.delete(`/api/admin/agents/${a.id}`);
      onRefresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(null);
    }
  }

  function handleSaved() {
    setShowAdd(false);
    setEditingId(null);
    onRefresh();
  }

  function promptLabel(id: string | null | undefined): string {
    if (!id) return "—";
    return prompts.find((p) => p.id === id)?.label ?? id.slice(0, 12);
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
          {canOperate && (
            <button className="btn primary" onClick={() => setShowAdd(true)}>
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
          <RowCard key={a.id} onClick={() => setDrawerId(a.id)}>
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
                {a.type} · {a.model ?? "auto"}
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <Tag tone="info">sys: {promptLabel(a.systemPromptId)}</Tag>
              <Tag tone="muted">instr: {promptLabel(a.instructionsPromptId)}</Tag>
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
                  disabled={busy === a.id}
                  onChange={() => void toggleEnabled(a.id, a.enabled)}
                />
              )}
            </div>
            {canOperate && (
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

      {/* Detail drawer */}
      {drawerItem && (
        <AgentDrawer
          item={drawerItem}
          prompts={prompts}
          onClose={() => setDrawerId(null)}
          {...(canOperate ? {
            onEdit: () => { setDrawerId(null); setEditingId(drawerItem.id); },
            onToggle: () => { void toggleEnabled(drawerItem.id, drawerItem.enabled); setDrawerId(null); },
            onDelete: () => { void deleteAgent(drawerItem); setDrawerId(null); },
          } : {})}
        />
      )}

      {canOperate && (showAdd || editingAgent) && (
        <AgentFormModal
          agent={editingAgent}
          integrations={integrations}
          prompts={prompts}
          onClose={() => { setShowAdd(false); setEditingId(null); }}
          onSaved={handleSaved}
        />
      )}
    </>
  );
}
