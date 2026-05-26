import { z } from "zod";
import type {
  DeviceProviderAuthHandler,
  ProviderAuthDeviceCompleteInput,
  ProviderAuthDeviceStartResult,
  ProviderAuthHandlerCompleteResult,
} from "../../agents/providerAuthService.js";
import type { IntegrationType } from "../../interfaces.js";
import type { PluginOAuthConfig } from "../registry.js";
import {
  resolveGitHubUrls,
  startGitHubDeviceFlow,
  pollGitHubDeviceToken,
  type GitHubMode,
} from "../../utils/githubAuth.js";

// ─── Shared Zod schemas for GitHub OAuth / auth configuration ─────────────────

export const githubModeSchema = z.enum(["github.com", "github-enterprise"]);

export const githubAuthModeSchema = z.enum(["pat", "oauth"]);

export const githubBaseUrlSchema = z.string().url().optional();

export const githubTokenSchema = z.string().min(1);

export const githubOAuthClientIdSchema = z.string().min(1).optional();

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
  type: IntegrationType,
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
  const clientId = getRequiredString(cfg, "oauthClientId", "GitHub OAuth Client ID");

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
      const result = await pollGitHubDeviceToken(clientId, input.deviceCode, urls.webBaseUrl);
      if (result.status === "success") {
        return { token: result.token.accessToken };
      }
      if (result.status === "pending" || result.status === "slow_down") {
        throw new Error("authorization_pending");
      }
      if (result.status === "expired") {
        throw new Error("Device code expired");
      }
      throw new Error(result.status === "error" ? result.error : "Device flow failed");
    },
  };
}
