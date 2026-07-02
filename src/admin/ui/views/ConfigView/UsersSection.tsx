import { useCallback, useEffect, useState } from "react";
import { RowCard } from "../../components/RowCard.tsx";
import { Tag } from "../../components/Tag.tsx";
import { Toggle } from "../../components/Toggle.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Modal, Field, FieldInput, FieldSelect, FormError, FormRow, FormActions } from "../../components/Modal.tsx";
import { api } from "../../api.ts";
import { useCurrentUser } from "../../authContext.tsx";
import type { ApiUser, UserRole } from "../../types.ts";

const ROLE_TONE = { admin: "active", operator: "info", viewer: "muted" } as const;
const ROLES: readonly UserRole[] = ["admin", "operator", "viewer"];

/* ─── Create-user modal ───────────────────────────────────────────────── */

function UserFormModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [role, setRole] = useState<UserRole>("viewer");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = username.trim().length > 0 && password.length >= 8 && confirm.length > 0;

  async function handleSave() {
    if (password !== confirm) { setError("Passwords do not match."); return; }
    setSaving(true);
    setError(null);
    try {
      await api.post("/api/admin/users", { username: username.trim(), password, role });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="New user" sub="Create a dashboard account" onClose={onClose}>
      <FormRow>
        <Field label="Username" required>
          <FieldInput value={username} autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label="Password" required hint="Minimum 8 characters">
          <FieldInput type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm password" required>
          <FieldInput type="password" value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <Field label="Role" required hint="viewer = read-only · operator = mutations except integrations/OAuth/webhooks · admin = everything">
          <FieldSelect value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </FieldSelect>
        </Field>

        <FormError msg={error} />

        <FormActions>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => void handleSave()} disabled={saving || !canSubmit}>
            {saving ? "Creating…" : "Create user"}
          </button>
        </FormActions>
      </FormRow>
    </Modal>
  );
}

/* ─── Reset-password modal ────────────────────────────────────────────── */

function ResetPasswordModal({ user, onClose, onSaved }: { user: ApiUser; onClose: () => void; onSaved: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (password !== confirm) { setError("Passwords do not match."); return; }
    setSaving(true);
    setError(null);
    try {
      await api.put(`/api/admin/users/${user.id}/password`, { password });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reset failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Reset password" sub={`Account: ${user.username} — all sessions of this user are revoked`} onClose={onClose}>
      <FormRow>
        <Field label="New password" required hint="Minimum 8 characters">
          <FieldInput type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm password" required>
          <FieldInput type="password" value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
        </Field>

        <FormError msg={error} />

        <FormActions>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => void handleSave()} disabled={saving || password.length < 8 || confirm.length === 0}>
            {saving ? "Saving…" : "Reset password"}
          </button>
        </FormActions>
      </FormRow>
    </Modal>
  );
}

/* ─── Users section ───────────────────────────────────────────────────── */

export function UsersSection() {
  const { user: me } = useCurrentUser();
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [resetUser, setResetUser] = useState<ApiUser | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ users: ApiUser[] }>("/api/admin/users");
      setUsers(r.users);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load users");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function mutate(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(null);
    }
  }

  function changeRole(u: ApiUser, role: UserRole) {
    if (role === u.role) return;
    void mutate(u.id, () => api.put(`/api/admin/users/${u.id}`, { role }));
  }

  function toggleEnabled(u: ApiUser) {
    void mutate(u.id, () => api.put(`/api/admin/users/${u.id}`, { enabled: !u.enabled }));
  }

  function deleteUser(u: ApiUser) {
    if (!window.confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
    void mutate(u.id, () => api.delete(`/api/admin/users/${u.id}`));
  }

  return (
    <>
      <div style={{ marginBottom: "22px" }}>
        <div className="eyebrow" style={{ marginBottom: "8px" }}>Configuration / Users</div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 600, letterSpacing: "-0.01em" }}>Users</h1>
            <p style={{ margin: "6px 0 0", color: "var(--text-faint)", fontSize: "13.5px" }}>Dashboard accounts and their roles — admin, operator, or viewer.</p>
          </div>
          <button className="btn primary" onClick={() => setShowAdd(true)}>
            <Icon name="plus" size={14} /> New user
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            marginBottom: "14px", padding: "10px 14px",
            background: "var(--danger-soft)",
            border: "1px solid color-mix(in oklab,var(--danger) 30%, transparent)",
            borderRadius: "var(--radius-sm)", fontSize: "13px", color: "var(--danger)",
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {users.length === 0 && (
          <div className="placeholder" style={{ minHeight: "120px" }}>No users found.</div>
        )}
        {users.map((u) => (
          <RowCard key={u.id}>
            <span
              style={{
                width: 36, height: 36, borderRadius: "8px",
                display: "grid", placeItems: "center",
                background: "var(--panel-2)", color: "var(--text-faint)",
                border: "1px solid var(--border-soft)", flex: "none",
              }}
            >
              <Icon name="user" size={17} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
                <span style={{ fontSize: "13.5px", fontWeight: 600 }}>{u.username}</span>
                <Tag tone={ROLE_TONE[u.role]} mono={false}>{u.role}</Tag>
                {me?.id === u.id && <Tag tone="ok" mono={false}>you</Tag>}
              </div>
              <div style={{ fontSize: "12px", color: "var(--text-faint)", marginTop: "3px" }}>
                created {new Date(u.createdAt).toLocaleDateString()}
              </div>
            </div>
            <select
              value={u.role}
              disabled={busy === u.id}
              onChange={(e) => changeRole(u, e.target.value as UserRole)}
              style={{
                padding: "5px 8px", fontSize: "12px", fontFamily: "var(--font-sans)",
                border: "1px solid var(--border)", borderRadius: "var(--radius-sm)",
                background: "var(--panel-2)", color: "var(--text)", cursor: "pointer",
              }}
              title="Change role"
            >
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <Toggle
              on={u.enabled}
              disabled={busy === u.id}
              onChange={() => toggleEnabled(u)}
            />
            <button
              className="iconbtn"
              title="Reset password"
              disabled={busy === u.id}
              onClick={() => setResetUser(u)}
            >
              <Icon name="refresh" size={14} />
            </button>
            <button
              className="iconbtn"
              title="Delete"
              disabled={busy === u.id}
              onClick={() => deleteUser(u)}
            >
              <Icon name="trash" size={14} />
            </button>
          </RowCard>
        ))}
      </div>

      {showAdd && (
        <UserFormModal
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); void load(); }}
        />
      )}
      {resetUser && (
        <ResetPasswordModal
          user={resetUser}
          onClose={() => setResetUser(null)}
          onSaved={() => { setResetUser(null); void load(); }}
        />
      )}
    </>
  );
}
