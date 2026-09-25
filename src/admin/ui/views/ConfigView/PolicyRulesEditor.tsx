import { FieldSelect } from "../../components/Modal.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Tag } from "../../components/Tag.tsx";
import {
  POLICY_GROUPS,
  resourceOptions,
  type PolicyDraft,
  type PolicyGroupDef,
  type PolicyResourceData,
  type ScopedGroupId,
} from "./policyRuleModel.ts";

interface Props {
  draft: PolicyDraft;
  data: PolicyResourceData;
  readOnly: boolean;
  onChange: (draft: PolicyDraft) => void;
  onResourceAdded?: ((group: ScopedGroupId, resourceId: string) => void) | undefined;
}

const RESOURCE_NOUN: Record<string, string> = {
  project: "project",
  integration: "integration",
  agent: "agent",
  prompt: "prompt",
  oauth: "OAuth app",
};

export function PolicyRulesEditor({ draft, data, readOnly, onChange, onResourceAdded }: Props) {
  function updateGroup(id: ScopedGroupId, patch: Partial<PolicyDraft["groups"][ScopedGroupId]>) {
    onChange({ ...draft, groups: { ...draft.groups, [id]: { ...draft.groups[id], ...patch } } });
  }

  function toggleGlobal(permission: string, checked: boolean) {
    const next = checked
      ? [...draft.globalPermissions, permission]
      : draft.globalPermissions.filter((p) => p !== permission);
    onChange({ ...draft, globalPermissions: next });
  }

  function renderGroup(group: PolicyGroupDef) {
    const scopedId = group.id === "global" ? null : group.id;
    const state = scopedId ? draft.groups[scopedId] : null;
    const options = group.resourceKind ? resourceOptions(group.resourceKind, data) : [];
    const labelById = new Map(options.map((o) => [o.id, o.label]));
    const available = options.filter((o) => !state?.resourceIds.includes(o.id));
    const noun = group.resourceKind ? RESOURCE_NOUN[group.resourceKind] : "";

    return (
      <section key={group.id} data-testid={`policy-group-${group.id}`} aria-label={group.title}
        style={{ border: "1px solid var(--border-soft)", borderRadius: "var(--radius-sm)", padding: "12px 14px", background: "var(--panel-2)" }}>
        <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "10px" }}>{group.title}</div>

        {scopedId && state && (
          <div style={{ marginBottom: "10px" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "6px" }}>
              {state.resourceIds.length === 0 && (
                <span style={{ fontSize: "12px", color: "var(--text-faint)" }}>No {noun} selected.</span>
              )}
              {state.resourceIds.map((id) => (
                <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px", padding: "2px 8px", border: "1px solid var(--border-soft)", borderRadius: "999px", background: "var(--panel)" }}>
                  {labelById.get(id) ?? `${id} (unknown)`}
                  {!readOnly && (
                    <button data-config-dirty type="button" className="iconbtn" title={`Remove ${id}`} aria-label={`Remove ${id}`}
                      style={{ width: 18, height: 18 }}
                      onClick={() => updateGroup(scopedId, { resourceIds: state.resourceIds.filter((r) => r !== id) })}>
                      <Icon name="x" size={11} />
                    </button>
                  )}
                </span>
              ))}
            </div>
            {!readOnly && (
              <FieldSelect aria-label={`Add ${noun} to ${group.title}`} value="" disabled={available.length === 0}
                onChange={(event) => {
                  const id = event.target.value;
                  if (!id) return;
                  updateGroup(scopedId, { resourceIds: [...state.resourceIds, id] });
                  onResourceAdded?.(scopedId, id);
                }}>
                <option value="">{available.length === 0 ? `No more ${noun}s` : `Add ${noun}…`}</option>
                {available.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </FieldSelect>
            )}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "6px 12px" }}>
          {group.actions.map((action) => {
            const checked = action.global
              ? draft.globalPermissions.includes(action.permission)
              : state?.actions.includes(action.permission) ?? false;
            return (
              <label key={action.permission} title={action.permission}
                style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" }}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={readOnly}
                  onChange={(event) => {
                    if (action.global) { toggleGlobal(action.permission, event.target.checked); return; }
                    if (!scopedId || !state) return;
                    updateGroup(scopedId, {
                      actions: event.target.checked
                        ? [...state.actions, action.permission]
                        : state.actions.filter((p) => p !== action.permission),
                    });
                  }}
                />
                {action.label}
                {action.global && group.id !== "global" && <Tag tone="muted" mono={false}>global</Tag>}
              </label>
            );
          })}
        </div>
      </section>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      {POLICY_GROUPS.map(renderGroup)}
    </div>
  );
}
