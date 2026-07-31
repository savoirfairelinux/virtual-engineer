import { z } from "zod";
import type { ProviderDescriptor } from "../registry.js";
import { ModelDiscoveryConfigError } from "../registry.js";
import { GooseAdapter } from "../../agents/gooseAdapter.js";
import {
  validateGooseConnection,
  type GooseConnectionValidationConfig,
} from "../../agents/gooseConnectionValidator.js";
import { fetchGooseModels } from "../../agents/gooseModelsService.js";

/**
 * Goose (https://goose-docs.ai) integration descriptor.
 *
 * Goose is a Rust CLI agent from the AAIF that wraps any LLM provider. A single
 * integration selects a provider (`gooseProvider`) and carries that provider's
 * API key / base URL. The chosen model lives on the `agents` table, not the
 * integration config, and is passed to the CLI via the `GOOSE_MODEL` env var.
 *
 * Goose reads provider API keys from the environment (never from config.yaml).
 * Supported providers:
 *  - `anthropic`     — Anthropic API (`ANTHROPIC_API_KEY`).
 *  - `openai`        — OpenAI API (`OPENAI_API_KEY`).
 *  - `openrouter`    — OpenRouter (`OPENROUTER_API_KEY`).
 *  - `ollama`        — local Ollama server (`OLLAMA_HOST`, no key needed).
 *  - `deepseek`      — DeepSeek (`DEEPSEEK_API_KEY`).
 *  - `groq`          — Groq (`GROQ_API_KEY`).
 *  - `gemini`        — Google Gemini (`GOOGLE_API_KEY`).
 *  - `azure_openai`  — Azure OpenAI (`AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT`).
 *  - `bedrock`       — Amazon Bedrock (AWS env credential chain; no key forwarded).
 *  - `perplexity`    — Perplexity (`PERPLEXITY_API_KEY`).
 *  - `mistral`       — Mistral AI (`MISTRAL_API_KEY`).
 *  - `xai`           — xAI Grok (`XAI_API_KEY`).
 *  - `cerebras`      — Cerebras (`CEREBRAS_API_KEY`).
 *  - `openai_compat` — any OpenAI-compatible endpoint (`OPENAI_API_KEY` + `OPENAI_API_BASE`).
 */
export const gooseConfigSchema = z.object({
  /** LLM provider selector. */
  gooseProvider: z
    .enum([
      "anthropic",
      "openai",
      "openrouter",
      "ollama",
      "deepseek",
      "groq",
      "gemini",
      "azure_openai",
      "bedrock",
      "perplexity",
      "mistral",
      "xai",
      "cerebras",
      "openai_compat",
    ])
    .default("anthropic"),
  /** API key for the selected provider (ollama/bedrock usually need none). */
  gooseApiKey: z.string().optional(),
  /** Custom API base URL (required for openai_compat and azure_openai; optional override for ollama). */
  gooseApiBase: z.string().optional(),
  /** Accepted but discarded — the model lives on the agents table. */
  model: z.string().optional().transform(() => undefined),
});

export type GoosePluginConfig = z.infer<typeof gooseConfigSchema>;

