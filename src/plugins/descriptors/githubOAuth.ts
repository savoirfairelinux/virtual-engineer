import { z } from "zod";
import type {
  DeviceProviderAuthHandler,
  ProviderAuthDeviceCompleteInput,
  ProviderAuthDeviceStartResult,
  ProviderAuthHandlerCompleteResult,
} from "../../agents/providerAuthService.js";
import type { PluginOAuthConfig } from "../registry.js";
import {
  resolveGitHubUrls,
  startGitHubDeviceFlow,
  pollGitHubDeviceToken,
  type GitHubMode,
} from "../../utils/githubAuth.js";

// ─── Shared Zod schemas for GitHub OAuth / auth configuration ─────────────────

/** Public client ID for the GitHub CLI OAuth app (safe to embed in version control). */
const GITHUB_COM_CLIENT_ID = "178c6fc778ccc68e1d6a";

export const githubModeSchema = z.enum(["github.com", "github-enterprise"]);

export const githubAuthModeSchema = z.enum(["pat", "oauth"]);

export const githubBaseUrlSchema = z.string().url().optional();

export const githubTokenSchema = z.string().min(1).optional();

export const githubOAuthClientIdSchema = z.string().min(1).optional();

export function getGitHubAccessToken(config: Record<string, unknown>): string {
  const raw = config["token"];
  const token = typeof raw === "string" ? raw.trim() : "";
  if (!token) {
    throw new Error("GitHub access token is required. Complete the OAuth Connect flow or provide a personal access token.");
  }
  return token;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getString(config: Record<string, unknown>, key: string): string | undefined {
  const v = config[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function getRequiredString(config: Record<string, unknown>, key: string, label: string): string {
  const v = getString(config, key);
  if (!v) throw new Error(`${label} is required`);
  return v;
}

function resolveMode(config: Record<string, unknown>): GitHubMode {
  const mode = getString(config, "mode");
  return mode === "github-enterprise" ? "github-enterprise" : "github.com";
}

// ─── PluginOAuthConfig (declarative UI) ───────────────────────────────────────

export function createGitHubOAuthConfig(
  type: string,
  heading: string
): PluginOAuthConfig {
  return {
    mode: "device",
    tokenField: "token",
    dependsOn: { field: "authMode", value: "oauth" },
    providerName: "GitHub",
    heading,
    connectLabel: "Connect with GitHub",
    reconnectLabel: "Re-connect",
    pendingLabel: "Waiting\u2026",
    startPath: `/api/admin/plugins/${type}/oauth/device-code`,
    completePath: `/api/admin/plugins/${type}/oauth/token`,
  };
}

// ─── DeviceProviderAuthHandler ────────────────────────────────────────────────

export function createGitHubDeviceOAuthHandler(
  config?: Record<string, unknown>
): DeviceProviderAuthHandler {
  const cfg = config ?? {};
  const mode = resolveMode(cfg);
  const baseUrl = getString(cfg, "baseUrl");
  const urls = resolveGitHubUrls(mode, baseUrl);
  // For github.com, use the public GitHub CLI client ID — no need to supply your own.
  // For GitHub Enterprise, a user-registered OAuth App client ID is required.
  const clientId =
    mode === "github.com"
      ? GITHUB_COM_CLIENT_ID
      : getRequiredString(cfg, "oauthClientId", "GitHub OAuth Client ID");

  return {
    kind: "device",
    async start(): Promise<ProviderAuthDeviceStartResult> {
      const flow = await startGitHubDeviceFlow(clientId, urls.webBaseUrl);
      return {
        deviceCode: flow.deviceCode,
        userCode: flow.userCode,
        verificationUri: flow.verificationUri,
        expiresIn: flow.expiresIn,
        interval: flow.interval,
      };
    },
    async complete(
      input: ProviderAuthDeviceCompleteInput
    ): Promise<ProviderAuthHandlerCompleteResult> {
      // Poll until authorized, expired, or max attempts reached (mirrors Copilot's device flow).
      let intervalSecs = 5;
      const maxAttempts = 72; // 6 minutes at 5s interval
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise<void>((resolve) => setTimeout(resolve, intervalSecs * 1000));
        const result = await pollGitHubDeviceToken(clientId, input.deviceCode, urls.webBaseUrl);
        if (result.status === "success") {
          return { token: result.token.accessToken };
        }
        if (result.status === "slow_down") {
          intervalSecs = result.interval;
          continue;
        }
        if (result.status === "pending") {
          continue;
        }
        if (result.status === "expired") {
          throw new Error("Device code expired — user did not authorize in time");
        }
        throw new Error(result.status === "error" ? result.error : "Device flow failed");
      }
      throw new Error("Device flow polling timed out");
    },
  };
}
