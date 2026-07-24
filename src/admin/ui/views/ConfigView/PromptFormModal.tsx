import { useState } from "react";
import { Modal, Field, FieldInput, FieldSelect, FormError, FormRow, FormActions, FieldTextarea } from "../../components/Modal.tsx";
import { api } from "../../api.ts";
import type { ApiPrompt } from "../../types.ts";

interface Props {
  prompt?: ApiPrompt | undefined;
  /** When true (viewer role), the form is read-only — no save button, disabled inputs. */
  readOnly?: boolean | undefined;
  onClose: () => void;
  onSaved: () => void;
}

export function PromptFormModal({ prompt, readOnly, onClose, onSaved }: Props) {
  const isEdit = !!prompt;
  const [label, setLabel] = useState(prompt?.label ?? "");
  const [content, setContent] = useState(prompt?.content ?? "");
  const [promptType, setPromptType] = useState<"system" | "instructions">(prompt?.promptType ?? "instructions");
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
        await api.post("/api/admin/prompts", { label, content, promptType });
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
      title={readOnly ? `Prompt — ${prompt!.label}` : isEdit ? `Edit Prompt — ${prompt!.label}` : "New Prompt"}
      onClose={onClose}
      width={700}
    >
      <FormRow>
        <Field label="Label" required hint="Short identifier (e.g. system_gerrit_code)">
          <FieldInput
            value={label}
            placeholder="my_prompt_label"
            readOnly={readOnly}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>

        <Field label="Role" required hint="Agent instructions are permanent; workflow instructions guide a generated task request">
          <FieldSelect
            value={promptType}
            disabled={isEdit || readOnly}
            onChange={(event) => setPromptType(event.target.value as "system" | "instructions")}
          >
            <option value="system">Agent instructions</option>
            <option value="instructions">Workflow instructions</option>
          </FieldSelect>
        </Field>

        <Field label="Content" required hint={`${content.length} characters`}>
          <FieldTextarea
            value={content}
            placeholder="Enter prompt content…"
            readOnly={readOnly}
            onChange={(e) => setContent(e.target.value)}
            style={{ minHeight: "360px" }}
          />
        </Field>

        <FormError msg={error} />

        <FormActions>
          <button className="btn ghost" onClick={onClose}>{readOnly ? "Close" : "Cancel"}</button>
          {!readOnly && (
            <button className="btn primary" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : isEdit ? "Save changes" : "Create prompt"}
            </button>
          )}
        </FormActions>
      </FormRow>
    </Modal>
  );
}
