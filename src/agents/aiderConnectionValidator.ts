/**
 * Aider connection validator.
 *
 * Tests a configured Aider integration by probing the upstream LLM provider's
 * models endpoint (or Ollama's `/api/tags`). Aider itself wraps any litellm
 * backend, so the "connection" is really the upstream provider's credentials.
 *
 * Mirrors the Claude validator contract so the plugin descriptor `testConnection`
 * hook stays uniform. API keys are stored plaintext at rest (like the Claude
 * `api_key` mode); there is no encrypted token to decrypt for Aider.
 */
import type { ConnectionTestResult } from "../plugins/pluginManager.js";
import { getLogger } from "../logger.js";

const log = getLogger("aider-connection-validator");

export interface AiderConnectionValidationConfig {
  /** Backend selector: openai | anthropic | ollama | openrouter | deepseek | openai_compat. */
  aiderBackend?: string | undefined;
  /** API key for the selected backend (ollama usually needs none). */
  aiderApiKey?: string | undefined;
  /** Custom API base URL (required for openai_compat; optional override for ollama). */
  aiderApiBase?: string | undefined;
  /** Accepted but ignored — the model lives on the agents table. */
  model?: string | undefined;
}

export interface AiderConnectionValidatorDependencies {
  fetch?: typeof globalThis.fetch | undefined;
}

const DEFAULT_OLLAMA_BASE = "http://127.0.0.1:11434";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";

/** Validate a configured Aider integration by probing the upstream provider. */
export async function validateAiderConnection(
  config: AiderConnectionValidationConfig,
  dependencies: AiderConnectionValidatorDependencies = {}
): Promise<ConnectionTestResult> {
  const backend = config.aiderBackend ?? "openai";
  const apiKey = config.aiderApiKey?.trim() ?? "";
  const apiBase = config.aiderApiBase?.trim() ?? "";
  log.info({ backend }, "testing Aider connection");

  const fetchFn = dependencies.fetch ?? globalThis.fetch;

  try {
    let response: Response;
    switch (backend) {
      case "openai":
        if (!apiKey) return missingKey();
        response = await fetchFn("https://api.openai.com/v1/models", bearerGet(apiKey));
        break;
      case "anthropic":
        if (!apiKey) return missingKey();
        response = await fetchFn(
          ANTHROPIC_MODELS_URL,
          anthropicGet(apiKey)
        );
        break;
      case "ollama":
        response = await fetchFn(
          `${(apiBase || DEFAULT_OLLAMA_BASE).replace(/\/+$/, "")}/api/tags`,
          { method: "GET", headers: { Accept: "application/json", "User-Agent": "virtual-engineer" } }
        );
        break;
      case "openrouter":
        if (!apiKey) return missingKey();
        response = await fetchFn("https://openrouter.ai/api/v1/models", bearerGet(apiKey));
        break;
      case "deepseek":
        if (!apiKey) return missingKey();
        response = await fetchFn("https://api.deepseek.com/models", bearerGet(apiKey));
        break;
      case "openai_compat": {
        if (!apiBase) {
          return {
            success: false,
            error: "No API base URL configured for the openai-compatible backend.",
            models: [],
          };
        }
        if (!apiKey) return missingKey();
        response = await fetchFn(
          `${apiBase.replace(/\/+$/, "")}/v1/models`,
          bearerGet(apiKey)
        );
        break;
      }
      default:
        return {
          success: false,
          error: `Unknown Aider backend "${backend}".`,
          models: [],
        };
    }

    if (response.status === 200) {
      log.info({ backend }, "Aider connection is valid");
      return { success: true, error: null, models: [] };
    }
    if (response.status === 401 || response.status === 403) {
      const error = `Aider backend "${backend}" credentials are invalid or unauthorized.`;
      log.warn({ backend, status: response.status }, error);
      return { success: false, error, models: [] };
    }
    const error = `Aider backend "${backend}" returned unexpected status ${response.status}.`;
    log.warn({ backend, status: response.status }, error);
    return { success: false, error, models: [] };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      models: [],
    };
  }
}

function missingKey(): ConnectionTestResult {
  return {
    success: false,
    error: "No API key provided for the selected Aider backend.",
    models: [],
  };
}

function bearerGet(apiKey: string): RequestInit {
  return {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "User-Agent": "virtual-engineer",
    },
  };
}

function anthropicGet(apiKey: string): RequestInit {
  return {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      Accept: "application/json",
      "User-Agent": "virtual-engineer",
    },
  };
}