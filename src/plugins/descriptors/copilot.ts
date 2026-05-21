import { z } from "zod";
import type { PluginDescriptor } from "../registry.js";
import { validateCopilotConnection, type CopilotConnectionValidationConfig } from "../../agents/copilotConnectionValidator.js";
import { pollForAccessToken, startDeviceFlow } from "../../agents/copilotOAuthService.js";
import type {
  DeviceProviderAuthHandler,
  ProviderAuthDeviceCompleteInput,
  ProviderAuthHandlerCompleteResult,
  ProviderAuthDeviceStartResult,
} from "../../agents/providerAuthService.js";

/**
 * Copilot integration descriptor. Auth uses GitHub OAuth device flow.
 * The integration config stores only the encrypted session token; the model lives on the `agents` table.
 */
export const copilotConfigSchema = z.object({
  /** Encrypted OAuth session token (set by the device flow, not user-entered). */
  sessionToken: z.string().optional(),
  /** Accepted but discarded — model lives on the agents table. */
  model: z.string().optional().transform(() => undefined),
});

export type CopilotPluginConfig = z.infer<typeof copilotConfigSchema>;

/** Returns the Copilot plugin descriptor. `adminAuthSecret` is captured for the `testConnection` hook. */
export function createCopilotDescriptor(adminAuthSecret?: string): PluginDescriptor {
  return {
    type: "copilot",
    name: "GitHub Copilot",
    category: "agent",
    configSchema: copilotConfigSchema,
    // sessionToken is hidden: written by the OAuth flow, masked on read, preserved on update.
    requiredFields: [
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
  };
}
