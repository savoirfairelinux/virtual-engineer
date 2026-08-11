export interface LogPayloadEntry {
  message?: string | undefined;
  data?: unknown;
}

function compactJsonString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.stringify(JSON.parse(trimmed) as unknown);
  } catch {
    return value;
  }
}

export function renderPayload(entry: LogPayloadEntry): string {
  if (typeof entry.message === "string" && entry.message.trim().length > 0) {
    return compactJsonString(entry.message);
  }
  if (entry.data === null || entry.data === undefined) return "";
  if (typeof entry.data === "string") return compactJsonString(entry.data);
  if (typeof entry.data === "number" || typeof entry.data === "boolean") return String(entry.data);
  try {
    return JSON.stringify(entry.data);
  } catch {
    return String(entry.data);
  }
}