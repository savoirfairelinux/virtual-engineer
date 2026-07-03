/**
 * Claude connection validator.
 *
 * Tests a stored Anthropic API key or a Claude subscription OAuth token by
 * calling the Anthropic `/v1/models` endpoint. Mirrors the Copilot validator
 * contract so the plugin descriptor `testConnection` hook stays uniform.
 */
import type { ConnectionTestResult } from "../plugins/pluginManager.js";
import { decryptToken } from "../utils/encryption.js";
import { getLogger } from "../logger.js";

const log = getLogger("claude-connection-validator");

export interface ClaudeConnectionValidationConfig {
  /** "api_key" (Anthropic API key) or "subscription" (Claude Pro/Max OAuth token). */
  authMode?: string | undefined;
  /** Anthropic API key (api_key mode). */
  apiKey?: string | undefined;
  /** Encrypted OAuth token written by the interactive OAuth flow (subscription mode). */
  sessionToken?: string | undefined;
  /** Accepted but ignored — the model lives on the agents table. */
  model?: string | undefined;
}

export interface ClaudeConnectionValidatorDependencies {
  fetch?: typeof globalThis.fetch | undefined;
  adminAuthSecret?: string | undefined;
}

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";
/** Beta header required for subscription OAuth tokens (sk-ant-oat…). */
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";

/** Validate a stored Anthropic API key or Claude subscription OAuth token. */
export async function validateClaudeConnection(
  config: ClaudeConnectionValidationConfig,
  dependencies: ClaudeConnectionValidatorDependencies = {}
): Promise<ConnectionTestResult> {
  const authMode = config.authMode ?? "api_key";
  log.info({ type: "claude", authMode }, "testing Claude connection");

  // ── API key mode ──────────────────────────────────────────────────────────
  if (authMode === "api_key") {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) {
      return {
        success: false,
        error: "No Anthropic API key provided. Paste your key (sk-ant-…) in the API key field.",
        models: [],
      };
    }
    return callAnthropicModelsApi(apiKey, "api_key", dependencies);
  }

  // ── Subscription (OAuth) mode ───────────────────────────────────────────────
  // Uses the encrypted token written by the interactive OAuth flow.
  const encrypted = config.sessionToken?.trim();
  if (encrypted) {
    let token: string;
    try {
      token = decryptToken(encrypted, dependencies.adminAuthSecret);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        models: [],
      };
    }
    return callAnthropicModelsApi(token, "oauth", dependencies);
  }

  return {
    success: false,
    error: "No subscription token configured. Connect via “Connect with Claude” to authenticate.",
    models: [],
  };
}

/** Shared helper: call the Anthropic models API with either an API key or an OAuth bearer token. */
async function callAnthropicModelsApi(
  token: string,
  kind: "api_key" | "oauth",
  dependencies: ClaudeConnectionValidatorDependencies
): Promise<ConnectionTestResult> {
  const fetchFn = dependencies.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = {
    "anthropic-version": ANTHROPIC_VERSION,
    "User-Agent": "virtual-engineer",
    Accept: "application/json",
  };
  if (kind === "api_key") {
    headers["x-api-key"] = token;
  } else {
    headers["Authorization"] = `Bearer ${token}`;
    headers["anthropic-beta"] = ANTHROPIC_OAUTH_BETA;
  }

  try {
    const response = await fetchFn(ANTHROPIC_MODELS_URL, { method: "GET", headers });

    if (response.status === 200) {
      log.info({ success: true, kind }, "Claude credentials are valid");
      return { success: true, error: null, models: [] };
    }

    if (response.status === 401 || response.status === 403) {
      const error = "Claude token is invalid or unauthorized.";
      log.warn({ success: false, status: response.status }, error);
      return { success: false, error, models: [] };
    }

    const error = `Anthropic API returned unexpected status ${response.status}.`;
    log.warn({ success: false, status: response.status }, error);
    return { success: false, error, models: [] };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      models: [],
    };
  }
}