/** Returns the Goose plugin descriptor. `adminAuthSecret` is accepted for API parity with the other provider factories but is unused — Goose stores API keys plaintext at rest (like Aider). */
export function createGooseDescriptor(_adminAuthSecret?: string): ProviderDescriptor {
  return {
    provider: "goose",
    name: "Goose",
    icon: { slug: "goose", hex: "6B7FD7" },
    configSchema: gooseConfigSchema,
    validateFullConfigOnCreate: true,
    requiredFields: [
      {
        key: "gooseProvider",
        label: "LLM Provider",
        type: "select",
        required: true,
        options: [
          { value: "anthropic", label: "Anthropic" },
          { value: "openai", label: "OpenAI" },
          { value: "openrouter", label: "OpenRouter" },
          { value: "ollama", label: "Ollama (local)" },
          { value: "deepseek", label: "DeepSeek" },
          { value: "groq", label: "Groq" },
          { value: "gemini", label: "Google Gemini" },
          { value: "azure_openai", label: "Azure OpenAI" },
          { value: "bedrock", label: "Amazon Bedrock (AWS env)" },
          { value: "perplexity", label: "Perplexity" },
          { value: "mistral", label: "Mistral AI" },
          { value: "xai", label: "xAI (Grok)" },
          { value: "cerebras", label: "Cerebras" },
          { value: "openai_compat", label: "OpenAI-compatible (custom base URL)" },
        ],
      },
      {
        key: "gooseApiKey",
        label: "API Key",
        type: "password",
        required: false,
        placeholder: "API key (leave empty for keyless providers, e.g. Ollama / Bedrock)",
      },
      {
        key: "gooseApiBase",
        label: "API Base URL",
        type: "url",
        required: false,
        placeholder: "http://hostname:port  — base URL for the LLM provider (required for openai_compat / azure_openai; optional for others)",
      },
    ],
    testConnection: (config) =>
      validateGooseConnection(config as GooseConnectionValidationConfig, {}),
    discoverModels: async (config): Promise<Array<{ id: string; name: string }>> => {
      const cfg = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
      const provider = typeof cfg["gooseProvider"] === "string" ? cfg["gooseProvider"] : "anthropic";
      const apiKey = typeof cfg["gooseApiKey"] === "string" ? cfg["gooseApiKey"].trim() : "";
      const apiBase = typeof cfg["gooseApiBase"] === "string" ? cfg["gooseApiBase"].trim() : "";

      // Ollama and Bedrock need no key; the other providers do.
      if (provider !== "ollama" && provider !== "bedrock" && !apiKey) {
        throw new ModelDiscoveryConfigError(
          "No API key configured for the selected Goose provider. Set a key in the integration config."
        );
      }
      if ((provider === "openai_compat" || provider === "azure_openai") && !apiBase) {
        throw new ModelDiscoveryConfigError(
          provider === "openai_compat"
            ? "No API base URL configured for the openai-compatible Goose provider."
            : "No Azure OpenAI endpoint configured for the Goose provider."
        );
      }
      return fetchGooseModels({ gooseProvider: provider, gooseApiKey: apiKey, gooseApiBase: apiBase });
    },
    getSummaryDetails(_config: Record<string, unknown>): string[] {
      return [];
    },
    capabilities: {
      agent_execution: {
        reviewStrategies: [
          {
            id: "goose_native",
            label: "Goose native review",
            description: "Run Goose's native agent review loop with the CLI managing model selection.",
            experimental: true,
            modelSelection: "provider",
            requiredSystemPromptId: "system_review",
          },
        ],
        configFields: [
          {
            key: "gooseMode",
            label: "Tool Mode",
            type: "select",
            required: false,
            options: [
              { value: "auto", label: "Auto (run tools without asking)" },
              { value: "approve", label: "Approve (ask before each tool)" },
              { value: "chat", label: "Chat (no tools)" },
              { value: "smart_approve", label: "Smart Approve" },
            ],
          },
          { key: "gooseMaxTurns", label: "Max Turns", type: "number", valueType: "number", required: false },
          { key: "gooseMaxTokens", label: "Max Tokens", type: "number", valueType: "number", required: false },
          { key: "gooseTemperature", label: "Temperature", type: "number", valueType: "number", required: false },
          { key: "gooseAutoCompactThreshold", label: "Auto-Compact Threshold", type: "number", valueType: "number", required: false },
        ],
        // No model default is passed: when the agent config leaves the model
        // unset, the Goose CLI selects its own default.
        buildAdapter: (context) =>
          new GooseAdapter({
            maxCommitsPerCycle: context.maxCommitsPerCycle,
            dockerNetwork: context.dockerNetwork,
          }),
      },
    },
  };
}