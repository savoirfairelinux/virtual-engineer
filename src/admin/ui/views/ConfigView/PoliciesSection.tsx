import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RowCard } from "../../components/RowCard.tsx";
import { ListToolbar, NoListMatches } from "../../components/ListToolbar.tsx";
import { Tag } from "../../components/Tag.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Modal, Field, FieldInput, FieldSelect, FormError, FormRow, FormActions } from "../../components/Modal.tsx";
import { api } from "../../api.ts";
import { policyListConfig } from "./configListConfigs.ts";
import { EMPTY_LIST_FILTER, applyListFilter } from "./listFilters.ts";
import { PolicyRulesEditor } from "./PolicyRulesEditor.tsx";
import {
  POLICY_GROUPS,
  applyLinkedResources,
  draftIssues,
  draftToRules,
  emptyDraft,
  formatNameWithId,
  linkedResourcesForProject,
  permissionLabel,
  resourceOptions,
  rulesToDraft,
  type LinkedProjectDetail,
  type PolicyDraft,
  type PolicyResourceData,
  type ScopedGroupId,
} from "./policyRuleModel.ts";
import type { ApiGroup, ApiPolicy, ApiPolicyDetail, ApiUser } from "../../types.ts";
import type { ConfigSectionProps } from "./index.tsx";

const POLICY_LIST_CONFIG = policyListConfig();

const GROUP_TITLE = new Map(POLICY_GROUPS.map((group) => [group.id, group.title]));

/* ─── Create-policy modal ─────────────────────────────────────────────── */

function PolicyFormModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await api.post("/api/admin/policies", { name: name.trim(), description });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="New policy" sub="A reusable set of permission grants" onClose={onClose}>
      <FormRow>
        <Field label="Name" required>
          <FieldInput data-tour="policy-form-name" value={name} autoComplete="off" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
          <FieldInput data-tour="policy-form-description" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <FormError msg={error} />
        <FormActions>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" data-tour="policy-form-actions" onClick={() => void handleSave()} disabled={saving || name.trim().length === 0}>
            {saving ? "Creating…" : "Create policy"}
          </button>
        </FormActions>
      </FormRow>
    </Modal>
  );
}

/* ─── Policy detail (rules + bindings) modal ──────────────────────────── */

function describeLinked(added: { agent: string[]; integration: string[]; prompt: string[] }, data: PolicyResourceData): string {
  const parts = (["agent", "integration", "prompt"] as const).flatMap((kind) => {
    const labels = new Map(resourceOptions(kind, data).map((o) => [o.id, o.label]));
    return added[kind].map((id) => labels.get(id) ?? id);
  });
  return parts.join(", ");
}

