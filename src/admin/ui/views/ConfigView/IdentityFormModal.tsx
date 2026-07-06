import { useState } from "react";
import { Modal, Field, FieldInput, FormError, FormRow, FormActions, FieldTextarea } from "../../components/Modal.tsx";
import { api } from "../../api.ts";
import type { ApiIdentity } from "../../types.ts";

interface Props {
  identity?: ApiIdentity | undefined;
  onClose: () => void;
  onSaved: () => void;
}

export function IdentityFormModal({ identity, onClose, onSaved }: Props) {
  const isEdit = !!identity;
  const [name, setName] = useState(identity?.name ?? "");
  const [email, setEmail] = useState(identity?.email ?? "");
  const [username, setUsername] = useState(identity?.username ?? "");
  const [signature, setSignature] = useState(identity?.signature ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!name.trim()) { setError("Name is required"); return; }
    setSaving(true);
    setError(null);
    try {
      const payload = { name, email, username, signature };
      if (isEdit) {
        await api.put(`/api/admin/identities/${identity!.id}`, payload);
      } else {
        await api.post("/api/admin/identities", payload);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={isEdit ? `Edit Identity — ${identity!.name}` : "New Identity"}
      onClose={onClose}
      width={560}
    >
      <FormRow>
        <Field label="Name" required hint="Display name (e.g. Virtual Engineer)">
          <FieldInput value={name} placeholder="Virtual Engineer" onChange={(e) => setName(e.target.value)} />
        </Field>

        <Field label="Email" hint="Email address associated with this identity">
          <FieldInput value={email} placeholder="ve@example.com" onChange={(e) => setEmail(e.target.value)} />
        </Field>

        <Field label="Username" hint="Handle used on integrations">
          <FieldInput value={username} placeholder="virtual-engineer" onChange={(e) => setUsername(e.target.value)} />
        </Field>

        <Field label="Signature" hint="Appended to posted comments (optional)">
          <FieldTextarea
            value={signature}
            placeholder="— Virtual Engineer"
            onChange={(e) => setSignature(e.target.value)}
            style={{ minHeight: "120px" }}
          />
        </Field>

        <FormError msg={error} />

        <FormActions>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create identity"}
          </button>
        </FormActions>
      </FormRow>
    </Modal>
  );
}
