/**
 * Host-side validation for per-agent tool authorization
 * (`modelConfig.providerOptions.toolAuthorization`).
 *
 * Each provider's toolAuthorization shape is validated, and patterns that would
 * relax VE's network floor are rejected — the floor is immutable and user lists
 * can only tighten it. `allowedTools` is rejected (blocklist-only model).
 *
 * Storage shape (in `agents.modelConfigJson` → `providerOptions.toolAuthorization`):
 * - Claude/Copilot: `{ blockedTools: string[] }` (bare names, `Bash(prefix:*)`,
 *   `mcp__server__tool`). Everything is allowed by default.
 * - Aider: `{ suggestShellCommands, detectUrls, playwright, git }` (booleans).
 *   `autoLint`/`autoTest`/`chatMode` are existing providerOptions, not part of
 *   toolAuthorization.
 * - Goose: `{ developerExtension: boolean }`. `gooseMode` is an existing
 *   providerOption, not part of toolAuthorization.
 */

/** VE's immutable network floor — user `blockedTools` can only add to this,
 * never remove. Mirrors `agent-worker/src/networkGuard.ts`
 * `NETWORK_DISALLOWED_TOOLS`. */
export const NETWORK_FLOOR_TOOLS = new Set([
  "WebFetch",
  "WebSearch",
  "Bash(curl:*)",
  "Bash(wget:*)",
  "Bash(nc:*)",
  "Bash(ncat:*)",
  "Bash(netcat:*)",
  "Bash(telnet:*)",
  "Bash(ssh:*)",
  "Bash(scp:*)",
  "Bash(sftp:*)",
  "Bash(ftp:*)",
  "Bash(lynx:*)",
  "Bash(links:*)",
  "Bash(aria2c:*)",
  "Bash(git push:*)",
  "Bash(git fetch:*)",
  "Bash(git pull:*)",
  "Bash(git clone:*)",
  "Bash(git ls-remote:*)",
  "Bash(git remote-update:*)",
]);

/** Review-floor tools that a review-type agent cannot block (would break review). */
export const REVIEW_FLOOR_TOOLS = new Set(["Read", "Glob", "Grep", "Skill"]);

/** Pattern regex for tool-list entries: bare names, `Bash(prefix:*)`, `mcp__server__tool`. */
const TOOL_PATTERN_RE = /^[A-Za-z0-9_\-]+(?:\([A-Za-z0-9_\-.*: ]*\))?$/;

export class ToolAuthorizationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolAuthorizationConfigError";
  }
}

/** Provider ids that support per-tool allow/block lists (Claude/Copilot). */
const TOOL_LIST_PROVIDERS = new Set(["claude", "copilot"]);

/** Validate the toolAuthorization sub-object for a given provider.
 *
 * Throws {@link ToolAuthorizationConfigError} on invalid input. Returns the
 * (possibly normalized) toolAuthorization object, or `undefined` when absent.
 */
export function validateToolAuthorization(
  provider: string | null | undefined,
  agentType: "coding" | "review",
  toolAuthorization: unknown,
): Record<string, unknown> | undefined {
  if (toolAuthorization === undefined || toolAuthorization === null) return undefined;
  if (typeof toolAuthorization !== "object" || Array.isArray(toolAuthorization)) {
    throw new ToolAuthorizationConfigError("toolAuthorization must be an object");
  }
  const auth = toolAuthorization as Record<string, unknown>;

  if (TOOL_LIST_PROVIDERS.has(provider ?? "")) {
    return validateToolListAuthorization(agentType, auth);
  }
  if (provider === "aider") {
    return validateAiderToolAuthorization(auth);
  }
  if (provider === "goose") {
    return validateGooseToolAuthorization(auth);
  }
  // Unknown / unsupported provider: reject toolAuthorization so users don't
  // silently configure something that has no effect.
  if (provider !== undefined && provider !== null) {
    throw new ToolAuthorizationConfigError(
      `Tool authorization is not supported by provider '${provider}'.`,
    );
  }
  return undefined;
}

function asStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) {
    throw new ToolAuthorizationConfigError(`toolAuthorization.${key} must be an array of strings`);
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new ToolAuthorizationConfigError(`toolAuthorization.${key} entries must be non-empty strings`);
    }
    const trimmed = entry.trim();
    if (!TOOL_PATTERN_RE.test(trimmed)) {
      throw new ToolAuthorizationConfigError(
        `toolAuthorization.${key} entry '${trimmed}' is not a valid tool pattern (allowed: bare names, Bash(prefix:*), mcp__server__tool)`,
      );
    }
    out.push(trimmed);
  }
  if (out.length > 100) {
    throw new ToolAuthorizationConfigError(`toolAuthorization.${key} may contain at most 100 entries`);
  }
  return out;
}

