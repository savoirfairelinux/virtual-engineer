/**
 * Codex connection validator.
 *
 * Tests a stored OpenAI API key by calling the OpenAI `/v1/models` endpoint,
 * mirroring the Claude/Copilot validator contract.
 *
 * Subscription mode (a manually-pasted Codex/ChatGPT access token) has no
 * publicly documented HTTP endpoint a third party can call to validate the
 * token directly — unlike Claude, Codex exposes no public OAuth client id or
 * validation API for automation tokens. This validator therefore only checks
 * that a non-empty token was provided; full verification happens on the first
 * real `codex login --with-access-token` bootstrap inside the sandbox.
 */
import type { ConnectionTestResult } from "../plugins/pluginManager.js";
import { getLogger } from "../logger.js";

const log = getLogger("codex-connection-validator");

export interface CodexConnectionValidationConfig {
  /** "api_key" (OpenAI API key) or "subscription" (Codex/ChatGPT access token). */
  authMode?: string | undefined;
  /** OpenAI API key (api_key mode). */
  apiKey?: string | undefined;
  /** Manually-pasted Codex/ChatGPT access token (subscription mode). */
  accessToken?: string | undefined;
  /** Accepted but ignored — the model lives on the agents table. */
  model?: string | undefined;
}

export interface CodexConnectionValidatorDependencies {
  fetch?: typeof globalThis.fetch | undefined;
}

const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

/** Validate a stored OpenAI API key or Codex subscription access token. */
export async function validateCodexConnection(
  config: CodexConnectionValidationConfig,
  dependencies: CodexConnectionValidatorDependencies = {}
): Promise<ConnectionTestResult> {
  const authMode = config.authMode ?? "api_key";
  log.info({ type: "codex", authMode }, "testing Codex connection");

  if (authMode === "api_key") {
    const apiKey = config.apiKey?.trim();
    if (!apiKey) {
      return {
        success: false,
        error: "No OpenAI API key provided. Paste your key (sk-…) in the API key field.",
        models: [],
      };
    }
    return callOpenAiModelsApi(apiKey, dependencies);
  }

  const token = config.accessToken?.trim();
  if (!token) {
    return {
      success: false,
      error: "No Codex access token configured. Paste a Codex/ChatGPT access token.",
      models: [],
    };
  }
  return {
    success: true,
    error: null,
    models: [],
    logs: [
      "Access token present. Codex has no public endpoint to verify a subscription " +
      "access token ahead of time — it is verified on the first real agent run.",
    ],
  };
}

async function callOpenAiModelsApi(
  apiKey: string,
  dependencies: CodexConnectionValidatorDependencies
): Promise<ConnectionTestResult> {
  const fetchFn = dependencies.fetch ?? globalThis.fetch;

  try {
    const response = await fetchFn(OPENAI_MODELS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": "virtual-engineer",
      },
    });

    if (response.status === 200) {
      log.info({ success: true }, "Codex credentials are valid");
      const body = (await response.json().catch(() => ({}))) as { data?: Array<{ id?: string }> };
      const modelIds = Array.isArray(body.data)
        ? body.data.map((m) => m.id).filter((id): id is string => typeof id === "string")
        : [];
      const logs: string[] = ["Authentication successful (API key)."];
      if (modelIds.length > 0) logs.push(`Available models: ${modelIds.join(", ")}.`);
      return { success: true, error: null, models: [], logs };
    }

    if (response.status === 401 || response.status === 403) {
      const error = "OpenAI API key is invalid or unauthorized.";
      log.warn({ success: false, status: response.status }, error);
      return { success: false, error, models: [] };
    }

    const error = `OpenAI API returned unexpected status ${response.status}.`;
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
