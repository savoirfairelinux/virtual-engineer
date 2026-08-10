/**
 * GitHub connection validator.
 *
 * Tests a GitHub PAT or OAuth access token by calling `GET /user` on the
 * GitHub REST API (github.com or GitHub Enterprise Server). The token is
 * stored in plain-text in `config.token`; no decryption is needed.
 *
 * Mirrors the Claude/Aider validator contract so the plugin descriptor
 * `testConnection` hook stays uniform.
 */
import type { ConnectionTestResult } from "../plugins/pluginManager.js";
import { getLogger } from "../logger.js";

const log = getLogger("github-connection-validator");

export interface GitHubConnectionValidationConfig {
  /** GitHub PAT or OAuth access token. */
  token?: string | undefined;
  /**
   * GitHub REST API base URL.
   * Defaults to `https://api.github.com` (github.com).
   * Set to `https://<host>/api/v3` for GitHub Enterprise Server.
   */
  apiBaseUrl?: string | undefined;
}

export interface GitHubConnectionValidatorDependencies {
  fetch?: typeof globalThis.fetch | undefined;
}

const GITHUB_API_BASE = "https://api.github.com";

/** Validate a GitHub PAT or OAuth access token against the /user endpoint. */
export async function validateGitHubConnection(
  config: GitHubConnectionValidationConfig,
  dependencies: GitHubConnectionValidatorDependencies = {},
): Promise<ConnectionTestResult> {
  const apiBaseUrl = config.apiBaseUrl?.replace(/\/+$/, "") ?? GITHUB_API_BASE;
  log.info({ apiBaseUrl }, "testing GitHub connection");

  const token = config.token?.trim();
  if (!token) {
    return {
      success: false,
      error:
        "No access token configured. Provide a Personal Access Token or complete the OAuth device flow.",
      models: [],
    };
  }

  const fetchFn = dependencies.fetch ?? globalThis.fetch;

  try {
    const response = await fetchFn(`${apiBaseUrl}/user`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "virtual-engineer",
      },
    });

    if (response.status === 200) {
      log.info({ success: true }, "GitHub token is valid");
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
