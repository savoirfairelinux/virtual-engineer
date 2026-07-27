import { useState, useEffect } from "react";
import { Modal, Field, FieldInput, FieldSelect, FormError, FormRow, FormActions } from "../../components/Modal.tsx";
import { api } from "../../api.ts";
import type { ApiAgent, ApiIntegration, ApiPrompt } from "../../types.ts";

interface AvailableModel {
  id: string;
  name: string;
  vendor?: string;
  version?: string;
  category?: string;
  contextWindowTokens?: number;
  supportedReasoningEfforts?: string[];
}

interface Props {
  agent?: ApiAgent | undefined;
  integrations: ApiIntegration[];
  prompts: ApiPrompt[];
  onClose: () => void;
  onSaved: () => void;
}

interface AgentForm {
  name: string;
  type: "coding" | "review";
  integrationId: string;
  model: string;
  maxConcurrent: string;
  systemPromptId: string;
  instructionsPromptId: string;
  feedbackInstructionsPromptId: string;
}

export function AgentFormModal({ agent, integrations, prompts, onClose, onSaved }: Props) {
  const isEdit = !!agent;
  const agentIntegrations = integrations.filter((i) => i.domainCapabilities.includes("agent_execution") && i.enabled);

  const [form, setForm] = useState<AgentForm>({
    name: agent?.name ?? "",
    type: agent?.type ?? "coding",
    integrationId: agent?.integrationId ?? (agentIntegrations[0]?.id ?? ""),
    model: (agent?.modelConfig as Record<string, string>)?.["model"] ?? "",
    maxConcurrent: agent?.maxConcurrent?.toString() ?? "1",
    systemPromptId: agent?.systemPromptId ?? "",
    instructionsPromptId: agent?.instructionsPromptId ?? "",
    feedbackInstructionsPromptId: agent?.feedbackInstructionsPromptId ?? "",
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  // Fetch available models whenever the selected integration changes
  useEffect(() => {
    const integrationId = form.integrationId;
    if (!integrationId) { setAvailableModels([]); return; }

    // Fast path: models already embedded in the loaded integration list
    const integration = agentIntegrations.find((i) => i.id === integrationId);
    const cached = integration?.discoveredResources?.models;
    if (Array.isArray(cached) && cached.length > 0) {
      setAvailableModels(cached.map((model) => typeof model === "string" ? { id: model, name: model } : model));
      return;
    }

    // Slow path: trigger discovery on the backend then read the result
    let cancelled = false;
    setModelsLoading(true);
    api.post(`/api/admin/integrations/${integrationId}/discover`, {})
      .then(() => api.get<{ models: AvailableModel[] }>(`/api/admin/integrations/${integrationId}/models`))
      .then((res) => {
        if (cancelled) return;
        const models = Array.isArray(res.models)
          ? res.models.map((model) => typeof model === "string" ? { id: model, name: model } : model)
          : [];
        setAvailableModels(models);
        if (models.length > 0 && form.model && !models.some((model) => model.id === form.model)) {
          setForm((prev) => ({ ...prev, model: "" }));
        }
      })
      .catch(() => { if (!cancelled) setAvailableModels([]); })
      .finally(() => { if (!cancelled) setModelsLoading(false); });
    return () => { cancelled = true; };
  }, [form.integrationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: keyof AgentForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm((prev) => ({ ...prev, [k]: e.target.value }));
  };

  const handleSave = async () => {
    if (!form.name.trim()) { setError("Agent name is required"); return; }
    if (!form.integrationId) { setError("Select an agent integration"); return; }
    setSaving(true);
    setError(null);
    try {
      const maxConcurrent = parseInt(form.maxConcurrent, 10);
      const payload = {
        name: form.name,
        type: form.type,
        integrationId: form.integrationId || null,
        modelConfig: form.model ? { model: form.model } : {},
        maxConcurrent: isNaN(maxConcurrent) ? 1 : maxConcurrent,
        systemPromptId: form.systemPromptId || null,
        instructionsPromptId: form.instructionsPromptId || null,
        feedbackInstructionsPromptId: form.feedbackInstructionsPromptId || null,
      };
      if (isEdit) {
        await api.put(`/api/admin/agents/${agent!.id}`, payload);
      } else {
        await api.post("/api/admin/agents", payload);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={isEdit ? `Edit Agent — ${agent!.name}` : "New Agent"} onClose={onClose}>
      <FormRow>
        <Field label="Name" required>
          <FieldInput value={form.name} placeholder="My coding agent" onChange={set("name")} />
        </Field>

        <Field label="Type" required>
          <FieldSelect value={form.type} onChange={set("type") as React.ChangeEventHandler<HTMLSelectElement>}>
            <option value="coding">Coding</option>
            <option value="review">Review</option>
          </FieldSelect>
        </Field>

        <Field label="Agent Integration" required hint="An enabled agent-execution integration (e.g. Copilot, Claude, Aider, Mock)">
          <FieldSelect value={form.integrationId} onChange={set("integrationId")}>
            {agentIntegrations.length === 0 && <option value="">— no agent integrations —</option>}
            {agentIntegrations.map((i) => (
              <option key={i.id} value={i.id}>{i.name} ({i.provider})</option>
            ))}
          </FieldSelect>
        </Field>

        <Field label="Model" hint={availableModels.length > 0 ? "Select a model or leave on default" : "Leave blank to use default (auto)"}>
          {availableModels.length > 0 ? (
            <FieldSelect value={form.model} onChange={set("model") as React.ChangeEventHandler<HTMLSelectElement>} disabled={modelsLoading}>
              <option value="">— default (auto) —</option>
              {availableModels.map((model) => {
                const label = [model.name, model.vendor, model.version].filter(Boolean).join(" · ");
                return (
                  <option key={model.id} value={model.id}>
                    {label || model.id}
                  </option>
                );
              })}
            </FieldSelect>
          ) : (
            <FieldInput value={form.model} placeholder={modelsLoading ? "Loading models…" : "auto"} onChange={set("model")} disabled={modelsLoading} />
          )}
        </Field>

        <Field label="Max Concurrent" hint="Maximum simultaneous agent cycles (≥1)">
          <FieldInput type="number" min={1} value={form.maxConcurrent} onChange={set("maxConcurrent")} />
        </Field>

        <Field label="System Prompt">
          <FieldSelect value={form.systemPromptId} onChange={set("systemPromptId")}>
            <option value="">— none —</option>
            {prompts.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </FieldSelect>
        </Field>

        <Field label="Instructions Prompt">
          <FieldSelect value={form.instructionsPromptId} onChange={set("instructionsPromptId")}>
            <option value="">— none —</option>
            {prompts.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </FieldSelect>
        </Field>

        <Field label="Feedback Instructions Prompt" hint="Used on retry cycles (cycleNumber > 1)">
          <FieldSelect value={form.feedbackInstructionsPromptId} onChange={set("feedbackInstructionsPromptId")}>
            <option value="">— none —</option>
            {prompts.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </FieldSelect>
        </Field>

        <FormError msg={error} />

        <FormActions>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create agent"}
          </button>
        </FormActions>
      </FormRow>
    </Modal>
  );
}
