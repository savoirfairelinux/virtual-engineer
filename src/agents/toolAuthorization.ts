/**
 * Shared helper for mapping per-agent `providerOptions.toolAuthorization` onto
 * the env vars the agent worker reads.
 *
 * Storage shape (in `agents.modelConfigJson` → `providerOptions.toolAuthorization`):
 * - Claude/Copilot: `{ blockedTools: string[] }` — comma-separated when
 *   forwarded to the worker. Everything is allowed by default (blocklist-only).
 * - Aider/Goose: provider-specific toggles forwarded as a single
 *   `TOOL_AUTHORIZATION_JSON` env var (parsed by the worker).
 *
 * The host validates the Aider/Goose toggle shapes (toolAuthorizationValidation.ts)
 * but forwards the toggles verbatim to the worker as TOOL_AUTHORIZATION_JSON —
 * each provider interprets its own values, so the host doesn't transform them.
 */

/** Extract the `toolAuthorization` sub-object from provider options. */
export function extractToolAuthorization(
  providerOptions: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const raw = providerOptions?.["toolAuthorization"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

/** String-array helper: accept `string[]`, newline/comma-separated `string`, or undefined. */
function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const out = value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
    return out.length > 0 ? out : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const out = value.split(/[\r\n,]/u).map((v) => v.trim()).filter((v) => v !== "");
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
  // Comma, not newline: OpenShell rejects CR/LF in sandbox env values.
  return {
    ...(blocked ? { [`${prefix}_BLOCKED_TOOLS`]: blocked.join(",") } : {}),
  };
}

/**
 * Build the `TOOL_AUTHORIZATION_JSON` env var for Aider/Goose, carrying the
 * provider-specific toggles verbatim. Returns `{}` when no toggles are set
 * (empty object or undefined).
 */
export function toolAuthorizationJsonEnv(
  toolAuthorization: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!toolAuthorization) return {};
  if (Object.keys(toolAuthorization).length === 0) return {};
  return { TOOL_AUTHORIZATION_JSON: JSON.stringify(toolAuthorization) };
}
