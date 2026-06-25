import { getLogger } from "../logger.js";

const log = getLogger("github-auth");

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GitHubDeviceFlowResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

export interface GitHubTokenResponse {
  accessToken: string;
  tokenType: string;
  scope: string;
}

export interface GitHubUser {
  id: number;
  login: string;
}

export interface GitHubUrls {
  webBaseUrl: string;
  apiBaseUrl: string;
}

export type GitHubMode = "github.com" | "github-enterprise";

// ─── URL resolution ───────────────────────────────────────────────────────────

export function resolveGitHubUrls(
  mode: GitHubMode,
  customBaseUrl?: string | undefined
): GitHubUrls {
  if (mode === "github.com") {
    return {
      webBaseUrl: "https://github.com",
      apiBaseUrl: "https://api.github.com",
    };
  }

  if (!customBaseUrl) {
    throw new Error("customBaseUrl is required for github-enterprise mode");
  }

  const normalized = customBaseUrl.replace(/\/+$/, "");
  return {
    webBaseUrl: normalized,
    apiBaseUrl: `${normalized}/api/v3`,
  };
}

// ─── Device Flow ──────────────────────────────────────────────────────────────

export async function startGitHubDeviceFlow(
  clientId: string,
  baseUrl: string
): Promise<GitHubDeviceFlowResponse> {
  const url = `${baseUrl}/login/device/code`;

  const response = await globalThis.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ client_id: clientId, scope: "repo" }).toString(),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 404) {
      throw new GitHubAuthError(
        `Device flow start failed (404): GitHub did not recognise the OAuth Client ID "${clientId}". ` +
          `Check that the OAuth App exists at ${baseUrl}/settings/developers and that "Device flow" is enabled in its settings.`
      );
    }
    throw new GitHubAuthError(`Device flow start failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as Record<string, unknown>;

  return {
    deviceCode: data["device_code"] as string,
    userCode: data["user_code"] as string,
    verificationUri: data["verification_uri"] as string,
    interval: data["interval"] as number,
    expiresIn: data["expires_in"] as number,
  };
}

// ─── Token polling ────────────────────────────────────────────────────────────

export type PollResult =
  | { status: "success"; token: GitHubTokenResponse }
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | { status: "expired" }
  | { status: "error"; error: string };

export async function pollGitHubDeviceToken(
  clientId: string,
  deviceCode: string,
  baseUrl: string,
  _interval?: number
): Promise<PollResult> {
  const url = `${baseUrl}/login/oauth/access_token`;

  const response = await globalThis.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GitHubAuthError(`Token poll failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as Record<string, unknown>;

  if (data["error"]) {
    const errorCode = data["error"] as string;

    if (errorCode === "authorization_pending") {
      return { status: "pending" };
    }
    if (errorCode === "slow_down") {
      const newInterval = (data["interval"] as number) ?? 10;
      return { status: "slow_down", interval: newInterval };
    }
    if (errorCode === "expired_token") {
      return { status: "expired" };
    }

    return { status: "error", error: (data["error_description"] as string) ?? errorCode };
  }

  return {
    status: "success",
    token: {
      accessToken: data["access_token"] as string,
      tokenType: data["token_type"] as string,
      scope: data["scope"] as string,
    },
  };
}

// ─── Current user ─────────────────────────────────────────────────────────────

