/**
 * OpenCode connection validator.
 *
 * Tests a configured OpenCode integration by probing the upstream LLM
 * provider's models endpoint (or Ollama's `/api/tags`). OpenCode itself wraps
 * any LLM provider (https://opencode.ai), so the "connection" is really the
 * upstream provider's credentials.
 *
 * Mirrors the Goose validator contract so the plugin descriptor
 * `testConnection` hook stays uniform. API keys are stored plaintext at rest
 * (like the Aider/Goose backends); there is no encrypted token to decrypt for
 * OpenCode.
 */
import type { ConnectionTestResult } from "../plugins/pluginManager.js";
import { getLogger } from "../logger.js";

const log = getLogger("opencode-connection-validator");

export interface OpenCodeConnectionValidationConfig {
  /** Provider selector: anthropic | openai | openrouter | ollama | deepseek | groq | gemini | azure_openai | bedrock | perplexity | mistral | xai | cerebras | openai_compat. */
  openCodeProvider?: string | undefined;
  /** API key for the selected provider (ollama/bedrock usually need none). */
  openCodeApiKey?: string | undefined;
  /** Custom API base URL (required for openai_compat; optional override for ollama). */
  openCodeApiBase?: string | undefined;
  /** Accepted but ignored — the model lives on the agents table. */
  model?: string | undefined;
}

export interface OpenCodeConnectionValidatorDependencies {
  fetch?: typeof globalThis.fetch | undefined;
}

const DEFAULT_OLLAMA_BASE = "http://127.0.0.1:11434";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";

/** Validate a configured OpenCode integration by probing the upstream provider. */
export async function validateOpenCodeConnection(
  config: OpenCodeConnectionValidationConfig,
  dependencies: OpenCodeConnectionValidatorDependencies = {}
): Promise<ConnectionTestResult> {
  const provider = config.openCodeProvider ?? "anthropic";
  const apiKey = config.openCodeApiKey?.trim() ?? "";
  const apiBase = config.openCodeApiBase?.trim() ?? "";
  log.info({ provider }, "testing OpenCode connection");

  const fetchFn = dependencies.fetch ?? globalThis.fetch;

  try {
    let response: Response;
    switch (provider) {
      case "anthropic":
        if (!apiKey) return missingKey();
        response = await fetchFn(ANTHROPIC_MODELS_URL, anthropicGet(apiKey));
        break;
      case "openai":
        if (!apiKey) return missingKey();
        response = await fetchFn("https://api.openai.com/v1/models", bearerGet(apiKey));
        break;
      case "openrouter":
        if (!apiKey) return missingKey();
        response = await fetchFn("https://openrouter.ai/api/v1/models", bearerGet(apiKey));
        break;
      case "ollama":
        response = await fetchFn(
          `${(apiBase || DEFAULT_OLLAMA_BASE).replace(/\/+$/, "")}/api/tags`,
          { method: "GET", headers: { Accept: "application/json", "User-Agent": "virtual-engineer" } }
        );
        break;
      case "deepseek":
        if (!apiKey) return missingKey();
        response = await fetchFn("https://api.deepseek.com/models", bearerGet(apiKey));
        break;
      case "groq":
        if (!apiKey) return missingKey();
        response = await fetchFn("https://api.groq.com/openai/v1/models", bearerGet(apiKey));
        break;
      case "gemini":
        if (!apiKey) return missingKey();
        response = await fetchFn(
          `https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(apiKey)}`,
          { method: "GET", headers: { Accept: "application/json", "User-Agent": "virtual-engineer" } }
        );
        break;
      case "azure_openai": {
        if (!apiKey) return missingKey();
        if (!apiBase) {
          return {
            success: false,
            error: "No Azure OpenAI endpoint configured for the OpenCode provider.",
            models: [],
          };
        }
        response = await fetchFn(
          `${apiBase.replace(/\/+$/, "")}/openai/models?api-version=2024-10-21`,
          { method: "GET", headers: { "api-key": apiKey, Accept: "application/json", "User-Agent": "virtual-engineer" } }
        );
        break;
      }
      case "bedrock":
        // Bedrock uses AWS credential chains configured in the environment; VE
        // cannot probe it with a single API key. Validate that the operator has
        // set the AWS env vars on the host before the agent runs.
        if (!process.env["AWS_ACCESS_KEY_ID"] && !process.env["AWS_PROFILE"] && !process.env["AWS_BEARER_TOKEN_BEDROCK"]) {
          return {
            success: false,
            error:
              "Bedrock requires AWS credentials in the environment (AWS_PROFILE, AWS_ACCESS_KEY_ID, or AWS_BEARER_TOKEN_BEDROCK). Configure them on the host before running the agent.",
            models: [],
          };
        }
        return {
          success: true,
          error: null,
          models: [],
          logs: ["AWS credentials detected in the environment."],
        };
      case "perplexity":
        if (!apiKey) return missingKey();
        response = await fetchFn("https://api.perplexity.ai/models", bearerGet(apiKey));
        break;
      case "mistral":
        if (!apiKey) return missingKey();
        response = await fetchFn("https://api.mistral.ai/v1/models", bearerGet(apiKey));
        break;
      case "xai":
        if (!apiKey) return missingKey();
        response = await fetchFn("https://api.x.ai/v1/models", bearerGet(apiKey));
        break;
      case "cerebras":
        if (!apiKey) return missingKey();
        response = await fetchFn("https://api.cerebras.ai/v1/models", bearerGet(apiKey));
        break;
      case "openai_compat": {
        if (!apiBase) {
          return {
            success: false,
            error: "No API base URL configured for the openai-compatible OpenCode provider.",
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
          error: `Unknown OpenCode provider "${provider}".`,
          models: [],
        };
    }

    if (response.status === 200) {
      log.info({ provider }, "OpenCode connection is valid");
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      const rawModels = provider === "ollama" ? body["models"] : body["data"];
      const modelCount = Array.isArray(rawModels) ? rawModels.length : undefined;
      const logs: string[] = [`Connected to ${provider} provider.`];
      if (modelCount !== undefined) logs.push(`Found ${modelCount} available model(s).`);
      return { success: true, error: null, models: [], logs };
    }
    if (response.status === 401 || response.status === 403) {
      const error = `OpenCode provider "${provider}" credentials are invalid or unauthorized.`;
      log.warn({ provider, status: response.status }, error);
      return { success: false, error, models: [] };
    }
    const error = `OpenCode provider "${provider}" returned unexpected status ${response.status}.`;
    log.warn({ provider, status: response.status }, error);
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
    error: "No API key provided for the selected OpenCode provider.",
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
