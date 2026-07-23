import { useState } from "react";
import { RowCard } from "../../components/RowCard.tsx";
import { Icon } from "../../components/Icon.tsx";
import { api } from "../../api.ts";
import { useCurrentUser } from "../../authContext.tsx";
import { PromptFormModal } from "./PromptFormModal.tsx";
import type { ApiPrompt } from "../../types.ts";
import type { ConfigViewData } from "./index.tsx";

export function PromptsSection({ prompts, onRefresh }: ConfigViewData) {
  const { canOperate } = useCurrentUser();
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const editingPrompt = editingId ? prompts.find((p) => p.id === editingId) : undefined;

  async function deletePrompt(p: ApiPrompt) {
    if (!window.confirm(`Delete prompt "${p.label}"?`)) return;
    try {
      await api.delete(`/api/admin/prompts/${p.id}`);
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
        <div className="eyebrow" style={{ marginBottom: "8px" }}>Configuration / Prompts</div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 600, letterSpacing: "-0.01em" }}>Prompts</h1>
            <p style={{ margin: "6px 0 0", color: "var(--text-faint)", fontSize: "13.5px" }}>System and instruction prompts bound to agents.</p>
          </div>
          {canOperate && (
            <button className="btn primary" onClick={() => setShowAdd(true)}>
              <Icon name="plus" size={14} /> New prompt
            </button>
          )}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {prompts.length === 0 && (
          <div className="placeholder" style={{ minHeight: "120px" }}>No prompts configured.</div>
        )}
        {prompts.map((p) => (
          <RowCard key={p.id} onClick={() => setEditingId(p.id)}>
            <span
              style={{
                width: 34, height: 34, borderRadius: "8px",
                display: "grid", placeItems: "center",
                background: "var(--panel-2)", color: "var(--text-faint)", flex: "none",
              }}
            >
              <Icon name="edit" size={15} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span className="mono" style={{ fontSize: "13px", fontWeight: 600 }}>{p.label}</span>
                <span style={{ fontSize: "11px", color: "var(--text-faint)", textTransform: "capitalize" }}>
                  {p.promptType}
                </span>
              </div>
              <div style={{ fontSize: "11.5px", color: "var(--text-faint)", marginTop: "2px" }}>
                updated {new Date(p.updatedAt).toLocaleDateString()}
                {p.usedByCount != null ? ` · used by ${p.usedByCount} agent${p.usedByCount !== 1 ? "s" : ""}` : ""}
              </div>
            </div>
            <span className="mono" style={{ fontSize: "11.5px", color: "var(--text-ghost)", minWidth: "70px", textAlign: "right" }}>
              {p.content.length.toLocaleString()} ch
            </span>
            {canOperate && (
              <button
                className="iconbtn"
                title="Delete"
                onClick={(e) => { e.stopPropagation(); void deletePrompt(p); }}
              >
                <Icon name="trash" size={14} />
              </button>
            )}
          </RowCard>
        ))}
      </div>

      {(showAdd || editingPrompt) && (
        <PromptFormModal
          prompt={editingPrompt}
          readOnly={!canOperate}
          onClose={() => { setShowAdd(false); setEditingId(null); }}
          onSaved={handleSaved}
        />
      )}
    </>
  );
}
