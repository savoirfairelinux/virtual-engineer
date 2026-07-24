import { useState, useEffect } from "react";
import { Modal, Field, FieldInput, FieldSelect, FormError, FormRow, FormActions } from "../../components/Modal.tsx";
import { Icon } from "../../components/Icon.tsx";
import { api } from "../../api.ts";
import type { ApiAgent, ApiIntegration, ApiPlugin, ApiPrompt, PluginField } from "../../types.ts";

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
  plugins: ApiPlugin[];
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
  providerOptions: Record<string, string>;
}

function initialProviderOptions(agent: ApiAgent | undefined): Record<string, string> {
  const raw = agent?.modelConfig?.["providerOptions"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).map(([key, value]) => [key, String(value)])
  );
}

function serializeProviderOptions(
  fields: PluginField[],
  values: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.key]?.trim() ?? "";
    if (!value) continue;
    if (field.valueType === "number" || field.type === "number") {
      const numberValue = Number(value);
      if (Number.isFinite(numberValue) && numberValue > 0) result[field.key] = numberValue;
    } else if (field.valueType === "boolean") {
      result[field.key] = value === "true";
    } else {
      result[field.key] = value;
    }
  }
  return result;
}

export function AgentFormModal({ agent, integrations, plugins, prompts, onClose, onSaved }: Props) {
  const isEdit = !!agent;
  const systemPrompts = prompts.filter((prompt) => prompt.promptType === "system");
  const instructionsPrompts = prompts.filter((prompt) => prompt.promptType === "instructions");
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
    providerOptions: initialProviderOptions(agent),
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const selectedIntegration = agentIntegrations.find((integration) => integration.id === form.integrationId);
  const agentConfigFields = plugins.find((plugin) => plugin.provider === selectedIntegration?.provider)?.agentConfigFields ?? [];

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

  const setIntegration = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setForm((prev) => ({ ...prev, integrationId: event.target.value, model: "", providerOptions: {} }));
  };

  const setProviderOption = (key: string, value: string) => {
    setForm((prev) => ({
      ...prev,
      providerOptions: { ...prev.providerOptions, [key]: value },
    }));
  };

  const handleSave = async () => {
    if (!form.name.trim()) { setError("Agent name is required"); return; }
    if (!form.integrationId) { setError("Select an agent integration"); return; }
    if (!form.systemPromptId) { setError("Select agent instructions"); return; }
    if (!form.instructionsPromptId) { setError("Select workflow instructions"); return; }
    setSaving(true);
    setError(null);
    try {
      const maxConcurrent = parseInt(form.maxConcurrent, 10);
      const providerOptions = serializeProviderOptions(agentConfigFields, form.providerOptions);
      const payload = {
        name: form.name,
        type: form.type,
        integrationId: form.integrationId || null,
        modelConfig: {
          ...(form.model ? { model: form.model } : isEdit ? { model: null } : {}),
          ...(Object.keys(providerOptions).length > 0 || isEdit ? { providerOptions } : {}),
        },
        maxConcurrent: isNaN(maxConcurrent) ? 1 : maxConcurrent,
        systemPromptId: form.systemPromptId,
        instructionsPromptId: form.instructionsPromptId,
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
          <FieldSelect value={form.integrationId} onChange={setIntegration}>
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

        <Field label="Agent Instructions" required hint="Permanent policy appended to the provider's native agent foundation">
          <FieldSelect value={form.systemPromptId} onChange={set("systemPromptId")}>
            <option value="">— select a prompt —</option>
            {systemPrompts.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </FieldSelect>
        </Field>

        <Field label="Workflow Instructions" required hint="Task-specific guidance included in the generated user request">
          <FieldSelect value={form.instructionsPromptId} onChange={set("instructionsPromptId")}>
            <option value="">— select a prompt —</option>
            {instructionsPrompts.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </FieldSelect>
        </Field>

        <Field label="Feedback Workflow Instructions" hint="Replaces workflow instructions on retry cycles">
          <FieldSelect value={form.feedbackInstructionsPromptId} onChange={set("feedbackInstructionsPromptId")}>
            <option value="">— none —</option>
            {instructionsPrompts.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </FieldSelect>
        </Field>

        {agentConfigFields.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <button
              type="button"
              className="btn sm"
              onClick={() => setShowAdvanced((previous) => !previous)}
              style={{ alignSelf: "flex-start", gap: "6px" }}
            >
              <Icon name="config" size={13} />
              Provider settings
              <Icon name="chevdown" size={12} style={{ transform: showAdvanced ? "rotate(180deg)" : "none" }} />
            </button>
            {showAdvanced && agentConfigFields.map((field) => {
              if (field.dependsOn && form.providerOptions[field.dependsOn.field] !== field.dependsOn.value) return null;
              const value = form.providerOptions[field.key] ?? "";
              return field.type === "select" ? (
                <Field key={field.key} label={field.label} required={field.required} hint={field.description}>
                  <FieldSelect value={value} onChange={(event) => setProviderOption(field.key, event.currentTarget.value)}>
                    {!field.required && <option value="">— provider default —</option>}
                    {field.options?.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </FieldSelect>
                </Field>
              ) : (
                <Field key={field.key} label={field.label} required={field.required} hint={field.description}>
                  <FieldInput
                    type={field.type === "number" ? "number" : "text"}
                    min={field.type === "number" ? 1 : undefined}
                    value={value}
                    placeholder={field.placeholder ?? "Provider default"}
                    onChange={(event) => setProviderOption(field.key, event.currentTarget.value)}
                  />
                </Field>
              );
            })}
          </div>
        )}

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
