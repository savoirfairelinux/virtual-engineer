/**
 * Gemini CLI connection validator.
 *
 * Both auth modes (`api_key` and `vertex_ai`) authenticate with an API key —
 * Vertex AI "Express Mode" accepts the same Gemini Developer API key shape —
 * so a single probe against the Gemini Developer API's `/v1beta/models`
 * endpoint covers both. True enterprise Vertex AI (service-account/ADC auth)
 * is out of scope; the `vertex_ai` mode here targets Express Mode only.
 */
import type { ConnectionTestResult } from "../plugins/pluginManager.js";
import { getLogger } from "../logger.js";
import { buildGeminiModelsRequest } from "./geminiApi.js";

const log = getLogger("gemini-connection-validator");

export interface GeminiConnectionValidationConfig {
  /** "api_key" (Gemini Developer API key) or "vertex_ai" (Vertex AI Express Mode). */
  authMode?: string | undefined;
  /** Gemini Developer API key or Vertex AI Express Mode key. */
  apiKey?: string | undefined;
  /** Optional Google Cloud project id (vertex_ai mode). */
  googleCloudProject?: string | undefined;
  /** Optional Google Cloud location/region (vertex_ai mode). */
  googleCloudLocation?: string | undefined;
  /** Accepted but ignored — the model lives on the agents table. */
  model?: string | undefined;
}

export interface GeminiConnectionValidatorDependencies {
  fetch?: typeof globalThis.fetch | undefined;
}

/** Validate a stored Gemini API key (api_key or vertex_ai Express Mode). */
export async function validateGeminiConnection(
  config: GeminiConnectionValidationConfig,
  dependencies: GeminiConnectionValidatorDependencies = {}
): Promise<ConnectionTestResult> {
  const authMode = config.authMode ?? "api_key";
  log.info({ type: "gemini", authMode }, "testing Gemini connection");

  const apiKey = config.apiKey?.trim();
  if (!apiKey) {
    return {
      success: false,
      error:
        authMode === "vertex_ai"
          ? "No Vertex AI Express Mode API key provided."
          : "No Gemini API key provided. Paste your key from https://aistudio.google.com/apikey.",
      models: [],
    };
  }
  return callGeminiModelsApi({ ...config, authMode, apiKey }, dependencies);
}

async function callGeminiModelsApi(
  config: GeminiConnectionValidationConfig & { apiKey: string },
  dependencies: GeminiConnectionValidatorDependencies
): Promise<ConnectionTestResult> {
  const fetchFn = dependencies.fetch ?? globalThis.fetch;
  const request = buildGeminiModelsRequest(config);

  try {
    const response = await fetchFn(request.url, {
      method: "GET",
      headers: request.headers,
    });

    if (response.status === 200) {
      log.info({ success: true }, "Gemini credentials are valid");
      const body = (await response.json().catch(() => ({}))) as {
        models?: Array<{ name?: string }>;
        publisherModels?: Array<{ name?: string }>;
      };
      const rawModels = body.publisherModels ?? body.models;
      const modelIds = Array.isArray(rawModels)
        ? rawModels.map((model) => model.name).filter((id): id is string => typeof id === "string")
        : [];
      const logs: string[] = ["Authentication successful."];
      if (modelIds.length > 0) logs.push(`Available models: ${modelIds.join(", ")}.`);
      return { success: true, error: null, models: [], logs };
    }

    if (response.status === 400 || response.status === 401 || response.status === 403) {
      const error = `${config.authMode === "vertex_ai" ? "Vertex AI" : "Gemini"} API key is invalid or unauthorized.`;
      log.warn({ success: false, status: response.status }, error);
      return { success: false, error, models: [] };
    }

    const provider = config.authMode === "vertex_ai" ? "Vertex AI" : "Gemini API";
    const error = `${provider} returned unexpected status ${response.status}.`;
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
