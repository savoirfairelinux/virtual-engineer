import type { ConnectionTestResult } from "../plugins/pluginManager.js";
import { getLogger } from "../logger.js";

const log = getLogger("copilot-connection-validator");

export interface CopilotConnectionValidationConfig {
  authMode?: string | undefined;
  sessionToken?: string | undefined;
  token?: string | undefined;
  model?: string | undefined;
}

export interface CopilotConnectionValidatorDependencies {
  fetch?: typeof globalThis.fetch | undefined;
  adminAuthSecret?: string | undefined;
}

const GITHUB_API_USER_URL = "https://api.github.com/user";

/** Test a stored Copilot session token or PAT by calling the GitHub user API endpoint. */
export async function validateCopilotConnection(
  config: CopilotConnectionValidationConfig,
  dependencies: CopilotConnectionValidatorDependencies = {}
): Promise<ConnectionTestResult> {
  log.info({ type: "copilot", authMode: config.authMode ?? "oauth" }, "testing Copilot connection");

  // ── PAT mode: use the plaintext token directly ────────────────────────────
  if (config.authMode === "pat") {
    const pat = config.token?.trim();
    if (!pat) {
      return {
        success: false,
        error: "No Personal Access Token provided. Paste your GitHub PAT in the token field.",
        models: [],
      };
    }
    return callGitHubUserApi(pat, dependencies);
  }

  // ── OAuth mode (default): use the session token (decrypted by the caller) ─
  const token = config.sessionToken?.trim();
  if (!token) {
    return {
      success: false,
      error: "No session token configured. Use the OAuth device flow to authenticate.",
      models: [],
    };
  }

  return callGitHubUserApi(token, dependencies);
}

/** Shared helper: call GitHub /user API with the given bearer token. */
async function callGitHubUserApi(
  token: string,
  dependencies: CopilotConnectionValidatorDependencies
): Promise<ConnectionTestResult> {
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
      const body = await response.json?.().catch(() => ({})) as { login?: string } ?? {};
      const logs: string[] = body.login ? [`Authenticated as @${body.login} on GitHub.`] : ["Authentication successful."];
      return { success: true, error: null, models: [], logs };
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
