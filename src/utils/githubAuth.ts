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
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ client_id: clientId, scope: "repo" }),
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
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
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

// ─── Error ────────────────────────────────────────────────────────────────────

export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAuthError";
  }
}
