import { z } from "zod";
import type { ProviderDescriptor } from "../registry.js";
import { ModelDiscoveryConfigError } from "../registry.js";
import { CursorAdapter } from "../../agents/cursorAdapter.js";
import {
  validateCursorConnection,
  type CursorConnectionValidationConfig,
} from "../../agents/cursorConnectionValidator.js";
import { fetchCursorModels } from "../../agents/cursorModelsService.js";

/**
 * Cursor CLI (https://cursor.com/cli) integration descriptor.
 *
 * Authenticates with a single Cursor API key (`CURSOR_API_KEY`) — no OAuth or
 * subscription mode, unlike Claude/Codex. The chosen model lives on the
 * `agents` table, not the integration config.
 */
export const cursorConfigSchema = z.object({
  /** Cursor API key, generated from Cursor Dashboard → API Keys. */
  apiKey: z.string().optional(),
  /** Accepted but discarded — the model lives on the agents table. */
  model: z.string().optional().transform(() => undefined),
});

export type CursorPluginConfig = z.infer<typeof cursorConfigSchema>;

/** Returns the Cursor plugin descriptor. */
export function createCursorDescriptor(_adminAuthSecret?: string): ProviderDescriptor {
  return {
    provider: "cursor",
    name: "Cursor",
    icon: { slug: "cursor", hex: "000000" },
    configSchema: cursorConfigSchema,
    validateFullConfigOnCreate: true,
    requiredFields: [
      {
        key: "apiKey",
        label: "Cursor API Key",
        type: "password",
        required: true,
        placeholder: "Paste your key from Cursor Dashboard → API Keys",
      },
    ],
    testConnection: (config) =>
      validateCursorConnection(config as CursorConnectionValidationConfig, {}),
    discoverModels: async (config): Promise<Array<{ id: string; name: string }>> => {
      const cfg = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
      const apiKey = typeof cfg["apiKey"] === "string" ? cfg["apiKey"].trim() : "";
      if (!apiKey) {
        throw new ModelDiscoveryConfigError(
          "No Cursor API key configured. Set a key in the integration config."
        );
      }
      return fetchCursorModels(apiKey);
    },
    getSummaryDetails(_config: Record<string, unknown>): string[] {
      return [];
    },
    capabilities: {
      agent_execution: {
        // No model default is passed: when the agent config leaves the model
        // unset, the Cursor CLI selects its own default.
        buildAdapter: (context) =>
          new CursorAdapter({
            maxCommitsPerCycle: context.maxCommitsPerCycle,
          }),
      },
    },
  };
}
