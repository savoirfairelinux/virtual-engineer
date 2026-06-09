import { useState } from "react";
import { Modal, Field, FieldInput, FormError, FormRow, FormActions, FieldTextarea } from "../../components/Modal.tsx";
import { api } from "../../api.ts";
import type { ApiPrompt } from "../../types.ts";

interface Props {
  prompt?: ApiPrompt | undefined;
  onClose: () => void;
  onSaved: () => void;
}

export function PromptFormModal({ prompt, onClose, onSaved }: Props) {
  const isEdit = !!prompt;
  const [label, setLabel] = useState(prompt?.label ?? "");
  const [content, setContent] = useState(prompt?.content ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!label.trim()) { setError("Label is required"); return; }
    if (!content.trim()) { setError("Content is required"); return; }
    setSaving(true);
    setError(null);
    try {
      if (isEdit) {
        await api.put(`/api/admin/prompts/${prompt!.id}`, { label, content });
      } else {
        await api.post("/api/admin/prompts", { label, content });
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
      title={isEdit ? `Edit Prompt — ${prompt!.label}` : "New Prompt"}
      onClose={onClose}
      width={700}
    >
      <FormRow>
        <Field label="Label" required hint="Short identifier (e.g. system_gerrit_code)">
          <FieldInput
            value={label}
            placeholder="my_prompt_label"
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>

        <Field label="Content" required hint={`${content.length} characters`}>
          <FieldTextarea
            value={content}
            placeholder="Enter prompt content…"
            onChange={(e) => setContent(e.target.value)}
            style={{ minHeight: "360px" }}
          />
        </Field>

        <FormError msg={error} />

        <FormActions>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create prompt"}
          </button>
        </FormActions>
      </FormRow>
    </Modal>
  );
}
