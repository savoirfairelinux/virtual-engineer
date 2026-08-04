/**
 * Shared helper for mapping per-agent `providerOptions.toolAuthorization` onto
 * the env vars the agent worker reads.
 *
 * Storage shape (in `agents.modelConfigJson` → `providerOptions.toolAuthorization`):
 * - Claude/Copilot: `{ blockedTools: string[] }` — newline-separated when
 *   forwarded to the worker. Everything is allowed by default (blocklist-only).
 * - Aider/Goose: provider-specific toggles forwarded as a single
 *   `TOOL_AUTHORIZATION_JSON` env var (parsed by the worker).
 *
 * The host never interprets the Aider/Goose toggles — it only serializes them
 * — so each provider can evolve its own shape without a host change.
 */

/** Extract the `toolAuthorization` sub-object from provider options. */
export function extractToolAuthorization(
  providerOptions: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const raw = providerOptions?.["toolAuthorization"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

/** String-array helper: accept `string[]`, newline-separated `string`, or undefined. */
function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const out = value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
    return out.length > 0 ? out : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const out = value.split("\n").map((v) => v.trim()).filter((v) => v !== "");
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

/**
 * Build the env vars for Claude/Copilot blocked-tool lists.
 * Returns `{ CLAUDE_BLOCKED_TOOLS }` or `{ COPILOT_BLOCKED_TOOLS }` depending
 * on `provider`. Everything is allowed by default; only the blocklist is
 * forwarded.
 */
export function toolListEnv(
  provider: "claude" | "copilot",
  toolAuthorization: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!toolAuthorization) return {};
  const blocked = asStringArray(toolAuthorization["blockedTools"]);
  const prefix = provider === "claude" ? "CLAUDE" : "COPILOT";
  return {
    ...(blocked ? { [`${prefix}_BLOCKED_TOOLS`]: blocked.join("\n") } : {}),
  };
}

/**
 * Build the `TOOL_AUTHORIZATION_JSON` env var for Aider/Goose, carrying the
 * provider-specific toggles verbatim. Returns `{}` when no toggles are set.
 */
export function toolAuthorizationJsonEnv(
  toolAuthorization: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!toolAuthorization) return {};
  return { TOOL_AUTHORIZATION_JSON: JSON.stringify(toolAuthorization) };
}
