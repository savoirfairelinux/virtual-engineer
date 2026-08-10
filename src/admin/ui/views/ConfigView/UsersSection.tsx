import { useCallback, useEffect, useState } from "react";
import { RowCard } from "../../components/RowCard.tsx";
import { Tag } from "../../components/Tag.tsx";
import { Toggle } from "../../components/Toggle.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Modal, Field, FieldInput, FieldSelect, FormError, FormRow, FormActions } from "../../components/Modal.tsx";
import { PasswordField } from "../../components/PasswordField.tsx";
import { Drawer, DetailSection, DetailRow, StatusBanner } from "../../components/Drawer.tsx";
import { api } from "../../api.ts";
import { useCurrentUser } from "../../authContext.tsx";
import type { ApiUser, UserRole } from "../../types.ts";
import type { ConfigSectionProps } from "./index.tsx";

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
          <PasswordField value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm password" required>
          <PasswordField value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <Field label="Role" required hint="viewer = overview + tasks (read-only) · operator = all config incl. integrations/OAuth/webhooks · admin = adds user management + audit">
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
          <PasswordField value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm password" required>
          <PasswordField value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
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

function UserEditModal({ user, onClose, onSaved }: { user: ApiUser; onClose: () => void; onSaved: () => void }) {
  const [role, setRole] = useState<UserRole>(user.role);
  const [enabled, setEnabled] = useState(user.enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await api.put(`/api/admin/users/${user.id}`, { role, enabled });
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Update failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Edit user — ${user.username}`} sub="Role and account availability" onClose={onClose}>
      <FormRow>
        <Field label="Role" required>
          <FieldSelect value={role} onChange={(event) => setRole(event.target.value as UserRole)}>
            {ROLES.map((value) => <option key={value} value={value}>{value}</option>)}
          </FieldSelect>
        </Field>
        <Field label="Account status" hint="Disabling an account revokes its active sessions">
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <Toggle label="User account enabled" on={enabled} onChange={() => setEnabled((value) => !value)} />
            <span>{enabled ? "Enabled" : "Disabled"}</span>
          </div>
        </Field>
        <FormError msg={error} />
        <FormActions>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </FormActions>
      </FormRow>
    </Modal>
  );
}

/* ─── Users section ───────────────────────────────────────────────────── */

export function UsersSection({ route, navigate, markClean }: ConfigSectionProps) {
  const { user: me } = useCurrentUser();
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ users: ApiUser[] }>("/api/admin/users");
      setUsers(r.users);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load users");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function mutate(id: string, fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(id);
    setError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function deleteUser(u: ApiUser): Promise<boolean> {
    if (!window.confirm(`Delete user "${u.username}"? This cannot be undone.`)) return false;
    return mutate(u.id, () => api.delete(`/api/admin/users/${u.id}`));
  }

  const routeId = route.section === "users" && (route.mode === "detail" || route.mode === "edit" || route.mode === "password")
    ? route.id
    : null;
  const routeUser = routeId ? users.find((user) => user.id === routeId) : undefined;

  function saved(destination: "list" | "detail") {
    markClean();
    void load();
    navigate(destination === "detail" && routeId
      ? { section: "users", mode: "detail", id: routeId }
      : { section: "users", mode: "list" });
  }

  if (route.mode === "create") {
    return (
      <UserFormModal
        onClose={() => navigate({ section: "users", mode: "list" })}
        onSaved={() => saved("list")}
      />
    );
  }

  if (route.mode === "detail") {
    if (!routeUser) return <UserMissing onBack={() => navigate({ section: "users", mode: "list" })} />;
    return (
      <Drawer
        eyebrow={`User · ${routeUser.role}`}
        title={routeUser.username}
        onClose={() => navigate({ section: "users", mode: "list" })}
        footer={
          <>
            <button className="btn" onClick={() => navigate({ section: "users", mode: "list" })}>Back</button>
            <span className="spacer" />
            <button className="btn danger" onClick={() => void deleteUser(routeUser).then((deleted) => { if (deleted) navigate({ section: "users", mode: "list" }); })}>
              <Icon name="trash" size={13} /> Delete
            </button>
            <button className="btn" onClick={() => navigate({ section: "users", mode: "password", id: routeUser.id })}>Reset password</button>
            <button className="btn primary" onClick={() => navigate({ section: "users", mode: "edit", id: routeUser.id })}><Icon name="edit" size={13} /> Edit</button>
          </>
        }
      >
        <StatusBanner
          tone={routeUser.enabled ? "ok" : "muted"}
          icon={routeUser.enabled ? "check" : "pause"}
          title={routeUser.enabled ? "Enabled" : "Disabled"}
          sub={routeUser.enabled ? "This account can sign in." : "This account cannot sign in."}
        />
        <DetailSection label="Account">
          <DetailRow k="Username">{routeUser.username}</DetailRow>
          <DetailRow k="Role">{routeUser.role}</DetailRow>
          <DetailRow k="User ID" mono>{routeUser.id}</DetailRow>
          <DetailRow k="Created">{new Date(routeUser.createdAt).toLocaleDateString()}</DetailRow>
        </DetailSection>
      </Drawer>
    );
  }

  if (route.mode === "edit" || route.mode === "password") {
    if (!routeUser) return <UserMissing onBack={() => navigate({ section: "users", mode: "list" })} />;
    return route.mode === "edit" ? (
      <UserEditModal
        user={routeUser}
        onClose={() => navigate({ section: "users", mode: "detail", id: routeUser.id })}
        onSaved={() => saved("detail")}
      />
    ) : (
      <ResetPasswordModal
        user={routeUser}
        onClose={() => navigate({ section: "users", mode: "detail", id: routeUser.id })}
        onSaved={() => saved("detail")}
      />
    );
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
          <button className="btn primary" onClick={() => navigate({ section: "users", mode: "create" })}>
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
          <RowCard key={u.id} ariaLabel={`Open user ${u.username}`} onClick={() => navigate({ section: "users", mode: "detail", id: u.id })}>
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
            <Tag tone={u.enabled ? "ok" : "muted"}>{u.enabled ? "enabled" : "disabled"}</Tag>
            <button
              className="iconbtn"
              title="Reset password"
              disabled={busy === u.id}
              onClick={(event) => { event.stopPropagation(); navigate({ section: "users", mode: "password", id: u.id }); }}
            >
              <Icon name="refresh" size={14} />
            </button>
            <button
              className="iconbtn"
              title="Delete"
              disabled={busy === u.id}
              onClick={(event) => { event.stopPropagation(); void deleteUser(u); }}
            >
              <Icon name="trash" size={14} />
            </button>
          </RowCard>
        ))}
      </div>

    </>
  );
}

function UserMissing({ onBack }: { onBack: () => void }) {
  return (
    <div className="config-missing">
      <div className="placeholder">This user is unavailable.</div>
      <button className="btn" onClick={onBack}>Back to users</button>
    </div>
  );
}
