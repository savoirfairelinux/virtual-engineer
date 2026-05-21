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