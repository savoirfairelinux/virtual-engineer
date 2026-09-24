import { useState, useEffect, useRef } from "react";
import { Modal, Field, FieldInput, FieldSelect, FormError, FormRow, FormActions } from "../../components/Modal.tsx";
import { Icon } from "../../components/Icon.tsx";
import { api } from "../../api.ts";
import { promptLabel } from "./promptLabel.ts";
import type { ApiAgent, ApiIntegration, ApiPlugin, ApiPrompt, ReviewStrategy } from "../../types.ts";
import {
  loadToolAuthorization,
  serializeToolAuthorization,
  supportsToolAuthorization,
  type ToolAuthorizationState,
} from "./toolAuthorizationHelpers.ts";
import { ToolAuthorizationSection } from "./ToolAuthorizationSection.tsx";
import {
  buildAgentModelConfig,
  normalizeAgentReviewForm,
  serializeProviderOptions,
} from "./agentFormProviderOptions.ts";

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
  reviewStrategy: ReviewStrategy;
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

export function AgentFormModal({ agent, integrations, plugins, prompts, onClose, onSaved }: Props) {
  const isEdit = !!agent;
  const systemPrompts = prompts.filter((prompt) => prompt.promptType === "system");
  const instructionsPrompts = prompts.filter((prompt) => prompt.promptType === "instructions");
  const agentIntegrations = integrations.filter((i) => i.domainCapabilities.includes("agent_execution") && i.enabled);

  const [form, setForm] = useState<AgentForm>({
    name: agent?.name ?? "",
    type: agent?.type ?? "coding",
    reviewStrategy: agent?.reviewStrategy ?? "ve_direct",
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
  const [modelsError, setModelsError] = useState<string | null>(null);
  const modelsRequestId = useRef(0);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [toolAuth, setToolAuth] = useState<ToolAuthorizationState>(() =>
    loadToolAuthorization(
      (agent?.modelConfig?.["providerOptions"] as Record<string, unknown> | undefined)?.["toolAuthorization"],
      agent?.integrationId
        ? integrations.find((i) => i.id === agent.integrationId)?.provider
        : undefined,
    ),
  );
  const selectedIntegration = agentIntegrations.find((integration) => integration.id === form.integrationId);
  const selectedPlugin = plugins.find((plugin) => plugin.provider === selectedIntegration?.provider);
  const supportedReasoningEfforts = availableModels.find((model) => model.id === form.model)?.supportedReasoningEfforts ?? [];
  const agentConfigFields = (selectedPlugin?.agentConfigFields ?? []).map((field) =>
    selectedIntegration?.provider === "copilot" && field.key === "reasoningEffort"
      ? { ...field, options: (field.options ?? []).filter((option) => supportedReasoningEfforts.includes(option.value)) }
      : field
  );
  const reviewStrategies = form.type === "review" ? selectedPlugin?.reviewStrategies ?? [] : [];
  const nativeReview = form.reviewStrategy === "copilot_native";

  // Rehydrate toolAuth when the selected integration's provider changes, so
  // switching integration resets the tool-authorization form for the new
  // provider instead of serializing the wrong shape.
  const selectedProvider = selectedIntegration?.provider;
  const initialProvider = agent?.integrationId
    ? integrations.find((i) => i.id === agent.integrationId)?.provider
    : undefined;
  useEffect(() => {
    if (selectedProvider === initialProvider) return;
    setToolAuth(loadToolAuthorization(undefined, selectedProvider));
  }, [selectedProvider, initialProvider]);

  const discoverModels = async (integrationId: string): Promise<void> => {
    const requestId = ++modelsRequestId.current;
    setModelsLoading(true);
    setModelsError(null);
    try {
      await api.post(`/api/admin/integrations/${integrationId}/models/discover`, {});
      const response = await api.get<{ models: AvailableModel[] }>(`/api/admin/integrations/${integrationId}/models`);
      if (requestId !== modelsRequestId.current) return;
      const models = Array.isArray(response.models)
        ? response.models.map((model) => typeof model === "string" ? { id: model, name: model } : model)
        : [];
      setAvailableModels(models);
      setForm((previous) => previous.integrationId !== integrationId || !previous.model
        || models.some((model) => model.id === previous.model)
        ? previous
        : { ...previous, model: "" });
    } catch (error: unknown) {
      if (requestId !== modelsRequestId.current) return;
      setModelsError(error instanceof Error ? error.message : "Model discovery failed");
    } finally {
      if (requestId === modelsRequestId.current) setModelsLoading(false);
    }
  };

  // Fetch available models whenever the selected integration changes
  useEffect(() => {
    const integrationId = form.integrationId;
    if (!integrationId || nativeReview) {
      modelsRequestId.current += 1;
      setAvailableModels([]);
      setModelsLoading(false);
      setModelsError(null);
      return;
    }

    // Fast path: models already embedded in the loaded integration list
    const integration = agentIntegrations.find((i) => i.id === integrationId);
    const cached = integration?.discoveredResources?.models;
    if (Array.isArray(cached) && cached.length > 0) {
      modelsRequestId.current += 1;
      setAvailableModels(cached.map((model) => typeof model === "string" ? { id: model, name: model } : model));
      setModelsLoading(false);
      setModelsError(null);
      return;
    }

    void discoverModels(integrationId);
    return () => { modelsRequestId.current += 1; };
  }, [form.integrationId, nativeReview]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: keyof AgentForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = e.target.value;
    setForm((prev) => {
      const providerOptions = { ...prev.providerOptions };
      if (k === "model" && selectedProvider === "copilot") {
        const efforts = availableModels.find((model) => model.id === value)?.supportedReasoningEfforts ?? [];
        if (!efforts.includes(providerOptions["reasoningEffort"] ?? "")) {
          delete providerOptions["reasoningEffort"];
        }
      }
      return { ...prev, [k]: value, providerOptions };
    });
  };

  const setIntegration = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const integrationId = event.target.value;
    const integration = agentIntegrations.find((candidate) => candidate.id === integrationId);
    const plugin = plugins.find((candidate) => candidate.provider === integration?.provider);
    modelsRequestId.current += 1;
    setAvailableModels([]);
    setModelsLoading(false);
    setModelsError(null);
    setForm((prev) => normalizeAgentReviewForm({
      ...prev,
      integrationId,
      model: "",
      providerOptions: {},
    }, plugin));
  };

  const setType = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setForm((prev) => normalizeAgentReviewForm({
      ...prev,
      type: event.target.value as AgentForm["type"],
    }, selectedPlugin));
  };

  const setReviewStrategy = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setForm((prev) => normalizeAgentReviewForm({
      ...prev,
      reviewStrategy: event.target.value as ReviewStrategy,
    }, selectedPlugin));
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
    if (!form.systemPromptId) { setError("Select a System Prompt"); return; }
    if (!form.instructionsPromptId) { setError("Select an Instructions Prompt"); return; }
    setSaving(true);
    setError(null);
    try {
      const maxConcurrent = parseInt(form.maxConcurrent, 10);
      const rawExistingOptions = agent?.modelConfig?.["providerOptions"];
      const existingProviderOptions = agent?.integrationId === form.integrationId
        && typeof rawExistingOptions === "object"
        && rawExistingOptions !== null
        && !Array.isArray(rawExistingOptions)
        ? rawExistingOptions as Record<string, unknown>
        : {};
      const providerOptions = serializeProviderOptions(
        agentConfigFields,
        form.providerOptions,
        existingProviderOptions,
      );
      if (selectedProvider === "copilot"
        && !supportedReasoningEfforts.includes(String(providerOptions["reasoningEffort"] ?? ""))) {
        delete providerOptions["reasoningEffort"];
      }
      const toolAuthorization = serializeToolAuthorization(toolAuth, selectedIntegration?.provider);
      if (toolAuthorization !== undefined) {
        providerOptions["toolAuthorization"] = toolAuthorization;
      } else {
        delete providerOptions["toolAuthorization"];
      }
      const normalizedForm = normalizeAgentReviewForm(form, selectedPlugin);
      const payload = {
        name: normalizedForm.name,
        type: normalizedForm.type,
        integrationId: normalizedForm.integrationId || null,
        modelConfig: buildAgentModelConfig({
          reviewStrategy: normalizedForm.reviewStrategy,
          model: normalizedForm.model,
          providerOptions,
          isEdit,
        }),
        maxConcurrent: isNaN(maxConcurrent) ? 1 : maxConcurrent,
        systemPromptId: normalizedForm.systemPromptId,
        instructionsPromptId: normalizedForm.instructionsPromptId,
        feedbackInstructionsPromptId: normalizedForm.feedbackInstructionsPromptId || null,
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
        <div data-tour="agent-form-basics" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <Field label="Name" required>
            <FieldInput value={form.name} placeholder="My coding agent" onChange={set("name")} />
          </Field>

          <Field label="Type" required>
            <FieldSelect value={form.type} onChange={setType}>
              <option value="coding">Coding</option>
              <option value="review">Review</option>
            </FieldSelect>
          </Field>

          {reviewStrategies.length > 0 && (
            <Field label="Review strategy" required hint="Choose how this provider performs code review">
              <FieldSelect value={form.reviewStrategy} onChange={setReviewStrategy}>
                <option value="ve_direct">VE direct</option>
                {reviewStrategies.map((strategy) => (
                  <option key={strategy.id} value={strategy.id}>
                    {strategy.label}{strategy.experimental ? " (experimental)" : ""}
                  </option>
                ))}
              </FieldSelect>
            </Field>
          )}
        </div>

        <Field label="Agent Integration" required hint="An enabled agent-execution integration (e.g. Copilot, Claude, Aider)">
          <FieldSelect data-tour="agent-form-integration" value={form.integrationId} onChange={setIntegration}>
            {agentIntegrations.length === 0 && <option value="">— no agent integrations —</option>}
            {agentIntegrations.map((i) => (
              <option key={i.id} value={i.id}>{i.name} ({i.provider})</option>
            ))}
          </FieldSelect>
        </Field>

        {!nativeReview && <Field
          label="Model"
          hint={availableModels.length > 0 ? "Select a model or leave on default" : "Leave blank to use default (auto)"}
          labelAction={selectedIntegration?.provider === "copilot" && (
            <button
              type="button"
              className="iconbtn"
              aria-label="Refresh models"
              title="Refresh models"
              disabled={modelsLoading}
              onClick={() => { void discoverModels(form.integrationId); }}
            >
              <Icon name="refresh" size={14} {...(modelsLoading ? { className: "spin" } : {})} />
            </button>
          )}
        >
          {availableModels.length > 0 ? (
            <FieldSelect data-tour="agent-form-model" value={form.model} onChange={set("model") as React.ChangeEventHandler<HTMLSelectElement>} disabled={modelsLoading}>
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
            <FieldInput data-tour="agent-form-model" value={form.model} placeholder={modelsLoading ? "Loading models…" : "auto"} onChange={set("model")} disabled={modelsLoading} />
          )}
        </Field>}
        {!nativeReview && modelsError && <FormError msg={modelsError} />}

        <Field label="Max Concurrent" hint="Maximum simultaneous agent cycles (≥1)">
          <FieldInput data-tour="agent-form-concurrency" type="number" min={1} value={form.maxConcurrent} onChange={set("maxConcurrent")} />
        </Field>

        <div data-tour="agent-form-prompts" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <Field label="System Prompt" required hint="Permanent policy appended to the provider's native agent foundation">
            <FieldSelect value={form.systemPromptId} onChange={set("systemPromptId")} disabled={nativeReview}>
              <option value="">— select a prompt —</option>
              {systemPrompts.map((p) => (
                <option key={p.id} value={p.id}>{promptLabel(p, prompts)}</option>
              ))}
            </FieldSelect>
          </Field>

          <Field label="Instructions Prompt" required hint="Task-specific guidance included in the generated user request">
            <FieldSelect value={form.instructionsPromptId} onChange={set("instructionsPromptId")}>
              <option value="">— select a prompt —</option>
              {instructionsPrompts.map((p) => (
                <option key={p.id} value={p.id}>{promptLabel(p, prompts)}</option>
              ))}
            </FieldSelect>
          </Field>

          {(form.type === "coding" || form.feedbackInstructionsPromptId) && !nativeReview && <Field label="Feedback Instructions Prompt" hint="Replaces the Instructions Prompt on retry cycles">
            <FieldSelect value={form.feedbackInstructionsPromptId} onChange={set("feedbackInstructionsPromptId")}>
              <option value="">— none —</option>
              {instructionsPrompts.map((p) => (
                <option key={p.id} value={p.id}>{promptLabel(p, prompts)}</option>
              ))}
            </FieldSelect>
          </Field>}
        </div>

        {agentConfigFields.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <button
              type="button"
              className="btn sm"
              data-tour="agent-form-provider-settings-toggle"
              onClick={() => setShowAdvanced((previous) => !previous)}
              style={{ alignSelf: "flex-start", gap: "6px" }}
            >
              <Icon name="config" size={13} />
              Provider settings
              <Icon name="chevdown" size={12} style={{ transform: showAdvanced ? "rotate(180deg)" : "none" }} />
            </button>
            {showAdvanced && (
              <div data-tour="agent-form-provider-settings" style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                {agentConfigFields.map((field) => {
                  if (nativeReview && field.key === "reasoningEffort") return null;
                  if (field.dependsOn && form.providerOptions[field.dependsOn.field] !== field.dependsOn.value) return null;
                  const rawValue = form.providerOptions[field.key] ?? "";
                  const value = selectedProvider === "copilot" && field.key === "reasoningEffort"
                    && !supportedReasoningEfforts.includes(rawValue) ? "" : rawValue;
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
          </div>
        )}

        {supportsToolAuthorization(selectedIntegration?.provider) && (
          <div data-tour="agent-form-tool-authorization">
            <ToolAuthorizationSection
              state={toolAuth}
              onChange={setToolAuth}
              provider={selectedIntegration?.provider}
              plugin={selectedPlugin}
            />
          </div>
        )}

        <FormError msg={error} />

        <FormActions>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" data-tour="agent-form-actions" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create agent"}
          </button>
        </FormActions>
      </FormRow>
    </Modal>
  );
}