export async function fetchGitHubCurrentUser(
  token: string,
  apiBaseUrl: string
): Promise<GitHubUser> {
  const url = `${apiBaseUrl}/user`;

  const response = await globalThis.fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GitHubAuthError(`Fetch current user failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  log.debug({ login: data["login"] }, "fetched GitHub current user");

  return {
    id: data["id"] as number,
    login: data["login"] as string,
  };
}

// ─── Repository lookup ───────────────────────────────────────────────────────

export interface GitHubRepoInfo {
  fullName: string;
  name: string;
  htmlUrl: string;
  cloneUrl: string;
  sshUrl: string;
  defaultBranch: string;
}

export async function fetchGitHubRepository(
  token: string,
  apiBaseUrl: string,
  owner: string,
  repo: string
): Promise<GitHubRepoInfo> {
  const url = `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  const response = await globalThis.fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 404) {
      throw new GitHubAuthError(
        `Repository "${owner}/${repo}" was not found or is not visible to the current GitHub token. ` +
          `Check the owner/repo spelling and that the token has access to it.`
      );
    }
    throw new GitHubAuthError(`Fetch repository failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  return {
    fullName: data["full_name"] as string,
    name: data["name"] as string,
    htmlUrl: data["html_url"] as string,
    cloneUrl: data["clone_url"] as string,
    sshUrl: data["ssh_url"] as string,
    defaultBranch: data["default_branch"] as string,
  };
}

export interface GitHubDiscoveredRepo {
  fullName: string;
  name: string;
  htmlUrl: string;
  cloneUrl: string;
  sshUrl: string;
  defaultBranch: string;
}

/**
 * List the repositories the supplied token can actually access under a given
 * owner. Uses /user/repos (token-centric) rather than /orgs/{owner}/repos so
 * the result reflects the token's real grants — a fine-grained PAT scoped to a
 * single repo returns only that repo, instead of every public repo of the org.
 * Results are then filtered to the configured owner (case-insensitive).
 *
 * Pagination follows the GitHub `Link: <...>; rel="next"` header rather than
 * incrementing pages blindly, which is the documented mechanism.
 */
export async function listGitHubRepositoriesForOwner(
  token: string,
  apiBaseUrl: string,
  owner: string
): Promise<GitHubDiscoveredRepo[]> {
  const url = `${apiBaseUrl}/user/repos?per_page=100&type=all&sort=full_name`;

  const result = await fetchPaginated(token, url);
  if (!result.ok) {
    throw new GitHubAuthError(`List repositories failed (${result.status}): ${result.body}`);
  }

  const ownerLc = owner.toLowerCase();
  return result.repos.filter((r) => r.fullName.split("/")[0]?.toLowerCase() === ownerLc);
}

interface PaginatedResult {
  ok: boolean;
  status: number;
  body: string;
  repos: GitHubDiscoveredRepo[];
}

async function fetchPaginated(token: string, firstUrl: string): Promise<PaginatedResult> {
  const repos: GitHubDiscoveredRepo[] = [];
  let nextUrl: string | null = firstUrl;
  let attempts = 0;
  while (nextUrl !== null) {
    if (attempts++ > 50) {
      throw new GitHubAuthError("Too many GitHub repo pagination requests (>50 pages)");
    }
    const response: Response = await globalThis.fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, status: response.status, body, repos: [] };
    }
    const page = (await response.json()) as Array<Record<string, unknown>>;
    for (const item of page) {
      repos.push({
        fullName: item["full_name"] as string,
        name: item["name"] as string,
        htmlUrl: item["html_url"] as string,
        cloneUrl: item["clone_url"] as string,
        sshUrl: item["ssh_url"] as string,
        defaultBranch: item["default_branch"] as string,
      });
    }
    nextUrl = parseNextLink(response.headers.get("Link"));
  }
  log.debug({ count: repos.length }, "listed GitHub repositories for owner");
  return { ok: true, status: 200, body: "", repos };
}

// Link header format: `<https://api.github.com/...&page=2>; rel="next", <...>; rel="last"`
function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1] ?? null;
  }
  return null;
}

// ─── Error ────────────────────────────────────────────────────────────────────

/**
 * List all repositories accessible to the authenticated user (token-scoped).
 * Uses `GET /user/repos` which returns personal repos + org repos the user has
 * access to — no owner parameter needed.
 */
export async function listGitHubRepositoriesForUser(
  token: string,
  apiBaseUrl: string
): Promise<GitHubDiscoveredRepo[]> {
  const url = `${apiBaseUrl}/user/repos?per_page=100&type=all&sort=full_name`;
  const result = await fetchPaginated(token, url);
  if (!result.ok) {
    throw new GitHubAuthError(`List user repositories failed (${result.status}): ${result.body}`);
  }
  return result.repos;
}

/**
 * List the branch names of a GitHub repository (push-target branch selection).
 * `fullName` is the `owner/repo` slug. Follows `Link: rel="next"` pagination.
 */
export async function listGitHubBranches(
  token: string,
  apiBaseUrl: string,
  fullName: string
): Promise<string[]> {
  const names: string[] = [];
  let nextUrl: string | null = `${apiBaseUrl}/repos/${fullName}/branches?per_page=100`;
  let attempts = 0;
  while (nextUrl !== null) {
    if (attempts++ > 50) {
      throw new GitHubAuthError("Too many GitHub branch pagination requests (>50 pages)");
    }
    const response: Response = await globalThis.fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new GitHubAuthError(`List branches failed (${response.status}): ${body}`);
    }
    const page = (await response.json()) as Array<Record<string, unknown>>;
    for (const item of page) {
      const name = item["name"];
      if (typeof name === "string") names.push(name);
    }
    nextUrl = parseNextLink(response.headers.get("Link"));
  }
  log.debug({ fullName, count: names.length }, "listed GitHub branches");
  return names;
}

export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAuthError";
  }
}
