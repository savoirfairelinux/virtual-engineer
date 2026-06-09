import { useState } from "react";
import { RowCard } from "../../components/RowCard.tsx";
import { ProviderGlyph } from "../../components/ProviderGlyph.tsx";
import { Tag } from "../../components/Tag.tsx";
import { Toggle } from "../../components/Toggle.tsx";
import { Icon } from "../../components/Icon.tsx";
import { api } from "../../api.ts";
import { IntegrationFormModal } from "./IntegrationFormModal.tsx";
import { IntegrationDrawer } from "./ConfigDrawers.tsx";
import type { ApiIntegration } from "../../types.ts";
import type { ConfigViewData } from "./index.tsx";

export function IntegrationsSection({ integrations, plugins, onRefresh }: ConfigViewData) {
  const [busy, setBusy] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);

  const editingIntegration = editingId ? integrations.find((i) => i.id === editingId) : undefined;
  const drawerItem = drawerId ? integrations.find((i) => i.id === drawerId) : undefined;

  async function toggleEnabled(id: string, enabled: boolean) {
    setBusy(id);
    try {
      await api.patch(`/api/admin/integrations/${id}/${enabled ? "disable" : "enable"}`);
      onRefresh();
    } finally {
      setBusy(null);
    }
  }

  async function deleteIntegration(it: ApiIntegration) {
    if (!window.confirm(`Delete integration "${it.name}"? This cannot be undone.`)) return;
    setBusy(it.id);
    try {
      await api.delete(`/api/admin/integrations/${it.id}`);
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

  return (
    <>
      <div style={{ marginBottom: "22px" }}>
        <div className="eyebrow" style={{ marginBottom: "8px" }}>Configuration / Integrations</div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 600, letterSpacing: "-0.01em" }}>Integrations</h1>
            <p style={{ margin: "6px 0 0", color: "var(--text-faint)", fontSize: "13.5px" }}>External providers the orchestrator routes to by integration ID.</p>
          </div>
          <button className="btn primary" onClick={() => setShowAdd(true)}>
            <Icon name="plus" size={14} /> Add integration
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {integrations.length === 0 && (
          <div className="placeholder" style={{ minHeight: "120px" }}>No integrations configured.</div>
        )}
        {integrations.map((it) => {
          const tone = it.enabled ? "ok" : "muted";
          return (
            <RowCard key={it.id} onClick={() => setDrawerId(it.id)}>
              <ProviderGlyph provider={it.type} size={36} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "9px", minWidth: 0 }}>
                  <span style={{ fontSize: "13.5px", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {it.name}
                  </span>
                  <Tag tone={it.category === "agent" ? "active" : it.category === "ticketing" ? "info" : "warn"} mono={false}>
                    {it.category}
                  </Tag>
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-faint)", marginTop: "3px" }}>
                  {it.type} · {it.id.slice(0, 8)}
                </div>
              </div>
              <Tag tone={tone}>
                <span
                  className={it.enabled ? "live-dot" : undefined}
                  style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor", flex: "none", display: "inline-block" }}
                />
                {it.enabled ? "enabled" : "disabled"}
              </Tag>
              <div onClick={(e) => e.stopPropagation()}>
                <Toggle
                  on={it.enabled}
                  disabled={busy === it.id}
                  onChange={() => void toggleEnabled(it.id, it.enabled)}
                />
              </div>
              <button
                className="iconbtn"
                title="Delete"
                disabled={busy === it.id}
                onClick={(e) => { e.stopPropagation(); void deleteIntegration(it); }}
              >
                <Icon name="trash" size={14} />
              </button>
            </RowCard>
          );
        })}
      </div>

      {/* Detail drawer */}
      {drawerItem && (
        <IntegrationDrawer
          item={drawerItem}
          onClose={() => setDrawerId(null)}
          onEdit={() => { setDrawerId(null); setEditingId(drawerItem.id); }}
          onToggle={() => { void toggleEnabled(drawerItem.id, drawerItem.enabled); setDrawerId(null); }}
          onDelete={() => { void deleteIntegration(drawerItem); setDrawerId(null); }}
        />
      )}

      {(showAdd || editingIntegration) && (
        <IntegrationFormModal
          integration={editingIntegration}
          plugins={plugins}
          onClose={() => { setShowAdd(false); setEditingId(null); }}
          onSaved={handleSaved}
        />
      )}
    </>
  );
}
