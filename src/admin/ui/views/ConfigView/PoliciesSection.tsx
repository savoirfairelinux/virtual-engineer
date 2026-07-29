import { useCallback, useEffect, useState } from "react";
import { RowCard } from "../../components/RowCard.tsx";
import { Tag } from "../../components/Tag.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Modal, Field, FieldInput, FieldSelect, FormError, FormRow, FormActions } from "../../components/Modal.tsx";
import { api } from "../../api.ts";
import type { ApiGroup, ApiPolicy, ApiPolicyDetail, ApiPolicyRule, ApiUser } from "../../types.ts";
import type { ConfigSectionProps } from "./index.tsx";

const SCOPEABLE = new Set(["project", "task"]);
function isScopeable(permission: string): boolean {
  const type = permission.split(".")[0] ?? "";
  return SCOPEABLE.has(type);
}

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
          <FieldInput value={name} autoComplete="off" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
          <FieldInput value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <FormError msg={error} />
        <FormActions>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => void handleSave()} disabled={saving || name.trim().length === 0}>
            {saving ? "Creating…" : "Create policy"}
          </button>
        </FormActions>
      </FormRow>
    </Modal>
  );
}

/* ─── Policy detail (rules + bindings) modal ──────────────────────────── */

function PolicyDetailModal({ policyId, forceReadOnly, onClose, onEdit, onPersisted }: {
  policyId: string;
  forceReadOnly: boolean;
  onClose: () => void;
  onEdit?: (() => void) | undefined;
  onPersisted: () => void;
}) {
  const [detail, setDetail] = useState<ApiPolicyDetail | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [groups, setGroups] = useState<ApiGroup[]>([]);
  const [rules, setRules] = useState<ApiPolicyRule[]>([]);
  const [savedRules, setSavedRules] = useState<ApiPolicyRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bindType, setBindType] = useState<"user" | "group">("user");
  const [bindId, setBindId] = useState("");

  const load = useCallback(async (preserveRuleDraft = false) => {
    try {
      const [d, p, u, g] = await Promise.all([
        api.get<{ policy: ApiPolicyDetail }>(`/api/admin/policies/${policyId}`),
        api.get<{ permissions: string[] }>("/api/admin/permissions"),
        api.get<{ users: ApiUser[] }>("/api/admin/users"),
        api.get<{ groups: ApiGroup[] }>("/api/admin/groups"),
      ]);
      const loadedRules = d.policy.rules.map((r) => ({ permission: r.permission, resourceId: r.resourceId }));
      setDetail(d.policy);
      if (!preserveRuleDraft) setRules(loadedRules);
      setSavedRules(loadedRules);
      setPermissions(p.permissions);
      setUsers(u.users);
      setGroups(g.groups);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load policy");
    }
  }, [policyId]);

  useEffect(() => { void load(); }, [load]);

  const readOnly = forceReadOnly || (detail?.builtin ?? false);
  const rulesDirty = JSON.stringify(rules) !== JSON.stringify(savedRules);

  function addRule() {
    setRules((rs) => [...rs, { permission: permissions[0] ?? "project.read", resourceId: null }]);
  }
  function updateRule(i: number, patch: Partial<ApiPolicyRule>) {
    setRules((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeRule(i: number) {
    setRules((rs) => rs.filter((_, idx) => idx !== i));
  }

  async function saveRules() {
    setBusy(true);
    setError(null);
    try {
      const payload = rules.map((r) => ({
        permission: r.permission,
        resourceId: isScopeable(r.permission) && r.resourceId ? r.resourceId : null,
      }));
      await api.put(`/api/admin/policies/${policyId}/rules`, { rules: payload });
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

  function principalLabel(type: "user" | "group", id: string): string {
    if (type === "user") return users.find((u) => u.id === id)?.username ?? id;
    return groups.find((g) => g.id === id)?.name ?? id;
  }

  const bindCandidates = bindType === "user" ? users.map((u) => ({ id: u.id, label: u.username })) : groups.map((g) => ({ id: g.id, label: g.name }));

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
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "10px" }}>
          {rules.length === 0 && <div className="placeholder" style={{ minHeight: "50px" }}>No grants — this policy grants nothing.</div>}
          {rules.map((r, i) => (
            <div key={i} className="policy-rule-edit-row" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <FieldSelect value={r.permission} disabled={readOnly} onChange={(e) => updateRule(i, { permission: e.target.value })}>
                {permissions.map((p) => <option key={p} value={p}>{p}</option>)}
              </FieldSelect>
              <FieldInput
                value={r.resourceId ?? ""}
                placeholder={isScopeable(r.permission) ? "resource id (blank = all)" : "global"}
                disabled={readOnly || !isScopeable(r.permission)}
                onChange={(e) => updateRule(i, { resourceId: e.target.value || null })}
              />
              {!readOnly && (
                <button data-config-dirty className="iconbtn" title="Remove" onClick={() => removeRule(i)}><Icon name="trash" size={14} /></button>
              )}
            </div>
          ))}
        </div>
        {!readOnly && (
          <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
            <button data-config-dirty className="btn ghost" onClick={addRule}><Icon name="plus" size={13} /> Add rule</button>
            <button className="btn primary" disabled={busy} onClick={() => void saveRules()}>{busy ? "Saving…" : "Save rules"}</button>
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
              {!readOnly && (
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

export function PoliciesSection({ route, navigate, markClean }: ConfigSectionProps) {
  const [policies, setPolicies] = useState<ApiPolicy[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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
          <button className="btn primary" onClick={() => navigate({ section: "policies", mode: "create" })}>
            <Icon name="plus" size={14} /> New policy
          </button>
        </div>
      </div>

      {error && (
        <div style={{ marginBottom: "14px", padding: "10px 14px", background: "var(--danger-soft)", border: "1px solid color-mix(in oklab,var(--danger) 30%, transparent)", borderRadius: "var(--radius-sm)", fontSize: "13px", color: "var(--danger)" }}>{error}</div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {policies.length === 0 && <div className="placeholder" style={{ minHeight: "120px" }}>No policies yet.</div>}
        {policies.map((p) => (
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