function PolicyDetailModal({ policyId, forceReadOnly, data, onClose, onEdit, onPersisted }: {
  policyId: string;
  forceReadOnly: boolean;
  data: PolicyResourceData;
  onClose: () => void;
  onEdit?: (() => void) | undefined;
  onPersisted: () => void;
}) {
  const [detail, setDetail] = useState<ApiPolicyDetail | null>(null);
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [groups, setGroups] = useState<ApiGroup[]>([]);
  const [draft, setDraft] = useState<PolicyDraft>(emptyDraft);
  const draftRef = useRef(draft);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  const [savedDraft, setSavedDraft] = useState<PolicyDraft>(emptyDraft);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bindType, setBindType] = useState<"user" | "group">("group");
  const [bindId, setBindId] = useState("");

  const load = useCallback(async (preserveRuleDraft = false) => {
    try {
      const [d, u, g] = await Promise.all([
        api.get<{ policy: ApiPolicyDetail }>(`/api/admin/policies/${policyId}`),
        api.get<{ users: ApiUser[] }>("/api/admin/users"),
        api.get<{ groups: ApiGroup[] }>("/api/admin/groups"),
      ]);
      const loaded = rulesToDraft(d.policy.rules);
      setDetail(d.policy);
      if (!preserveRuleDraft) setDraft(loaded);
      setSavedDraft(loaded);
      setUsers(u.users);
      setGroups(g.groups);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load policy");
    }
  }, [policyId]);

  useEffect(() => { void load(); }, [load]);

  const readOnly = forceReadOnly || (detail?.builtin ?? false);
  const rulesDirty = JSON.stringify(draftToRules(draft)) !== JSON.stringify(draftToRules(savedDraft));
  const issues = draftIssues(draft);

  function addLinkedResources(group: ScopedGroupId, resourceId: string) {
    if (group !== "project" && group !== "task") return;
    void api.get<{ project: LinkedProjectDetail }>(`/api/admin/projects/${encodeURIComponent(resourceId)}`)
      .then(({ project }) => {
        const linked = linkedResourcesForProject(project, data.agents, data.prompts);
        const result = applyLinkedResources(draftRef.current, linked);
        setDraft(result.draft);
        const summary = describeLinked(result.added, data);
        setNotice(summary ? `Added linked resources with Read access: ${summary}` : null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? `Could not load linked resources: ${e.message}` : "Could not load linked resources"));
  }

  async function saveRules() {
    if (issues.missingResources.length > 0) {
      setError(`Select at least one resource for: ${issues.missingResources.map((id) => GROUP_TITLE.get(id) ?? id).join(", ")}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/admin/policies/${policyId}/rules`, { rules: draftToRules(draft) });
      setNotice(null);
      await load();
      onPersisted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function mutate(fn: () => Promise<unknown>) {
    const preserveDirtyRules = rulesDirty;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load(preserveDirtyRules);
      if (!preserveDirtyRules) onPersisted();
    }
    catch (e) { setError(e instanceof Error ? e.message : "Update failed"); }
    finally { setBusy(false); }
  }

  function principalLabel(type: "user" | "group" | "system", id: string): string {
    if (type === "user") return formatNameWithId(users.find((u) => u.id === id)?.username, id);
    if (type === "system") {
      return id.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
    }
    return formatNameWithId(groups.find((g) => g.id === id)?.name, id);
  }

  const bindCandidates = bindType === "user"
    ? users.map((u) => ({ id: u.id, label: formatNameWithId(u.username, u.id) }))
    : groups.map((g) => ({ id: g.id, label: formatNameWithId(g.name, g.id) }));

  if (error && !detail) {
    return (
      <Modal title="Policy unavailable" sub="The policy was removed or access was revoked" onClose={onClose}>
        <FormError msg={error} />
        <FormActions><button className="btn" onClick={onClose}>Back to policies</button></FormActions>
      </Modal>
    );
  }

  return (
    <Modal title={detail?.name ?? "Policy"} sub={readOnly ? "Built-in policy (read-only)" : "Edit grants and assignments"} onClose={onClose}>
      <FormRow>
        <FormError msg={error} />

        {/* Rules */}
        <div className="eyebrow" style={{ margin: "4px 0 8px" }}>Rules</div>
        {savedDraft.nonUniform && !readOnly && (
          <div className="policy-warning" style={{ marginBottom: "10px", fontSize: "12.5px", color: "var(--warning, var(--text-dim))" }}>
            Some stored rules grant different actions to different resources of the same type. Saving applies every checked action to every selected resource of that type.
          </div>
        )}
        {draft.legacyGlobalRules.length > 0 && (
          <div style={{ marginBottom: "10px", display: "flex", flexDirection: "column", gap: "6px" }}>
            <div style={{ fontSize: "12.5px", color: "var(--text-dim)" }}>These rules grant access to every resource of their type:</div>
            {draft.legacyGlobalRules.map((rule) => (
              <RowCard key={rule.permission}>
                <div style={{ flex: 1, fontSize: "13px" }}>{permissionLabel(rule.permission)} — all resources</div>
                {!readOnly && (
                  <button data-config-dirty className="iconbtn" title="Remove" aria-label={`Remove all-resource grant ${rule.permission}`}
                    onClick={() => setDraft((current) => ({ ...current, legacyGlobalRules: current.legacyGlobalRules.filter((r) => r.permission !== rule.permission) }))}>
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </RowCard>
            ))}
          </div>
        )}
        <PolicyRulesEditor
          draft={draft}
          data={data}
          readOnly={readOnly}
          onChange={setDraft}
          onResourceAdded={addLinkedResources}
        />
        {notice && <div style={{ marginTop: "10px", fontSize: "12.5px", color: "var(--text-dim)" }}>{notice}</div>}
        {!readOnly && issues.missingActions.length > 0 && (
          <div style={{ marginTop: "10px", fontSize: "12.5px", color: "var(--text-faint)" }}>
            No action checked for: {issues.missingActions.map((id) => GROUP_TITLE.get(id) ?? id).join(", ")} — those resources receive nothing.
          </div>
        )}
        {!readOnly && (
          <div style={{ display: "flex", gap: "8px", margin: "12px 0 16px" }}>
            <button className="btn primary" disabled={busy || !rulesDirty} onClick={() => void saveRules()}>{busy ? "Saving…" : "Save rules"}</button>
          </div>
        )}

        {/* Bindings */}
        <div className="eyebrow" style={{ margin: "4px 0 8px" }}>Assigned to</div>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "10px" }}>
          {(detail?.bindings ?? []).length === 0 && <div className="placeholder" style={{ minHeight: "50px" }}>Not assigned to anyone.</div>}
          {(detail?.bindings ?? []).map((b) => (
            <RowCard key={b.id}>
              <Tag tone={b.principalType === "group" ? "info" : "muted"} mono={false}>{b.principalType}</Tag>
              <div style={{ flex: 1, fontSize: "13px" }}>{principalLabel(b.principalType, b.principalId)}</div>
              {!readOnly && b.principalType !== "system" && (
                <button className="iconbtn" title="Unassign" disabled={busy}
                  onClick={() => void mutate(() => api.delete(`/api/admin/policies/${policyId}/bindings/${b.principalType}/${b.principalId}`))}>
                  <Icon name="trash" size={14} />
                </button>
              )}
            </RowCard>
          ))}
        </div>
        {!readOnly && (
          <div className="policy-assignment-controls" style={{ display: "flex", gap: "8px" }}>
            <FieldSelect value={bindType} onChange={(e) => { setBindType(e.target.value as "user" | "group"); setBindId(""); }}>
              <option value="user">User</option>
              <option value="group">Group</option>
            </FieldSelect>
            <FieldSelect value={bindId} onChange={(e) => setBindId(e.target.value)}>
              <option value="">Select…</option>
              {bindCandidates.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </FieldSelect>
            <button className="btn primary" disabled={busy || !bindId}
              onClick={() => void mutate(async () => { await api.post(`/api/admin/policies/${policyId}/bindings`, { principalType: bindType, principalId: bindId }); setBindId(""); })}>
              Assign
            </button>
          </div>
        )}

        <FormActions>
          <button className="btn ghost" onClick={onClose}>{forceReadOnly ? "Back" : "Done"}</button>
          {forceReadOnly && onEdit && <button className="btn primary" onClick={onEdit}>Edit policy</button>}
        </FormActions>
      </FormRow>
    </Modal>
  );
}

/* ─── Policies section ────────────────────────────────────────────────── */

export function PoliciesSection({ route, navigate, markClean, listFilter, onListFilterChange, projects, integrations, agents, prompts, oauthApps }: ConfigSectionProps) {
  const resourceData = useMemo<PolicyResourceData>(
    () => ({ projects, integrations, agents, prompts, oauthApps }),
    [projects, integrations, agents, prompts, oauthApps],
  );
  const [policies, setPolicies] = useState<ApiPolicy[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const visiblePolicies = useMemo(() => applyListFilter(policies, listFilter, POLICY_LIST_CONFIG), [policies, listFilter]);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ policies: ApiPolicy[] }>("/api/admin/policies");
      setPolicies(r.policies);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load policies");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function deletePolicy(p: ApiPolicy) {
    if (!window.confirm(`Delete policy "${p.name}"? All its assignments are removed.`)) return;
    setBusy(p.id);
    void api.delete(`/api/admin/policies/${p.id}`).then(load).catch((e: unknown) => setError(e instanceof Error ? e.message : "Delete failed")).finally(() => setBusy(null));
  }

  const routeId = route.section === "policies" && (route.mode === "detail" || route.mode === "edit") ? route.id : null;
  const routePolicy = routeId ? policies.find((policy) => policy.id === routeId) : undefined;

  if (route.mode === "create") {
    return (
      <PolicyFormModal
        onClose={() => navigate({ section: "policies", mode: "list" })}
        onSaved={() => { markClean(); void load(); navigate({ section: "policies", mode: "list" }); }}
      />
    );
  }

  if ((route.mode === "detail" || route.mode === "edit") && routeId) {
    if (route.mode === "edit" && routePolicy?.builtin) {
      return (
        <div className="config-missing">
          <div className="placeholder">Built-in policies are read-only.</div>
          <button className="btn" onClick={() => navigate({ section: "policies", mode: "detail", id: routeId })}>View policy</button>
        </div>
      );
    }
    return (
      <PolicyDetailModal
        policyId={routeId}
        forceReadOnly={route.mode === "detail"}
        data={resourceData}
        onClose={() => { void load(); navigate(route.mode === "edit"
          ? { section: "policies", mode: "detail", id: routeId }
          : { section: "policies", mode: "list" }); }}
        onEdit={route.mode === "detail" && !routePolicy?.builtin
          ? () => navigate({ section: "policies", mode: "edit", id: routeId })
          : undefined}
        onPersisted={markClean}
      />
    );
  }

  return (
    <>
      <div style={{ marginBottom: "22px" }}>
        <div className="eyebrow" style={{ marginBottom: "8px" }}>Access Control / Policies</div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 600, letterSpacing: "-0.01em" }}>Policies</h1>
            <p style={{ margin: "6px 0 0", color: "var(--text-faint)", fontSize: "13.5px" }}>Grant permissions on specific resources, then assign policies to users or groups.</p>
          </div>
          <button className="btn primary" data-tour="policies-new" onClick={() => navigate({ section: "policies", mode: "create" })}>
            <Icon name="plus" size={14} /> New policy
          </button>
        </div>
      </div>

      {error && (
        <div style={{ marginBottom: "14px", padding: "10px 14px", background: "var(--danger-soft)", border: "1px solid color-mix(in oklab,var(--danger) 30%, transparent)", borderRadius: "var(--radius-sm)", fontSize: "13px", color: "var(--danger)" }}>{error}</div>
      )}

      {policies.length > 0 && (
        <ListToolbar
          noun="policies"
          searchPlaceholder="Search by name, description, or ID"
          config={POLICY_LIST_CONFIG}
          state={listFilter}
          onChange={onListFilterChange}
          shown={visiblePolicies.length}
          total={policies.length}
        />
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {policies.length === 0 && <div className="placeholder" style={{ minHeight: "120px" }}>No policies yet.</div>}
        {policies.length > 0 && visiblePolicies.length === 0 && (
          <NoListMatches noun="policies" onClear={() => onListFilterChange(EMPTY_LIST_FILTER)} />
        )}
        {visiblePolicies.map((p) => (
          <RowCard key={p.id} ariaLabel={`Open policy ${p.name}`} onClick={() => navigate({ section: "policies", mode: "detail", id: p.id })}>
            <span style={{ width: 36, height: 36, borderRadius: "8px", display: "grid", placeItems: "center", background: "var(--panel-2)", color: "var(--text-faint)", border: "1px solid var(--border-soft)", flex: "none" }}>
              <Icon name="config" size={17} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row-card-tags" style={{ display: "flex", alignItems: "center", gap: "9px" }}>
                <span style={{ fontSize: "13.5px", fontWeight: 600 }}>{p.name}</span>
                {p.builtin && <Tag tone="active" mono={false}>built-in</Tag>}
                <Tag tone="muted" mono={false}>{p.ruleCount ?? 0} rules</Tag>
                <Tag tone="muted" mono={false}>{p.bindingCount ?? 0} assigned</Tag>
              </div>
              {p.description && <div style={{ fontSize: "12px", color: "var(--text-faint)", marginTop: "3px" }}>{p.description}</div>}
              {(p.bindings ?? []).some((b) => b.principalType !== "system") && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "6px" }}>
                  {(p.bindings ?? []).filter((b) => b.principalType !== "system").map((b) => (
                    <Tag key={`${b.principalType}:${b.principalId}`} tone={b.principalType === "group" ? "info" : "muted"} mono={false}>
                      {b.principalType}: {formatNameWithId(b.principalName, b.principalId)}
                    </Tag>
                  ))}
                </div>
              )}
            </div>
            <button className="btn ghost" disabled={busy === p.id} onClick={(event) => { event.stopPropagation(); navigate({ section: "policies", mode: p.builtin ? "detail" : "edit", id: p.id }); }}>
              {p.builtin ? "View" : "Edit"}
            </button>
            {!p.builtin && (
              <button className="iconbtn" title="Delete" disabled={busy === p.id} onClick={(event) => { event.stopPropagation(); deletePolicy(p); }}>
                <Icon name="trash" size={14} />
              </button>
            )}
          </RowCard>
        ))}
      </div>

    </>
  );
}
