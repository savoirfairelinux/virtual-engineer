import { useState } from "react";
import { Modal, Field, FieldInput, FieldSelect, FormError, FormRow, FormActions, FieldTextarea } from "../../components/Modal.tsx";
import { api } from "../../api.ts";
import type { ApiPrompt } from "../../types.ts";

const PROMPT_TYPE_LABELS = {
  system: "System Prompt",
  instructions: "Instructions Prompt",
} as const;

const PROMPT_TYPE_HINTS = {
  system: "Permanent instructions that shape the agent's base behavior.",
  instructions: "Task-specific guidance that is merged into each generated request.",
} as const;

const PROMPT_CONTENT_HINTS = {
  system: "Write the full prompt body. Example: You are a careful coding agent. Follow repository conventions and never commit secrets.",
  instructions: "Write the full prompt body. Example: Prefer small patches, explain trade-offs, and mention the files you changed.",
} as const;

const PROMPT_TYPE_EXAMPLES = {
  system: "Example: You are a careful coding agent. Follow repository conventions and never commit secrets.",
  instructions: "Example: Prefer small patches, explain trade-offs, and mention the files you changed.",
} as const;

interface Props {
  prompt?: ApiPrompt | undefined;
  /** When true (viewer role), the form is read-only — no save button, disabled inputs. */
  readOnly?: boolean | undefined;
  onEdit?: (() => void) | undefined;
  onClose: () => void;
  onSaved: () => void;
}

export function PromptFormModal({ prompt, readOnly, onEdit, onClose, onSaved }: Props) {
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
        await api.put(`/api/admin/prompts/${prompt!.id}`, { content });
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
        <Field label="Label" required hint="Short name used to generate the prompt ID">
          <FieldInput
            data-tour="prompt-form-label"
            value={label}
            placeholder="my_prompt_label"
            readOnly={readOnly || isEdit}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>

        <Field label="Prompt type" required hint={PROMPT_TYPE_HINTS[promptType]}>
          <FieldSelect
            data-tour="prompt-form-type"
            value={promptType}
            disabled={isEdit || readOnly}
            onChange={(event) => setPromptType(event.target.value as "system" | "instructions")}
          >
            <option value="system">{PROMPT_TYPE_LABELS.system}</option>
            <option value="instructions">{PROMPT_TYPE_LABELS.instructions}</option>
          </FieldSelect>
        </Field>

        <Field label="Content" required hint={PROMPT_CONTENT_HINTS[promptType]}>
          <FieldTextarea
            data-tour="prompt-form-content"
            value={content}
            placeholder={PROMPT_TYPE_EXAMPLES[promptType]}
            readOnly={readOnly}
            onChange={(e) => setContent(e.target.value)}
            style={{ minHeight: "360px" }}
          />
        </Field>

        <FormError msg={error} />

        <FormActions>
          <button className="btn ghost" onClick={onClose}>{readOnly ? "Close" : "Cancel"}</button>
          {readOnly && onEdit && (
            <button className="btn primary" onClick={onEdit}>Edit prompt</button>
          )}
          {!readOnly && (
            <button className="btn primary" data-tour="prompt-form-actions" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : isEdit ? "Save changes" : "Create prompt"}
            </button>
          )}
        </FormActions>
      </FormRow>
    </Modal>
  );
}
