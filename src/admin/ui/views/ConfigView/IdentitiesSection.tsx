import { useState } from "react";
import { RowCard } from "../../components/RowCard.tsx";
import { Icon } from "../../components/Icon.tsx";
import { api } from "../../api.ts";
import { IdentityFormModal } from "./IdentityFormModal.tsx";
import type { ApiIdentity } from "../../types.ts";
import type { ConfigViewData } from "./index.tsx";

export function IdentitiesSection({ identities, projects, onRefresh }: ConfigViewData) {
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const editingIdentity = editingId ? identities.find((i) => i.id === editingId) : undefined;

  function usageCount(id: string): number {
    return projects.filter((p) => p.identityId === id).length;
  }

  async function deleteIdentity(identity: ApiIdentity) {
    const used = usageCount(identity.id);
    const warn = used > 0
      ? ` It is used by ${used} workflow${used !== 1 ? "s" : ""}, which will revert to default behaviour.`
      : "";
    if (!window.confirm(`Delete identity "${identity.name}"?${warn}`)) return;
    try {
      await api.delete(`/api/admin/identities/${identity.id}`);
      onRefresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
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
        <div className="eyebrow" style={{ marginBottom: "8px" }}>Configuration / Identities</div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 600, letterSpacing: "-0.01em" }}>Identities</h1>
            <p style={{ margin: "6px 0 0", color: "var(--text-faint)", fontSize: "13.5px" }}>
              Reusable VE personas (name, email, username, signature). Bind one to a workflow so VE appears
              consistently when posting comments, creating tickets, or sending notifications.
            </p>
          </div>
          <button className="btn primary" onClick={() => setShowAdd(true)}>
            <Icon name="plus" size={14} /> New identity
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {identities.length === 0 && (
          <div className="placeholder" style={{ minHeight: "120px" }}>No identities configured.</div>
        )}
        {identities.map((identity) => {
          const used = usageCount(identity.id);
          return (
            <RowCard key={identity.id} onClick={() => setEditingId(identity.id)}>
              <span
                style={{
                  width: 34, height: 34, borderRadius: "8px",
                  display: "grid", placeItems: "center",
                  background: "var(--panel-2)", color: "var(--text-faint)", flex: "none",
                }}
              >
                <Icon name="comment" size={15} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: "13px", fontWeight: 600 }}>{identity.name}</span>
                <div className="mono" style={{ fontSize: "11.5px", color: "var(--text-faint)", marginTop: "2px" }}>
                  {[identity.email, identity.username && `@${identity.username}`].filter(Boolean).join(" · ") || "no email / username"}
                </div>
              </div>
              <span className="mono" style={{ fontSize: "11.5px", color: "var(--text-ghost)", minWidth: "90px", textAlign: "right" }}>
                {used > 0 ? `${used} workflow${used !== 1 ? "s" : ""}` : "unused"}
              </span>
              <button
                className="iconbtn"
                title="Delete"
                onClick={(e) => { e.stopPropagation(); void deleteIdentity(identity); }}
              >
                <Icon name="trash" size={14} />
              </button>
            </RowCard>
          );
        })}
      </div>

      {(showAdd || editingIdentity) && (
        <IdentityFormModal
          identity={editingIdentity}
          onClose={() => { setShowAdd(false); setEditingId(null); }}
          onSaved={handleSaved}
        />
      )}
    </>
  );
}
