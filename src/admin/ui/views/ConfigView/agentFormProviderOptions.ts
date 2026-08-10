import type { ApiPlugin, PluginField, ReviewStrategy } from "../../types.js";

export interface ReviewFormFields {
  type: "coding" | "review";
  reviewStrategy: ReviewStrategy;
  model: string;
  systemPromptId: string;
  feedbackInstructionsPromptId: string;
  providerOptions: Record<string, string>;
}

export function normalizeAgentReviewForm<T extends ReviewFormFields>(
  form: T,
  plugin: ApiPlugin | undefined,
): T {
  const descriptor = form.type === "review"
    ? plugin?.reviewStrategies?.find(({ id }) => id === form.reviewStrategy)
    : undefined;
  if (!descriptor) {
    return form.reviewStrategy === "ve_direct" ? form : { ...form, reviewStrategy: "ve_direct" };
  }

  const providerOptions = { ...form.providerOptions };
  delete providerOptions["reasoningEffort"];
  return {
    ...form,
    model: "",
    systemPromptId: descriptor.requiredSystemPromptId,
    feedbackInstructionsPromptId: "",
    providerOptions,
  };
}

export function buildAgentModelConfig(input: {
  reviewStrategy: ReviewStrategy;
  model: string;
  providerOptions: Record<string, unknown>;
  isEdit: boolean;
}): Record<string, unknown> {
  const providerOptions = { ...input.providerOptions };
  if (input.reviewStrategy === "copilot_native") {
    providerOptions["reviewStrategy"] = input.reviewStrategy;
    delete providerOptions["reasoningEffort"];
    return { providerOptions };
  }

  delete providerOptions["reviewStrategy"];
  return {
    ...(input.model ? { model: input.model } : input.isEdit ? { model: null } : {}),
    ...(Object.keys(providerOptions).length > 0 || input.isEdit ? { providerOptions } : {}),
  };
}

export function serializeProviderOptions(
  fields: PluginField[],
  values: Record<string, string>,
  existingOptions: Record<string, unknown> = {},
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...existingOptions };
  for (const field of fields) {
    delete result[field.key];
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