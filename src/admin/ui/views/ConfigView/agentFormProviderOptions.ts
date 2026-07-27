import type { PluginField } from "../../types.js";

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