function validateToolListAuthorization(
  agentType: "coding" | "review",
  auth: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if ("allowedTools" in auth) {
    throw new ToolAuthorizationConfigError(
      "toolAuthorization.allowedTools is not supported — everything is allowed by default; use blockedTools to restrict.",
    );
  }
  if ("blockedTools" in auth) {
    result["blockedTools"] = asStringArray(auth["blockedTools"], "blockedTools");
  }
  rejectUnknownKeys(auth, ["blockedTools"], "claude/copilot");
  // Review-type agents cannot block review-floor tools (would break review).
  // This includes the VE submission MCP tool, which the review agent must be
  // able to call to submit its verdict. The submission server may be named
  // either `ve-submission` or `virtual-engineer-submission`.
  if (agentType === "review") {
    const blocked = (result["blockedTools"] as string[] | undefined) ?? [];
    for (const tool of blocked) {
      const bareName = tool.includes("(") ? tool.slice(0, tool.indexOf("(")) : tool;
      if (REVIEW_FLOOR_TOOLS.has(bareName)) {
        throw new ToolAuthorizationConfigError(
          `toolAuthorization.blockedTools cannot include '${tool}' for a review agent — it is required for review.`,
        );
      }
      if (
        tool.startsWith("mcp__ve-submission__") ||
        tool.startsWith("mcp__virtual-engineer-submission__")
      ) {
        throw new ToolAuthorizationConfigError(
          `toolAuthorization.blockedTools cannot include '${tool}' for a review agent — the VE submission tool is required to submit the review verdict.`,
        );
      }
    }
  }
  return result;
}

function asBoolean(value: unknown, key: string): boolean {
  if (typeof value !== "boolean") {
    throw new ToolAuthorizationConfigError(`toolAuthorization.${key} must be a boolean`);
  }
  return value;
}

function validateAiderToolAuthorization(auth: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  // autoLint/autoTest/chatMode are existing providerOptions (forwarded as
  // AIDER_AUTO_LINT / AIDER_AUTO_TEST / AIDER_CHAT_MODE env vars), not part
  // of toolAuthorization. Only the capability toggles below belong here.
  const knownBooleans = ["suggestShellCommands", "detectUrls", "playwright", "git"];
  for (const key of knownBooleans) {
    if (key in auth) result[key] = asBoolean(auth[key], key);
  }
  rejectUnknownKeys(auth, knownBooleans, "aider");
  return result;
}

function validateGooseToolAuthorization(auth: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  // gooseMode is an existing providerOption (forwarded as GOOSE_MODE env var),
  // not part of toolAuthorization. Only developerExtension belongs here.
  if ("developerExtension" in auth) {
    result["developerExtension"] = asBoolean(auth["developerExtension"], "developerExtension");
  }
  rejectUnknownKeys(auth, ["developerExtension"], "goose");
  return result;
}

function rejectUnknownKeys(auth: Record<string, unknown>, allowed: string[], provider: string): void {
  for (const key of Object.keys(auth)) {
    if (!allowed.includes(key)) {
      throw new ToolAuthorizationConfigError(
        `toolAuthorization.${key} is not supported by the '${provider}' provider`,
      );
    }
  }
}

/** Normalize the `providerOptions.toolAuthorization` inside a modelConfig.
 *
 * Mutates `modelConfig.providerOptions` in place: validates toolAuthorization
 * for the agent's provider and replaces it with the normalized result. Throws
 * {@link ToolAuthorizationConfigError} on invalid input.
 */
export function normalizeModelConfigToolAuthorization(
  provider: string | null | undefined,
  agentType: "coding" | "review",
  modelConfig: Record<string, unknown>,
): void {
  const providerOptions = modelConfig["providerOptions"];
  if (providerOptions === undefined || providerOptions === null) return;
  if (typeof providerOptions !== "object" || Array.isArray(providerOptions)) return;
  const opts = providerOptions as Record<string, unknown>;
  if (!("toolAuthorization" in opts)) return;
  const normalized = validateToolAuthorization(provider, agentType, opts["toolAuthorization"]);
  if (normalized === undefined) {
    delete opts["toolAuthorization"];
  } else {
    opts["toolAuthorization"] = normalized;
  }
}
