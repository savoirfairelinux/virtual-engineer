import { z } from "zod";
import type { ProviderDescriptor } from "../registry.js";
import { ModelDiscoveryConfigError } from "../registry.js";
import { CopilotAdapter } from "../../agents/copilotAdapter.js";
import { DEFAULT_COPILOT_MODEL } from "../../copilotModel.js";
import { validateCopilotConnection, type CopilotConnectionValidationConfig } from "../../agents/copilotConnectionValidator.js";
import { pollForAccessToken, startDeviceFlow } from "../../agents/copilotOAuthService.js";
import { exchangeForSessionToken, fetchAvailableModels, fetchAvailableModelsWithPat } from "../../agents/copilotModelsService.js";
import { decryptToken } from "../../utils/encryption.js";
import type {
  DeviceProviderAuthHandler,
  ProviderAuthDeviceCompleteInput,
  ProviderAuthHandlerCompleteResult,
  ProviderAuthDeviceStartResult,
} from "../../agents/providerAuthService.js";

/**
 * Copilot integration descriptor. Auth uses GitHub OAuth device flow or a
 * user-provided Personal Access Token (PAT).
 * The integration config stores the session/token; the model lives on the `agents` table.
 */
export const copilotConfigSchema = z.object({
  /** Auth mode: OAuth device flow or explicit Personal Access Token. */
  authMode: z.enum(["oauth", "pat"]).default("oauth"),
  /** Encrypted OAuth session token (set by the device flow, not user-entered). */
  sessionToken: z.string().optional(),
  /** Personal Access Token entered directly by the user (stored when authMode is "pat"). */
  token: z.string().optional(),
  /** Accepted but discarded — model lives on the agents table. */
  model: z.string().optional().transform(() => undefined),
});

export type CopilotPluginConfig = z.infer<typeof copilotConfigSchema>;

/** Returns the Copilot plugin descriptor. `adminAuthSecret` is captured for the `testConnection` hook. */
export function createCopilotDescriptor(adminAuthSecret?: string): ProviderDescriptor {
  return {
    provider: "copilot",
    name: "GitHub Copilot",
    icon: { slug: "githubcopilot", hex: "000000" },
    configSchema: copilotConfigSchema,
    validateFullConfigOnCreate: true,
    requiredFields: [
      {
        key: "authMode",
        label: "Auth Mode",
        type: "select",
        required: true,
        options: [
          { value: "oauth", label: "OAuth Device Flow" },
          { value: "pat", label: "Personal Access Token" },
        ],
      },
      {
        key: "token",
        label: "Personal Access Token",
        type: "password",
        required: false,
        placeholder: "ghp_… or github_pat_…",
        dependsOn: { field: "authMode", value: "pat" },
      },
      // sessionToken is hidden: written by the OAuth flow, masked on read, preserved on update.
      {
        key: "sessionToken",
        label: "Session Token",
        type: "password",
        required: false,
        hidden: true,
      },
    ],
    oauth: {
      mode: "device",
      tokenField: "sessionToken",
      dependsOn: { field: "authMode", value: "oauth" },
      providerName: "GitHub",
      heading: "GitHub Copilot Authentication",
      connectLabel: "Connect with GitHub",
      reconnectLabel: "Re-connect",
      pendingLabel: "Waiting…",
      startPath: "/api/admin/plugins/copilot/oauth/device-code",
      completePath: "/api/admin/plugins/copilot/oauth/token",
    },
    createOAuthHandler: (_config?: Record<string, unknown>): DeviceProviderAuthHandler => ({
      kind: "device",
      start: async (): Promise<ProviderAuthDeviceStartResult> => startDeviceFlow(),
      complete: async (
        { deviceCode }: ProviderAuthDeviceCompleteInput
      ): Promise<ProviderAuthHandlerCompleteResult> => {
        const { accessToken } = await pollForAccessToken(deviceCode);
        return { token: accessToken };
      },
    }),
    testConnection: (config) =>
      validateCopilotConnection(
        config as CopilotConnectionValidationConfig,
        { adminAuthSecret }
      ),
    discoverModels: async (config): Promise<Array<{ id: string; name: string }>> => {
      const cfg = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
      const authMode = typeof cfg["authMode"] === "string" ? cfg["authMode"] : "oauth";
      let githubToken: string;
      if (authMode === "pat") {
        const pat = typeof cfg["token"] === "string" ? cfg["token"].trim() : "";
        if (!pat) {
          throw new ModelDiscoveryConfigError("No PAT configured. Set a token in the integration config.");
        }
        githubToken = pat;
      } else {
        const encryptedToken = typeof cfg["sessionToken"] === "string" ? cfg["sessionToken"] : undefined;
        if (!encryptedToken) {
          throw new ModelDiscoveryConfigError(
            "No GitHub OAuth token stored. Connect via OAuth first (AI Adapters → Connect with GitHub)."
          );
        }
        githubToken = decryptToken(encryptedToken, adminAuthSecret);
      }
      // PAT: use the @github/copilot-sdk CopilotClient which spawns the bundled
      //      CLI and handles its own token exchange internally.
      //      OAuth: exchange the user token for a short-lived session token
      //      first, then call the Copilot models HTTP API.
      return authMode === "pat"
        ? await fetchAvailableModelsWithPat(githubToken)
        : await fetchAvailableModels(await exchangeForSessionToken(githubToken));
    },
    getSummaryDetails(_config: Record<string, unknown>): string[] {
      return [];
    },
    capabilities: {
      agent_execution: {
        buildAdapter: (context) =>
          new CopilotAdapter({
            model: DEFAULT_COPILOT_MODEL,
            maxCommitsPerCycle: context.maxCommitsPerCycle,
          }),
      },
    },
  };
}
