/**
 * Cursor CLI connection validator.
 *
 * Cursor CLI authenticates with a single `CURSOR_API_KEY` (no OAuth/subscription
 * mode). Unlike Codex/Gemini, Cursor exposes a real REST API
 * (`api.cursor.com`, the "Cloud Agents API") reachable from the host, so this
 * validates the key against its identity endpoint rather than only checking
 * for a non-empty value.
 */
import type { ConnectionTestResult } from "../plugins/pluginManager.js";
import { getLogger } from "../logger.js";

const log = getLogger("cursor-connection-validator");

export interface CursorConnectionValidationConfig {
  /** Cursor API key, generated from Cursor Dashboard → API Keys. */
  apiKey?: string | undefined;
  /** Accepted but ignored — the model lives on the agents table. */
  model?: string | undefined;
}

export interface CursorConnectionValidatorDependencies {
  fetch?: typeof globalThis.fetch | undefined;
}

const CURSOR_ME_URL = "https://api.cursor.com/v1/me";

/** Validate a stored Cursor API key against the Cloud Agents API identity endpoint. */
export async function validateCursorConnection(
  config: CursorConnectionValidationConfig,
  dependencies: CursorConnectionValidatorDependencies = {}
): Promise<ConnectionTestResult> {
  log.info({ type: "cursor" }, "testing Cursor connection");

  const apiKey = config.apiKey?.trim();
  if (!apiKey) {
    return {
      success: false,
      error: "No Cursor API key provided. Paste your key from Cursor Dashboard → API Keys.",
      models: [],
    };
  }
  return callCursorMeApi(apiKey, dependencies);
}

async function callCursorMeApi(
  apiKey: string,
  dependencies: CursorConnectionValidatorDependencies
): Promise<ConnectionTestResult> {
  const fetchFn = dependencies.fetch ?? globalThis.fetch;

  try {
    const response = await fetchFn(CURSOR_ME_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": "virtual-engineer",
      },
    });

    if (response.status === 200) {
      log.info({ success: true }, "Cursor credentials are valid");
      const body = (await response.json().catch(() => ({}))) as { apiKeyName?: string };
      const logs: string[] = ["Authentication successful."];
      if (typeof body.apiKeyName === "string" && body.apiKeyName) {
        logs.push(`API key name: ${body.apiKeyName}.`);
      }
      return { success: true, error: null, models: [], logs };
    }

    if (response.status === 401 || response.status === 403) {
      const error = "Cursor API key is invalid or unauthorized.";
      log.warn({ success: false, status: response.status }, error);
      return { success: false, error, models: [] };
    }

    const error = `Cursor API returned unexpected status ${response.status}.`;
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
