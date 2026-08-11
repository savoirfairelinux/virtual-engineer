import { z } from "zod";
import type { ProviderDescriptor } from "../registry.js";
import { GeminiAdapter } from "../../agents/geminiAdapter.js";
import {
  validateGeminiConnection,
  type GeminiConnectionValidationConfig,
} from "../../agents/geminiConnectionValidator.js";
import { fetchGeminiModels } from "../../agents/geminiModelsService.js";
import { ModelDiscoveryConfigError } from "../registry.js";

/**
 * Gemini CLI (https://github.com/google-gemini/gemini-cli) integration
 * descriptor.
 *
 * Two ways of connecting, both authenticating with an API key:
 *  - `api_key`   — a Gemini Developer API key from AI Studio (`GEMINI_API_KEY`).
 *  - `vertex_ai` — a Vertex AI Express Mode key (`GOOGLE_API_KEY` +
 *                  `GOOGLE_GENAI_USE_VERTEXAI=true`, with optional Google
 *                  Cloud project/location).
 * "Sign in with Google" (browser OAuth) is intentionally not offered: Gemini
 * CLI has no publicly documented third-party OAuth client for automation, and
 * the flow requires a local browser redirect that doesn't fit an ephemeral
 * sandbox. The chosen model lives on the `agents` table, not the integration
 * config.
 */
export const geminiConfigSchema = z.object({
  /** Auth mode: Gemini Developer API key or Vertex AI Express Mode key. */
  authMode: z.enum(["api_key", "vertex_ai"]).default("api_key"),
  /** API key entered directly (both modes). */
  apiKey: z.string().optional(),
  /** Google Cloud project id (vertex_ai mode only). */
  googleCloudProject: z.string().optional(),
  /** Google Cloud location/region (vertex_ai mode only). */
  googleCloudLocation: z.string().optional(),
  /** Accepted but discarded — the model lives on the agents table. */
  model: z.string().optional().transform(() => undefined),
});

export type GeminiPluginConfig = z.infer<typeof geminiConfigSchema>;

/** Returns the Gemini CLI plugin descriptor. */
export function createGeminiDescriptor(_adminAuthSecret?: string): ProviderDescriptor {
  return {
    provider: "gemini",
    name: "Gemini CLI",
    icon: { slug: "gemini", hex: "8E75B2" },
    configSchema: geminiConfigSchema,
    validateFullConfigOnCreate: true,
    requiredFields: [
      {
        key: "authMode",
        label: "Auth Mode",
        type: "select",
        required: true,
        options: [
          { value: "api_key", label: "Gemini API Key (AI Studio)" },
          { value: "vertex_ai", label: "Vertex AI Express Mode" },
        ],
      },
      {
        key: "apiKey",
        label: "API Key",
        type: "password",
        required: false,
        placeholder: "Paste your Gemini or Vertex AI Express Mode key",
      },
      {
        key: "googleCloudProject",
        label: "Google Cloud Project",
        type: "text",
        required: false,
        placeholder: "my-gcp-project",
        dependsOn: { field: "authMode", value: "vertex_ai" },
      },
      {
        key: "googleCloudLocation",
        label: "Google Cloud Location",
        type: "text",
        required: false,
        placeholder: "us-central1",
        dependsOn: { field: "authMode", value: "vertex_ai" },
      },
    ],
    testConnection: (config) =>
      validateGeminiConnection(config as GeminiConnectionValidationConfig, {}),
    discoverModels: async (config): Promise<Array<{ id: string; name: string }>> => {
      const cfg = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
      const apiKey = typeof cfg["apiKey"] === "string" ? cfg["apiKey"].trim() : "";
      if (!apiKey) {
        throw new ModelDiscoveryConfigError(
          "No Gemini API key configured. Set a key in the integration config."
        );
      }
      return fetchGeminiModels(apiKey);
    },
    getSummaryDetails(_config: Record<string, unknown>): string[] {
      return [];
    },
    capabilities: {
      agent_execution: {
        // No model default is passed: when the agent config leaves the model
        // unset, the Gemini CLI selects its own default (the `auto` alias).
        buildAdapter: (context) =>
          new GeminiAdapter({
            maxCommitsPerCycle: context.maxCommitsPerCycle,
          }),
      },
    },
  };
}
