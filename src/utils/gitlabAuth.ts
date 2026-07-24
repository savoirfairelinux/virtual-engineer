/** Shared GitLab auth helpers for PAT and OAuth-backed access tokens. */

type GitLabHeaderInput = RequestInit["headers"];

function getNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeGitLabBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** Return true when a proxy target is an HTTP(S) URL on the configured GitLab origin. */
export function isAllowedGitLabProxyTarget(targetUrl: string, baseUrl: string): boolean {
  try {
    const target = new URL(targetUrl);
    const base = new URL(baseUrl);
    return (target.protocol === "http:" || target.protocol === "https:") &&
      target.origin === base.origin &&
      target.username.length === 0 &&
      target.password.length === 0 &&
      /\/uploads\/[^/]+\/.+/.test(target.pathname);
  } catch {
    return false;
  }
}

export function getGitLabBaseUrl(config: Record<string, unknown>): string {
  const baseUrl = getNonEmptyString(config["baseUrl"]);
  if (!baseUrl) {
    throw new Error("GitLab baseUrl is required");
  }
  return normalizeGitLabBaseUrl(baseUrl);
}

export function getGitLabAccessToken(config: Record<string, unknown>): string {
  const token = getNonEmptyString(config["token"]);
  if (!token) {
    throw new Error("GitLab access token is required. Complete OAuth or provide a personal access token.");
  }
  return token;
}

export function getGitLabRequiredConfigString(
  config: Record<string, unknown>,
  key: string,
  label: string
): string {
  const value = getNonEmptyString(config[key]);
  if (!value) {
    throw new Error(`${label} is required`);
  }
  return value;
}

export function buildGitLabAuthHeaders(
  token: string,
  headers?: GitLabHeaderInput
): Record<string, string> {
  const normalized: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    normalized[key] = value;
  });
  delete normalized["authorization"];
  return {
    ...normalized,
    Authorization: `Bearer ${token}`,
  };
}

export function buildGitLabApiHeaders(
  token: string,
  headers?: GitLabHeaderInput
): Record<string, string> {
  const normalized = buildGitLabAuthHeaders(token, headers);
  delete normalized["content-type"];
  return {
    ...normalized,
    "Content-Type": "application/json",
  };
}

/**
 * Rewrite a GitLab project-upload URL to its token-fetchable REST API form.
 *
 * GitLab renders project upload markdown as
 *   `<baseUrl>/<namespace>/<project>/uploads/<secret>/<filename>`
 * which a browser can only load while logged in. The same upload is fetchable
 * with a token via the REST API:
 *   `<baseUrl>/api/v4/projects/<encoded path>/uploads/<secret>/<filename>`
 *
 * The project path is parsed from the URL itself, so the rewrite works for any
 * project without needing a single configured project id. Instance/group-level
 * uploads (`<baseUrl>/uploads/...`, `<baseUrl>/-/...`) and non-upload URLs are
 * returned unchanged.
 */
export function rewriteGitLabUploadUrl(targetUrl: string, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const prefix = `${base}/`;
  if (!targetUrl.startsWith(prefix)) {
    return targetUrl;
  }
  const rest = targetUrl.slice(prefix.length);
  const match = /^(.+?)\/uploads\/([0-9a-f]{32})\/(.+)$/.exec(rest);
  if (!match) {
    return targetUrl;
  }
  const projectPath = match[1];
  const secret = match[2];
  const filename = match[3];
  if (!projectPath || !secret || !filename) {
    return targetUrl;
  }
  // Skip instance/group-level or already-API upload paths (no project segment).
  if (projectPath.startsWith("-/") || projectPath.startsWith("api/")) {
    return targetUrl;
  }
  return `${base}/api/v4/projects/${encodeURIComponent(projectPath)}/uploads/${secret}/${filename}`;
}

export async function fetchGitLabCurrentUser(config: Record<string, unknown>): Promise<Record<string, unknown>> {
  const baseUrl = getGitLabBaseUrl(config);
  const token = getGitLabAccessToken(config);
  const response = await globalThis.fetch(`${baseUrl}/api/v4/user`, {
    headers: buildGitLabApiHeaders(token),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => `HTTP ${response.status}`);
    throw new Error(`GitLab authentication failed: ${body}`);
  }
  const user = await response.json().catch(() => ({}));
  if (!user || typeof user !== "object" || !("id" in user)) {
    throw new Error("Invalid GitLab response: missing user data");
  }
  return user as Record<string, unknown>;
}