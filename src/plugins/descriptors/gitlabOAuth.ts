import { z } from "zod";
import type { DeviceProviderAuthHandler, ProviderAuthDeviceCompleteInput, ProviderAuthDeviceStartResult, ProviderAuthHandlerCompleteResult, RedirectProviderAuthHandler } from "../../agents/providerAuthService.js";
import type { IntegrationType } from "../../interfaces.js";
import {
  getGitLabBaseUrl,
  getGitLabRequiredConfigString,
  normalizeGitLabBaseUrl,
} from "../../utils/gitlabAuth.js";
import type { PluginField, PluginOAuthConfig, PluginOAuthConfigResolverContext } from "../registry.js";
import { fetchGitLabCurrentUser } from "../../utils/gitlabAuth.js";

export const gitlabAuthModeSchema = z.enum(["oauth", "pat"]).default("pat");
export const gitlabOAuthClientIdSchema = z.string().min(1).optional();
export const gitlabTokenSchema = z.string().min(1).optional();
export const UNBOUND_GITLAB_PROJECT_ID = "__ve-project-binding-required__";

export const GITLAB_COM_BASE_URL = "https://gitlab.com";
/** Pre-configured VE OAuth application client_id registered on gitlab.com with Device Authorization Grant enabled. */
export const GITLAB_COM_VE_CLIENT_ID = "";
export const gitlabModeSchema = z.enum(["gitlab.com", "self-hosted"]).default("gitlab.com");

function getOptionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function createGitLabAuthFields(tokenLabel: string): PluginField[] {
  return [
    {
      key: "gitlabMode",
      label: "GitLab Mode",
      type: "select",
      required: true,
      options: [
        { value: "gitlab.com", label: "GitLab.com" },
        { value: "self-hosted", label: "Self-hosted" },
      ],
    },
    {
      key: "baseUrl",
      label: "GitLab Base URL",
      type: "url",
      required: false,
      placeholder: "https://gitlab.example.com",
      dependsOn: { field: "gitlabMode", value: "self-hosted" },
    },
    {
      key: "authMode",
      label: "Authentication Mode",
      type: "select",
      required: true,
      options: [
        { value: "pat", label: "Personal Access Token" },
        { value: "oauth", label: "OAuth" },
      ],
    },
    {
      key: "oauthClientId",
      label: "OAuth Client ID",
      type: "text",
      required: false,
      placeholder: "Application Client ID from GitLab",
      dependsOn: { field: "authMode", value: "oauth" },
    },
    {
      key: "token",
      label: tokenLabel,
      type: "password",
      required: false,
      placeholder: "glpat-...",
      dependsOn: { field: "authMode", value: "pat" },
    },
  ];
}

export function createGitLabOAuthConfig(
  type: IntegrationType,
  heading: string
): PluginOAuthConfig {
  return {
    mode: "device",
    tokenField: "token",
    dependsOn: { field: "authMode", value: "oauth" },
    providerName: "GitLab",
    heading,
    connectLabel: "Connect with GitLab",
    reconnectLabel: "Re-connect",
    pendingLabel: "Waiting\u2026",
    startPath: `/api/admin/plugins/${type}/oauth/device-code`,
    completePath: `/api/admin/plugins/${type}/oauth/token`,
  };
}

export async function testGitLabConnection(
  config: Record<string, unknown>
): Promise<{ success: boolean; error: string | null; models?: Array<{ id: string; name: string }> | undefined }> {
  const token = getOptionalTrimmedString(config["token"]);
  const isOAuth = config["authMode"] === "oauth";

  if (!token) {
    return {
      success: false,
      error: isOAuth
        ? "GitLab OAuth is not connected. Complete the OAuth flow or reconnect the integration, then run Test Connection again."
        : "GitLab personal access token is required. Provide a token, then run Test Connection again.",
    };
  }

  const explicitBaseUrl = getOptionalTrimmedString(config["baseUrl"]);
  const enrichedConfig = explicitBaseUrl ? config : { ...config, baseUrl: GITLAB_COM_BASE_URL };

  try {
    await fetchGitLabCurrentUser(enrichedConfig);
    let models: Array<{ id: string; name: string }> | undefined;
    try {
      const projects = await listGitLabAccessibleProjects(enrichedConfig);
      models = projects.map((p) => ({ id: String(p.id), name: p.path_with_namespace }));
    } catch {
      // Project listing is best-effort; connection test still succeeded
    }
    return { success: true, error: null, ...(models !== undefined ? { models } : {}) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `${isOAuth ? "GitLab OAuth connection test failed" : "GitLab connection test failed"}: ${message}`,
    };
  }
}

