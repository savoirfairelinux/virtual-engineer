import { z } from "zod";
import type { ProviderDescriptor } from "../registry.js";
import { ModelDiscoveryConfigError } from "../registry.js";
import { CodexAdapter } from "../../agents/codexAdapter.js";
import {
  validateCodexConnection,
  type CodexConnectionValidationConfig,
} from "../../agents/codexConnectionValidator.js";
import { fetchCodexSubscriptionModels, fetchOpenAiModels } from "../../agents/codexModelsService.js";

/**
 * Codex (OpenAI Codex CLI) integration descriptor.
 *
 * Two ways of connecting:
 *  - `api_key`      — an OpenAI API key (`CODEX_API_KEY`, honored only by `codex exec`).
 *  - `subscription` — a manually-pasted Codex/ChatGPT access token
 *                     (`CODEX_ACCESS_TOKEN`). Unlike Claude, Codex has no public
 *                     third-party OAuth client id/endpoints, so this is a plain
 *                     password field rather than a redirect OAuth flow.
 * The chosen model lives on the `agents` table, not the integration config.
 */
export const codexConfigSchema = z.object({
  /** Auth mode: OpenAI API key or a manually-pasted Codex/ChatGPT access token. */
  authMode: z.enum(["api_key", "subscription"]).default("api_key"),
  /** OpenAI API key entered directly (api_key mode). */
  apiKey: z.string().optional(),
  /** Manually-pasted Codex/ChatGPT access token (subscription mode). */
  accessToken: z.string().optional(),
  /** Accepted but discarded — the model lives on the agents table. */
  model: z.string().optional().transform(() => undefined),
});

export type CodexPluginConfig = z.infer<typeof codexConfigSchema>;

/** Returns the Codex plugin descriptor. */
export function createCodexDescriptor(_adminAuthSecret?: string): ProviderDescriptor {
  return {
    provider: "codex",
    name: "Codex",
    icon: { slug: "codex", hex: "412991" },
    configSchema: codexConfigSchema,
    validateFullConfigOnCreate: true,
    requiredFields: [
      {
        key: "authMode",
        label: "Auth Mode",
        type: "select",
        required: true,
        options: [
          { value: "api_key", label: "OpenAI API Key" },
          { value: "subscription", label: "Codex Access Token (ChatGPT)" },
        ],
      },
      {
        key: "apiKey",
        label: "OpenAI API Key",
        type: "password",
        required: false,
        placeholder: "sk-…",
        dependsOn: { field: "authMode", value: "api_key" },
      },
      {
        key: "accessToken",
        label: "Codex Access Token",
        type: "password",
        required: false,
        placeholder: "Paste a Codex/ChatGPT automation access token",
        dependsOn: { field: "authMode", value: "subscription" },
      },
    ],
    testConnection: (config) =>
      validateCodexConnection(config as CodexConnectionValidationConfig, {}),
    discoverModels: async (config): Promise<Array<{ id: string; name: string }>> => {
      const cfg = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
      const authMode = typeof cfg["authMode"] === "string" ? cfg["authMode"] : "api_key";
      if (authMode === "api_key") {
        const apiKey = typeof cfg["apiKey"] === "string" ? cfg["apiKey"].trim() : "";
        if (!apiKey) {
          throw new ModelDiscoveryConfigError(
            "No OpenAI API key configured. Set a key in the integration config."
          );
        }
        return fetchOpenAiModels(apiKey);
      }
      // Subscription mode: the OpenAI models API is not reliably reachable
      // with a ChatGPT access token, so discover models from the Codex CLI's
      // own live catalog instead of a hand-maintained list.
      return fetchCodexSubscriptionModels();
    },
    getSummaryDetails(_config: Record<string, unknown>): string[] {
      return [];
    },
    capabilities: {
      agent_execution: {
        reviewStrategies: [
          {
            id: "codex_native",
            label: "Codex native review",
            description:
              "Delegate analysis to a Codex-native subagent within one exec session; the parent submits the result.",
            experimental: true,
            modelSelection: "provider",
            requiredSystemPromptId: "system_review",
          },
        ],
        configFields: [
          {
            key: "reasoningEffort",
            label: "Reasoning Effort",
            type: "select",
            required: false,
            options: [
              { value: "minimal", label: "Minimal" },
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
              { value: "xhigh", label: "Extra high" },
            ],
          },
        ],
        // No model default is passed: when the agent config leaves the model
        // unset, the Codex CLI selects its own default.
        buildAdapter: (context) =>
          new CodexAdapter({
            maxCommitsPerCycle: context.maxCommitsPerCycle,
          }),
      },
    },
  };
}
