import { useState } from "react";
import { Modal, Field, FormError, FormRow, FormActions } from "../components/Modal.tsx";
import { PasswordField } from "../components/PasswordField.tsx";
import { api } from "../api.ts";
import type { ApiMe } from "../types.ts";

interface Props {
  user: ApiMe;
  onClose: () => void;
  /** Called after a successful change — the server revoked all sessions, so the caller must return to the login screen. */
  onChanged: () => void;
}

export function ChangePasswordModal({ user, onClose, onChanged }: Props) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const canSubmit = currentPassword.length > 0 && password.length >= 8 && confirm.length > 0;

  async function handleSave() {
    if (password !== confirm) { setError("Passwords do not match."); return; }
    setSaving(true);
    setError(null);
    try {
      await api.put(`/api/admin/users/${user.id}/password`, { password, currentPassword });
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Password change failed");
    } finally {
      setSaving(false);
    }
  }

  if (done) {
    return (
      <Modal title="Password changed" onClose={onChanged}>
        <FormRow>
          <div style={{ fontSize: "13.5px", color: "var(--text-dim)" }}>
            Your password was updated and all your sessions were revoked.
            Please sign in again with the new password.
          </div>
          <FormActions>
            <button className="btn primary" onClick={onChanged}>Go to login</button>
          </FormActions>
        </FormRow>
      </Modal>
    );
  }

  return (
    <Modal title="Change password" sub={`Account: ${user.username}`} onClose={onClose}>
      <FormRow>
        <Field label="Current password" required>
          <PasswordField
            value={currentPassword}
            autoComplete="current-password"
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </Field>
        <Field label="New password" required hint="Minimum 8 characters">
          <PasswordField
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Confirm new password" required>
          <PasswordField
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>

        <FormError msg={error} />

        <FormActions>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => void handleSave()} disabled={saving || !canSubmit}>
            {saving ? "Saving…" : "Change password"}
          </button>
        </FormActions>
      </FormRow>
    </Modal>
  );
}
