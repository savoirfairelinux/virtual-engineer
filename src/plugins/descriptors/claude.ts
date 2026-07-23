import { z } from "zod";
import type { ProviderDescriptor } from "../registry.js";
import { ModelDiscoveryConfigError } from "../registry.js";
import { ClaudeAdapter } from "../../agents/claudeAdapter.js";
import {
  validateClaudeConnection,
  type ClaudeConnectionValidationConfig,
} from "../../agents/claudeConnectionValidator.js";
import { CLAUDE_SUBSCRIPTION_MODELS, fetchAnthropicModels } from "../../agents/claudeModelsService.js";
import { createClaudeRedirectOAuthHandler } from "./claudeOAuth.js";

/**
 * Claude (Anthropic Claude Code) integration descriptor.
 *
 * Two ways of connecting:
 *  - `api_key`      — an Anthropic API key (`ANTHROPIC_API_KEY`).
 *  - `subscription` — a Claude Pro/Max OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`),
 *                     obtained through the interactive OAuth flow (stored,
 *                     encrypted, in `sessionToken`).
 * The chosen model lives on the `agents` table, not the integration config.
 */
export const claudeConfigSchema = z.object({
  /** Auth mode: Anthropic API key or Claude subscription OAuth token. */
  authMode: z.enum(["api_key", "subscription"]).default("api_key"),
  /** Anthropic API key entered directly (api_key mode). */
  apiKey: z.string().optional(),
  /** Encrypted OAuth token written by the interactive OAuth flow (not user-entered). */
  sessionToken: z.string().optional(),
  /** Accepted but discarded — the model lives on the agents table. */
  model: z.string().optional().transform(() => undefined),
});

export type ClaudePluginConfig = z.infer<typeof claudeConfigSchema>;

/** Returns the Claude plugin descriptor. `adminAuthSecret` is captured for the `testConnection` hook. */
export function createClaudeDescriptor(adminAuthSecret?: string): ProviderDescriptor {
  return {
    provider: "claude",
    name: "Claude Code",
    icon: { slug: "claude", hex: "D97757" },
    configSchema: claudeConfigSchema,
    validateFullConfigOnCreate: true,
    requiredFields: [
      {
        key: "authMode",
        label: "Auth Mode",
        type: "select",
        required: true,
        options: [
          { value: "api_key", label: "Anthropic API Key" },
          { value: "subscription", label: "Claude Subscription (OAuth)" },
        ],
      },
      {
        key: "apiKey",
        label: "Anthropic API Key",
        type: "password",
        required: false,
        placeholder: "sk-ant-…",
        dependsOn: { field: "authMode", value: "api_key" },
      },
      // sessionToken is hidden: written by the interactive OAuth flow, masked on read, preserved on update.
      {
        key: "sessionToken",
        label: "Session Token",
        type: "password",
        required: false,
        hidden: true,
      },
    ],
    oauth: {
      mode: "redirect",
      tokenField: "sessionToken",
      dependsOn: { field: "authMode", value: "subscription" },
      providerName: "Claude",
      heading: "Claude Subscription Authentication",
      connectLabel: "Connect with Claude",
      reconnectLabel: "Re-connect",
      pendingLabel: "Waiting…",
      // Redirect (authorization-code + PKCE) flow: the generic admin OAuth route
      // (`/api/admin/plugins/:type/oauth/:action`) serves the `start`/`complete` actions.
      startPath: "/api/admin/plugins/claude/oauth/start",
      completePath: "/api/admin/plugins/claude/oauth/complete",
    },
    createOAuthHandler: (config) => createClaudeRedirectOAuthHandler(config),
    testConnection: (config) =>
      validateClaudeConnection(config as ClaudeConnectionValidationConfig, { adminAuthSecret }),
    discoverModels: async (config): Promise<Array<{ id: string; name: string }>> => {
      const cfg = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
      const authMode = typeof cfg["authMode"] === "string" ? cfg["authMode"] : "api_key";
      if (authMode === "api_key") {
        const apiKey = typeof cfg["apiKey"] === "string" ? cfg["apiKey"].trim() : "";
        if (!apiKey) {
          throw new ModelDiscoveryConfigError(
            "No Anthropic API key configured. Set a key in the integration config."
          );
        }
        return fetchAnthropicModels(apiKey);
      }
      // Subscription mode: the models API is not reliably reachable with a
      // subscription token, so offer a curated list of Claude model aliases.
      return CLAUDE_SUBSCRIPTION_MODELS;
    },
    getSummaryDetails(_config: Record<string, unknown>): string[] {
      return [];
    },
    capabilities: {
      agent_execution: {
        configFields: [
          {
            key: "effort",
            label: "Effort",
            type: "select",
            required: false,
            options: [
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
              { value: "xhigh", label: "Extra high" },
              { value: "max", label: "Maximum" },
            ],
          },
          {
            key: "thinkingMode",
            label: "Thinking Mode",
            type: "select",
            required: false,
            options: [
              { value: "adaptive", label: "Adaptive" },
              { value: "enabled", label: "Fixed budget" },
              { value: "disabled", label: "Disabled" },
            ],
          },
          {
            key: "thinkingBudgetTokens",
            label: "Thinking Token Budget",
            type: "number",
            valueType: "number",
            required: false,
            dependsOn: { field: "thinkingMode", value: "enabled" },
          },
          { key: "maxTurns", label: "Maximum Turns", type: "number", valueType: "number", required: false },
          { key: "maxBudgetUsd", label: "Maximum Cost (USD)", type: "number", valueType: "number", required: false },
        ],
        // No model default is passed: when the agent config leaves the model
        // unset, the Claude CLI selects its own default.
        buildAdapter: (context) =>
          new ClaudeAdapter({
            maxCommitsPerCycle: context.maxCommitsPerCycle,
            dockerNetwork: context.dockerNetwork,
          }),
      },
    },
  };
}
