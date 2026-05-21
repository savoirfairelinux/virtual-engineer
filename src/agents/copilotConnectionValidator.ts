import type { ConnectionTestResult } from "../plugins/pluginManager.js";
import { decryptToken } from "../utils/encryption.js";
import { getLogger } from "../logger.js";

const log = getLogger("copilot-connection-validator");

export interface CopilotConnectionValidationConfig {
  sessionToken?: string | undefined;
  model?: string | undefined;
}

export interface CopilotConnectionValidatorDependencies {
  fetch?: typeof globalThis.fetch | undefined;
  adminAuthSecret?: string | undefined;
}

const GITHUB_API_USER_URL = "https://api.github.com/user";

/** Test a stored Copilot session token by calling the GitHub user API endpoint. */
export async function validateCopilotConnection(
  config: CopilotConnectionValidationConfig,
  dependencies: CopilotConnectionValidatorDependencies = {}
): Promise<ConnectionTestResult> {
  log.info({ type: "copilot" }, "testing Copilot connection");

  const encrypted = config.sessionToken?.trim();
  if (!encrypted) {
    return {
      success: false,
      error: "No session token configured. Use the OAuth device flow to authenticate.",
      models: [],
    };
  }

  const secret = dependencies.adminAuthSecret;

  let token: string;
  try {
    token = decryptToken(encrypted, secret);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      models: [],
    };
  }

  const fetchFn = dependencies.fetch ?? globalThis.fetch;
  try {
    const response = await fetchFn(GITHUB_API_USER_URL, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "User-Agent": "virtual-engineer",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (response.status === 200) {
      log.info({ success: true }, "Copilot session token is valid");
      return { success: true, error: null, models: [] };
    }

    if (response.status === 401 || response.status === 403) {
      const error = "GitHub token is invalid or unauthorized.";
      log.warn({ success: false, status: response.status }, error);
      return { success: false, error, models: [] };
    }

    const error = `GitHub API returned unexpected status ${response.status}.`;
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
