import { z } from "zod";
import type { ProviderDescriptor } from "../registry.js";
import { ModelDiscoveryConfigError } from "../registry.js";
import { AiderAdapter } from "../../agents/aiderAdapter.js";
import {
  validateAiderConnection,
  type AiderConnectionValidationConfig,
} from "../../agents/aiderConnectionValidator.js";
import { fetchAiderModels } from "../../agents/aiderModelsService.js";

/**
 * Aider (https://aider.chat) integration descriptor.
 *
 * Aider is a Python CLI that wraps any LLM backend via litellm. A single
 * integration selects a backend (`aiderBackend`) and carries that backend's
 * API key / base URL. The chosen model lives on the `agents` table, not the
 * integration config, and is passed to the CLI via the `AIDER_MODEL` env var.
 *
 * Supported backends:
 *  - `openai`       — OpenAI API (`OPENAI_API_KEY`).
 *  - `anthropic`    — Anthropic API (`ANTHROPIC_API_KEY`).
 *  - `ollama`        — local Ollama server (`OLLAMA_API_BASE`, no key needed).
 *  - `openrouter`   — OpenRouter (`OPENROUTER_API_KEY`).
 *  - `deepseek`     — DeepSeek (`DEEPSEEK_API_KEY`).
 *  - `openai_compat`— any OpenAI-compatible endpoint (`OPENAI_API_KEY` + `OPENAI_API_BASE`).
 */
export const aiderConfigSchema = z.object({
  /** LLM backend selector. */
  aiderBackend: z
    .enum(["openai", "anthropic", "ollama", "openrouter", "deepseek", "openai_compat"])
    .default("openai"),
  /** API key for the selected backend (ollama usually needs none). */
  aiderApiKey: z.string().optional(),
  /** Custom API base URL (required for openai_compat; optional override for ollama). */
  aiderApiBase: z.string().optional(),
  /** Accepted but discarded — the model lives on the agents table. */
  model: z.string().optional().transform(() => undefined),
});

export type AiderPluginConfig = z.infer<typeof aiderConfigSchema>;

/** Returns the Aider plugin descriptor. `adminAuthSecret` is captured for the `testConnection` hook. */
export function createAiderDescriptor(_adminAuthSecret?: string): ProviderDescriptor {
  return {
    provider: "aider",
    name: "Aider",
    icon: { slug: "aider", hex: "FF6B35" },
    configSchema: aiderConfigSchema,
    validateFullConfigOnCreate: true,
    requiredFields: [
      {
        key: "aiderBackend",
        label: "LLM Backend",
        type: "select",
        required: true,
        options: [
          { value: "openai", label: "OpenAI" },
          { value: "anthropic", label: "Anthropic" },
          { value: "ollama", label: "Ollama (local)" },
          { value: "openrouter", label: "OpenRouter" },
          { value: "deepseek", label: "DeepSeek" },
          { value: "openai_compat", label: "OpenAI-compatible (custom base URL)" },
        ],
      },
      {
        key: "aiderApiKey",
        label: "API Key",
        type: "password",
        required: false,
        placeholder: "API key (leave empty for keyless backends, e.g. Ollama)",
      },
      {
        key: "aiderApiBase",
        label: "API Base URL",
        type: "url",
        required: false,
        placeholder: "http://hostname:11434  — optional for Ollama (defaults to http://127.0.0.1:11434); required for OpenAI-compatible endpoints",
      },
    ],
    testConnection: (config) =>
      validateAiderConnection(config as AiderConnectionValidationConfig, {}),
    discoverModels: async (config): Promise<Array<{ id: string; name: string }>> => {
      const cfg = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
      const backend = typeof cfg["aiderBackend"] === "string" ? cfg["aiderBackend"] : "openai";
      const apiKey = typeof cfg["aiderApiKey"] === "string" ? cfg["aiderApiKey"].trim() : "";
      const apiBase = typeof cfg["aiderApiBase"] === "string" ? cfg["aiderApiBase"].trim() : "";

      // Ollama needs no key; the other backends do.
      if (backend !== "ollama" && !apiKey) {
        throw new ModelDiscoveryConfigError(
          "No API key configured for the selected Aider backend. Set a key in the integration config."
        );
      }
      if (backend === "openai_compat" && !apiBase) {
        throw new ModelDiscoveryConfigError(
          "No API base URL configured for the openai-compatible backend."
        );
      }
      return fetchAiderModels({ aiderBackend: backend, aiderApiKey: apiKey, aiderApiBase: apiBase });
    },
    getSummaryDetails(_config: Record<string, unknown>): string[] {
      return [];
    },
    capabilities: {
      agent_execution: {
        // No model default is passed: when the agent config leaves the model
        // unset, the Aider CLI selects its own default.
        buildAdapter: (context) =>
          new AiderAdapter({
            maxCommitsPerCycle: context.maxCommitsPerCycle,
            dockerNetwork: context.dockerNetwork,
          }),
      },
    },
  };
}