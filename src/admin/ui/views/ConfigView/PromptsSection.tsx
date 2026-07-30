import { useState } from "react";
import { RowCard } from "../../components/RowCard.tsx";
import { Icon } from "../../components/Icon.tsx";
import { api } from "../../api.ts";
import { useCurrentUser } from "../../authContext.tsx";
import { PromptFormModal } from "./PromptFormModal.tsx";
import type { ApiPrompt } from "../../types.ts";
import type { ConfigSectionProps } from "./index.tsx";

type PromptFilter = "all" | "system" | "instructions";

const BUILTIN_PROMPT_IDS = new Set([
  "system_generic_code",
  "instructions_generic_code",
  "instructions_feedback_code",
  "system_review",
  "instructions_review",
]);

function formatPromptType(promptType: ApiPrompt["promptType"]): string {
  return promptType === "system" ? "System Prompt" : "Instructions Prompt";
}

export function PromptsSection({ prompts, onRefresh, route, navigate, markClean }: ConfigSectionProps) {
  const { can } = useCurrentUser();
  const canWrite = can("prompt.write");
  const canDelete = can("prompt.delete");
  const routeId = route.section === "prompts" && (route.mode === "detail" || route.mode === "edit") ? route.id : null;
  const routePrompt = routeId ? prompts.find((prompt) => prompt.id === routeId) : undefined;
  const [filter, setFilter] = useState<PromptFilter>("all");
  const filteredPrompts = filter === "all" ? prompts : prompts.filter((p) => p.promptType === filter);

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
    markClean();
    onRefresh();
    navigate(route.mode === "edit" && routeId
      ? { section: "prompts", mode: "detail", id: routeId }
      : { section: "prompts", mode: "list" });
  }

  if (route.mode === "detail") {
    if (!routePrompt) return <PromptMissing onBack={() => navigate({ section: "prompts", mode: "list" })} />;
    const builtin = BUILTIN_PROMPT_IDS.has(routePrompt.id);
    return (
      <PromptFormModal
        prompt={routePrompt}
        readOnly
        onEdit={canWrite && !builtin ? () => navigate({ section: "prompts", mode: "edit", id: routePrompt.id }) : undefined}
        onClose={() => navigate({ section: "prompts", mode: "list" })}
        onSaved={handleSaved}
      />
    );
  }

  if (route.mode === "create" || route.mode === "edit") {
    if (route.mode === "edit" && !routePrompt) return <PromptMissing onBack={() => navigate({ section: "prompts", mode: "list" })} />;
    const builtin = routePrompt ? BUILTIN_PROMPT_IDS.has(routePrompt.id) : false;
    return (
      <PromptFormModal
        prompt={route.mode === "edit" ? routePrompt : undefined}
        readOnly={!canWrite || builtin}
        onClose={() => navigate(route.mode === "edit" && routeId
          ? { section: "prompts", mode: "detail", id: routeId }
          : { section: "prompts", mode: "list" })}
        onSaved={handleSaved}
      />
    );
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
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <label style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--text-dim)" }} htmlFor="prompt-filter">Filter</label>
            <select
              id="prompt-filter"
              value={filter}
              onChange={(e) => {
                const value = e.target.value;
                if (value === "all" || value === "system" || value === "instructions") {
                  setFilter(value);
                }
              }}
              style={{
                padding: "6px 10px", fontSize: "13px", fontFamily: "var(--font-sans)",
                border: "1px solid var(--border)", borderRadius: "var(--radius-sm)",
                background: "var(--panel-2)", color: "var(--text)", outline: "none", cursor: "pointer",
              }}
            >
              <option value="all">All prompts</option>
              <option value="system">System Prompt</option>
              <option value="instructions">Instructions Prompt</option>
            </select>
            {canWrite && (
              <button className="btn primary" onClick={() => navigate({ section: "prompts", mode: "create" })}>
                <Icon name="plus" size={14} /> New prompt
              </button>
            )}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {filteredPrompts.length === 0 && (
          <div className="placeholder" style={{ minHeight: "120px" }}>
            {prompts.length === 0 ? "No prompts configured." : "No prompts match the selected filter."}
          </div>
        )}
        {filteredPrompts.map((p) => (
          <RowCard key={p.id} ariaLabel={`Open prompt ${p.label}`} onClick={() => navigate({ section: "prompts", mode: "detail", id: p.id })}>
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
                  {formatPromptType(p.promptType)}
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
            {canDelete && (
              <button
                className="iconbtn"
                title="Delete"
                disabled={BUILTIN_PROMPT_IDS.has(p.id)}
                onClick={(e) => { e.stopPropagation(); void deletePrompt(p); }}
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

function PromptMissing({ onBack }: { onBack: () => void }) {
  return (
    <div className="config-missing">
      <div className="placeholder">This prompt is unavailable or you do not have access.</div>
      <button className="btn" onClick={onBack}>Back to prompts</button>
    </div>
  );
}
