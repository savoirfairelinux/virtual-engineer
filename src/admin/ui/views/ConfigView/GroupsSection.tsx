import { useCallback, useEffect, useState } from "react";
import { RowCard } from "../../components/RowCard.tsx";
import { Tag } from "../../components/Tag.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Modal, Field, FieldInput, FieldSelect, FormError, FormRow, FormActions } from "../../components/Modal.tsx";
import { api } from "../../api.ts";
import type { ApiGroup, ApiGroupDetail, ApiUser } from "../../types.ts";

/* ─── Create-group modal ──────────────────────────────────────────────── */

function GroupFormModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await api.post("/api/admin/groups", { name: name.trim(), description });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="New group" sub="A named set of users that policies can target" onClose={onClose}>
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
            {saving ? "Creating…" : "Create group"}
          </button>
        </FormActions>
      </FormRow>
    </Modal>
  );
}

/* ─── Members modal ───────────────────────────────────────────────────── */

function MembersModal({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<ApiGroupDetail | null>(null);
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [addUserId, setAddUserId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [g, u] = await Promise.all([
        api.get<{ group: ApiGroupDetail }>(`/api/admin/groups/${groupId}`),
        api.get<{ users: ApiUser[] }>("/api/admin/users"),
      ]);
      setDetail(g.group);
      setUsers(u.users);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load group");
    }
  }, [groupId]);

  useEffect(() => { void load(); }, [load]);

  async function mutate(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Update failed"); }
    finally { setBusy(false); }
  }

  const memberIds = new Set((detail?.members ?? []).map((m) => m.id));
  const candidates = users.filter((u) => !memberIds.has(u.id));

  return (
    <Modal title="Group members" sub={detail?.name ?? ""} onClose={onClose}>
      <FormRow>
        <FormError msg={error} />
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "10px" }}>
          {(detail?.members ?? []).length === 0 && (
            <div className="placeholder" style={{ minHeight: "60px" }}>No members yet.</div>
          )}
          {(detail?.members ?? []).map((m) => (
            <RowCard key={m.id}>
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: "13px", fontWeight: 600 }}>{m.username}</span>{" "}
                <Tag tone="muted" mono={false}>{m.role}</Tag>
              </div>
              <button className="iconbtn" title="Remove" disabled={busy}
                onClick={() => void mutate(() => api.delete(`/api/admin/groups/${groupId}/members/${m.id}`))}>
                <Icon name="trash" size={14} />
              </button>
            </RowCard>
          ))}
        </div>
        <Field label="Add member">
          <div style={{ display: "flex", gap: "8px" }}>
            <FieldSelect value={addUserId} onChange={(e) => setAddUserId(e.target.value)}>
              <option value="">Select a user…</option>
              {candidates.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
            </FieldSelect>
            <button className="btn primary" disabled={busy || !addUserId}
              onClick={() => void mutate(async () => { await api.post(`/api/admin/groups/${groupId}/members`, { userId: addUserId }); setAddUserId(""); })}>
              Add
            </button>
          </div>
        </Field>
        <FormActions>
          <button className="btn ghost" onClick={onClose}>Done</button>
        </FormActions>
      </FormRow>
    </Modal>
  );
}

/* ─── Groups section ──────────────────────────────────────────────────── */

export function GroupsSection() {
  const [groups, setGroups] = useState<ApiGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [membersOf, setMembersOf] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ groups: ApiGroup[] }>("/api/admin/groups");
      setGroups(r.groups);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load groups");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function deleteGroup(g: ApiGroup) {
    if (!window.confirm(`Delete group "${g.name}"? Members are unassigned; bound policies are unaffected.`)) return;
    setBusy(g.id);
    void api.delete(`/api/admin/groups/${g.id}`).then(load).catch((e: unknown) => setError(e instanceof Error ? e.message : "Delete failed")).finally(() => setBusy(null));
  }

  return (
    <>
      <div style={{ marginBottom: "22px" }}>
        <div className="eyebrow" style={{ marginBottom: "8px" }}>Access Control / Groups</div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 600, letterSpacing: "-0.01em" }}>Groups</h1>
            <p style={{ margin: "6px 0 0", color: "var(--text-faint)", fontSize: "13.5px" }}>Collections of users. Bind a policy to a group to grant access to all its members.</p>
          </div>
          <button className="btn primary" onClick={() => setShowAdd(true)}>
            <Icon name="plus" size={14} /> New group
          </button>
        </div>
      </div>

      {error && (
        <div style={{ marginBottom: "14px", padding: "10px 14px", background: "var(--danger-soft)", border: "1px solid color-mix(in oklab,var(--danger) 30%, transparent)", borderRadius: "var(--radius-sm)", fontSize: "13px", color: "var(--danger)" }}>{error}</div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {groups.length === 0 && <div className="placeholder" style={{ minHeight: "120px" }}>No groups yet.</div>}
        {groups.map((g) => (
          <RowCard key={g.id}>
            <span style={{ width: 36, height: 36, borderRadius: "8px", display: "grid", placeItems: "center", background: "var(--panel-2)", color: "var(--text-faint)", border: "1px solid var(--border-soft)", flex: "none" }}>
              <Icon name="user" size={17} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
                <span style={{ fontSize: "13.5px", fontWeight: 600 }}>{g.name}</span>
                <Tag tone="muted" mono={false}>{g.memberCount ?? 0} members</Tag>
              </div>
              {g.description && <div style={{ fontSize: "12px", color: "var(--text-faint)", marginTop: "3px" }}>{g.description}</div>}
            </div>
            <button className="btn ghost" disabled={busy === g.id} onClick={() => setMembersOf(g.id)}>Members</button>
            <button className="iconbtn" title="Delete" disabled={busy === g.id} onClick={() => deleteGroup(g)}>
              <Icon name="trash" size={14} />
            </button>
          </RowCard>
        ))}
      </div>

      {showAdd && <GroupFormModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); void load(); }} />}
      {membersOf && <MembersModal groupId={membersOf} onClose={() => { setMembersOf(null); void load(); }} />}
    </>
  );
}
