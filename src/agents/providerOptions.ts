export function resolveProviderOptions(extra: Record<string, unknown>): Record<string, unknown> {
  const value = extra["providerOptions"];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}