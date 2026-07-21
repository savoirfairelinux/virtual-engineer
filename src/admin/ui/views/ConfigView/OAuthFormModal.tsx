import { useState } from "react";
import { Modal, Field, FieldInput, FieldSelect, FormError, FormRow, FormActions } from "../../components/Modal.tsx";
import { api } from "../../api.ts";

interface Props {
  onClose: () => void;
  onSaved: () => void;
}

export function OAuthFormModal({ onClose, onSaved }: Props) {
  const [provider, setProvider] = useState("gitlab");
  const [baseUrl, setBaseUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!baseUrl.trim()) { setError("Base URL is required"); return; }
    if (!clientId.trim()) { setError("Client ID is required"); return; }
    setSaving(true);
    setError(null);
    try {
      await api.post("/api/admin/oauth-apps", { provider, baseUrl: baseUrl.trim(), clientId: clientId.trim() });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Register OAuth App" onClose={onClose}>
      <FormRow>
        <Field label="Provider" required>
          <FieldSelect value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="gitlab">GitLab</option>
            <option value="github">GitHub</option>
          </FieldSelect>
        </Field>

        <Field label="Base URL" required hint={provider === "gitlab" ? "e.g. https://gitlab.example.com" : "e.g. https://github.com"}>
          <FieldInput
            value={baseUrl}
            placeholder={provider === "gitlab" ? "https://gitlab.example.com" : "https://github.com"}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </Field>

        <Field label="Client ID" required hint="OAuth application client_id from the provider">
          <FieldInput
            value={clientId}
            placeholder="your-client-id"
            onChange={(e) => setClientId(e.target.value)}
          />
        </Field>

        <FormError msg={error} />

        <FormActions>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Register app"}
          </button>
        </FormActions>
      </FormRow>
    </Modal>
  );
}