export async function listGitLabAccessibleProjects(
  config: Record<string, unknown>,
  limit = 20
): Promise<Array<{ id: number; name: string; path_with_namespace: string; web_url: string }>> {
  const baseUrl = getOptionalTrimmedString(config["baseUrl"])
    ? normalizeGitLabBaseUrl(getOptionalTrimmedString(config["baseUrl"]) as string)
    : GITLAB_COM_BASE_URL;
  const token = getOptionalTrimmedString(config["token"]);
  if (!token) {
    throw new Error("GitLab access token is required to list projects");
  }
  const url = `${baseUrl}/api/v4/projects?membership=true&per_page=${limit}&order_by=last_activity_at&sort=desc`;
  const response = await globalThis.fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => `HTTP ${response.status}`);
    throw new Error(`GitLab project listing failed: ${body}`);
  }
  const raw = await response.json().catch(() => []);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
    .map((p) => ({
      id: typeof p["id"] === "number" ? p["id"] : 0,
      name: typeof p["name"] === "string" ? p["name"] : "",
      path_with_namespace: typeof p["path_with_namespace"] === "string" ? p["path_with_namespace"] : "",
      web_url: typeof p["web_url"] === "string" ? p["web_url"] : "",
    }));
}

function buildGitLabOAuthUrl(baseUrl: string, path: string): URL {
  const url = new URL(normalizeGitLabBaseUrl(baseUrl));
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}${path}`;
  return url;
}

function resolveBaseUrl(config: Record<string, unknown>): string {
  const explicit = getOptionalTrimmedString(config["baseUrl"]);
  if (explicit) {
    return normalizeGitLabBaseUrl(explicit);
  }
  const mode = typeof config["gitlabMode"] === "string" ? config["gitlabMode"] : "gitlab.com";
  if (mode === "self-hosted") {
    throw new Error("GitLab URL is required for self-hosted GitLab.");
  }
  return GITLAB_COM_BASE_URL;
}

function resolveClientId(config: Record<string, unknown>): string {
  const explicit = getOptionalTrimmedString(config["oauthClientId"]);
  if (explicit) {
    return explicit;
  }
  const mode = typeof config["gitlabMode"] === "string" ? config["gitlabMode"] : "gitlab.com";
  if (mode !== "self-hosted") {
    if (GITLAB_COM_VE_CLIENT_ID.length > 0) {
      return GITLAB_COM_VE_CLIENT_ID;
    }
    throw new Error("GitLab.com OAuth app is not yet configured. Please use a Personal Access Token or provide a Client ID.");
  }
  throw new Error("OAuth Client ID is required for self-hosted GitLab.");
}

export function createGitLabDeviceOAuthHandler(
  config?: Record<string, unknown>
): DeviceProviderAuthHandler {
  const resolvedConfig = config ?? {};
  let pollIntervalMs = 5000;
  return {
    kind: "device",
    async start(): Promise<ProviderAuthDeviceStartResult> {
      const baseUrl = resolveBaseUrl(resolvedConfig);
      const clientId = resolveClientId(resolvedConfig);
      const url = buildGitLabOAuthUrl(baseUrl, "/oauth/authorize_device");
      const body = new URLSearchParams({
        client_id: clientId,
        scope: "read_user read_api read_repository",
      });
      const response = await globalThis.fetch(url.toString(), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
      if (!response.ok) {
        const errorBody = await response.text().catch(() => `HTTP ${response.status}`);
        throw new Error(`GitLab device authorization failed: ${errorBody}`);
      }
      const raw = await response.json().catch(() => ({}));
      const data = (typeof raw === "object" && raw !== null) ? (raw as Record<string, unknown>) : {};
      const deviceCode = typeof data["device_code"] === "string" ? data["device_code"] : "";
      const userCode = typeof data["user_code"] === "string" ? data["user_code"] : "";
      const verificationUri = typeof data["verification_uri"] === "string" ? data["verification_uri"] : "";
      const expiresIn = typeof data["expires_in"] === "number" ? data["expires_in"] : 300;
      const interval = typeof data["interval"] === "number" ? data["interval"] : 5;
      pollIntervalMs = interval * 1000;
      return { deviceCode, userCode, verificationUri, expiresIn, interval };
    },
    async complete({ deviceCode }: ProviderAuthDeviceCompleteInput): Promise<ProviderAuthHandlerCompleteResult> {
      const baseUrl = resolveBaseUrl(resolvedConfig);
      const clientId = resolveClientId(resolvedConfig);
      const url = buildGitLabOAuthUrl(baseUrl, "/oauth/token");
      const maxAttempts = 60;
      let currentIntervalMs = pollIntervalMs;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, currentIntervalMs));
        }
        const body = new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: clientId,
          device_code: deviceCode,
        });
        const response = await globalThis.fetch(url.toString(), {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        });
        const raw = await response.json().catch(() => ({}));
        const data = (typeof raw === "object" && raw !== null) ? (raw as Record<string, unknown>) : {};
        if (response.ok && typeof data["access_token"] === "string" && data["access_token"].length > 0) {
          return { token: data["access_token"] };
        }
        const errorCode = typeof data["error"] === "string" ? data["error"] : "";
        const errorDescription = typeof data["error_description"] === "string" ? data["error_description"] : "";
        if (errorCode === "authorization_pending") {
          continue;
        }
        if (errorCode === "slow_down") {
          currentIntervalMs = currentIntervalMs * 2;
          continue;
        }
        if (errorCode === "expired_token") {
          throw new Error("GitLab device authorization expired. Please try again.");
        }
        throw new Error(`GitLab device authorization failed: ${errorCode}${errorDescription ? `: ${errorDescription}` : ""}`);
      }
      throw new Error("GitLab device authorization timed out.");
    },
  };
}

export function createGitLabRedirectOAuthHandler(
  config?: Record<string, unknown>
): RedirectProviderAuthHandler {
  const resolvedConfig = config ?? {};
  return {
    kind: "redirect",
    async start({ redirectUri, state, codeChallenge, codeChallengeMethod }): Promise<{ authorizationUrl: string }> {
      const baseUrl = getGitLabBaseUrl(resolvedConfig);
      const clientId = getGitLabRequiredConfigString(resolvedConfig, "oauthClientId", "GitLab OAuth client id");
      if (!codeChallenge) {
        throw new Error("GitLab OAuth PKCE code challenge is required");
      }
      if (codeChallengeMethod !== "S256") {
        throw new Error("GitLab OAuth PKCE requires codeChallengeMethod=S256");
      }
      const authorizationUrl = buildGitLabOAuthUrl(baseUrl, "/oauth/authorize");
      authorizationUrl.searchParams.set("client_id", clientId);
      authorizationUrl.searchParams.set("redirect_uri", redirectUri);
      authorizationUrl.searchParams.set("response_type", "code");
      authorizationUrl.searchParams.set("scope", "api read_user");
      if (state) {
        authorizationUrl.searchParams.set("state", state);
      }
      authorizationUrl.searchParams.set("code_challenge", codeChallenge);
      authorizationUrl.searchParams.set("code_challenge_method", codeChallengeMethod);
      return { authorizationUrl: authorizationUrl.toString() };
    },
    async complete({ code, redirectUri, state: _state, codeVerifier }): Promise<{ token: string }> {
      const baseUrl = getGitLabBaseUrl(resolvedConfig);
      const clientId = getGitLabRequiredConfigString(resolvedConfig, "oauthClientId", "GitLab OAuth client id");
      if (!codeVerifier) {
        throw new Error("GitLab OAuth PKCE code verifier is required");
      }
      const tokenUrl = buildGitLabOAuthUrl(baseUrl, "/oauth/token");
      const body = new URLSearchParams({
        client_id: clientId,
        code,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      });

      const response = await globalThis.fetch(tokenUrl.toString(), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
      if (!response.ok) {
        const errorBody = await response.text().catch(() => `HTTP ${response.status}`);
        throw new Error(`GitLab OAuth token exchange failed: ${errorBody}`);
      }

      const rawPayload = await response.json().catch(() => ({}));
      const payload = (typeof rawPayload === "object" && rawPayload !== null)
        ? (rawPayload as Record<string, unknown>)
        : {};
      const accessToken = typeof payload["access_token"] === "string" ? payload["access_token"] : undefined;
      if (!accessToken) {
        throw new Error("GitLab OAuth token exchange failed: missing access_token");
      }

      return { token: accessToken };
    },
  };
}

export async function resolveGitLabOAuthConfig(
  config: Record<string, unknown>,
  context: PluginOAuthConfigResolverContext
): Promise<Record<string, unknown>> {
  const explicitBaseUrl = getOptionalTrimmedString(config["baseUrl"]);
  const mode = typeof config["gitlabMode"] === "string" ? config["gitlabMode"] : "gitlab.com";
  const baseUrl = explicitBaseUrl
    ? normalizeGitLabBaseUrl(explicitBaseUrl)
    : mode !== "self-hosted"
      ? GITLAB_COM_BASE_URL
      : getGitLabBaseUrl(config);

  const resolvedConfig: Record<string, unknown> = {
    ...config,
    baseUrl,
  };

  if (config["authMode"] !== "oauth") {
    return resolvedConfig;
  }

  const oauthClientId = typeof config["oauthClientId"] === "string"
    ? config["oauthClientId"].trim()
    : "";
  if (oauthClientId) {
    return {
      ...resolvedConfig,
      oauthClientId,
    };
  }

  if (mode !== "self-hosted" && GITLAB_COM_VE_CLIENT_ID.length > 0) {
    return { ...resolvedConfig, oauthClientId: GITLAB_COM_VE_CLIENT_ID };
  }

  if (!context.oAuthAppStore) {
    throw new Error(`No GitLab OAuth app is configured for ${baseUrl}. Ask an administrator to add one in Configuration / OAuth Apps.`);
  }

  const app = await context.oAuthAppStore.getOAuthApp("gitlab", baseUrl);
  if (!app) {
    throw new Error(`No GitLab OAuth app is configured for ${baseUrl}. Ask an administrator to add one in Configuration / OAuth Apps.`);
  }

  return {
    ...resolvedConfig,
    oauthClientId: app.clientId,
  };
}