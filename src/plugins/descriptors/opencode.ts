import { z } from "zod";
import type { ProviderDescriptor } from "../registry.js";
import { ModelDiscoveryConfigError } from "../registry.js";
import { OpenCodeAdapter } from "../../agents/opencodeAdapter.js";
import {
  validateOpenCodeConnection,
  type OpenCodeConnectionValidationConfig,
} from "../../agents/opencodeConnectionValidator.js";
import { fetchOpenCodeModels } from "../../agents/opencodeModelsService.js";

/**
 * OpenCode (https://opencode.ai) integration descriptor.
 *
 * OpenCode is an open-source terminal CLI agent that wraps any LLM provider
 * behind a `provider/model` selector — like Goose, a single integration
 * selects a provider (`openCodeProvider`) and carries that provider's API key
 * / base URL. The chosen model lives on the `agents` table, not the
 * integration config, and is combined with the provider selector into
 * `<provider>/<model>` for the CLI's `--model` flag.
 *
 * OpenCode reads provider API keys from the environment for scripted/headless
 * use (see https://opencode.ai/docs/providers). Supported providers:
 *  - `anthropic`     — Anthropic API (`ANTHROPIC_API_KEY`).
 *  - `openai`        — OpenAI API (`OPENAI_API_KEY`).
 *  - `openrouter`    — OpenRouter (`OPENROUTER_API_KEY`).
 *  - `ollama`        — local Ollama server (`OLLAMA_API_BASE`, no key needed).
 *  - `deepseek`      — DeepSeek (`DEEPSEEK_API_KEY`).
 *  - `groq`          — Groq (`GROQ_API_KEY`).
 *  - `gemini`        — Google Gemini (`GOOGLE_GENERATIVE_AI_API_KEY`).
 *  - `azure_openai`  — Azure OpenAI (`AZURE_OPENAI_API_KEY` + `AZURE_RESOURCE_NAME`).
 *  - `bedrock`       — Amazon Bedrock (AWS env credential chain; no key forwarded).
 *  - `perplexity`    — Perplexity (`PERPLEXITY_API_KEY`).
 *  - `mistral`       — Mistral AI (`MISTRAL_API_KEY`).
 *  - `xai`           — xAI Grok (`XAI_API_KEY`).
 *  - `cerebras`      — Cerebras (`CEREBRAS_API_KEY`).
 *  - `openai_compat` — any OpenAI-compatible endpoint (`OPENAI_API_KEY` + `OPENAI_API_BASE`).
 */
export const opencodeConfigSchema = z.object({
  /** LLM provider selector. */
  openCodeProvider: z
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
  openCodeApiKey: z.string().optional(),
  /** Custom API base URL (required for openai_compat and azure_openai; optional override for ollama). */
  openCodeApiBase: z.string().optional(),
  /** Accepted but discarded — the model lives on the agents table. */
  model: z.string().optional().transform(() => undefined),
});

export type OpenCodePluginConfig = z.infer<typeof opencodeConfigSchema>;

/** Returns the OpenCode plugin descriptor. `adminAuthSecret` is accepted for API parity with the other provider factories but is unused — OpenCode stores API keys plaintext at rest (like Aider/Goose). */
export function createOpenCodeDescriptor(_adminAuthSecret?: string): ProviderDescriptor {
  return {
    provider: "opencode",
    name: "OpenCode",
    icon: { slug: "opencode", hex: "000000" },
    configSchema: opencodeConfigSchema,
    validateFullConfigOnCreate: true,
    requiredFields: [
      {
        key: "openCodeProvider",
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
        key: "openCodeApiKey",
        label: "API Key",
        type: "password",
        required: false,
        placeholder: "API key (leave empty for keyless providers, e.g. Ollama / Bedrock)",
      },
      {
        key: "openCodeApiBase",
        label: "API Base URL",
        type: "url",
        required: false,
        placeholder: "http://hostname:port  — base URL for the LLM provider (required for openai_compat / azure_openai; optional for others)",
      },
    ],
    testConnection: (config) =>
      validateOpenCodeConnection(config as OpenCodeConnectionValidationConfig, {}),
    discoverModels: async (config): Promise<Array<{ id: string; name: string }>> => {
      const cfg = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
      const provider = typeof cfg["openCodeProvider"] === "string" ? cfg["openCodeProvider"] : "anthropic";
      const apiKey = typeof cfg["openCodeApiKey"] === "string" ? cfg["openCodeApiKey"].trim() : "";
      const apiBase = typeof cfg["openCodeApiBase"] === "string" ? cfg["openCodeApiBase"].trim() : "";

      // Ollama and Bedrock need no key; the other providers do.
      if (provider !== "ollama" && provider !== "bedrock" && !apiKey) {
        throw new ModelDiscoveryConfigError(
          "No API key configured for the selected OpenCode provider. Set a key in the integration config."
        );
      }
      if ((provider === "openai_compat" || provider === "azure_openai") && !apiBase) {
        throw new ModelDiscoveryConfigError(
          provider === "openai_compat"
            ? "No API base URL configured for the openai-compatible OpenCode provider."
            : "No Azure OpenAI endpoint configured for the OpenCode provider."
        );
      }
      return fetchOpenCodeModels({ openCodeProvider: provider, openCodeApiKey: apiKey, openCodeApiBase: apiBase });
    },
    getSummaryDetails(_config: Record<string, unknown>): string[] {
      return [];
    },
    capabilities: {
      agent_execution: {
        reviewStrategies: [
          {
            id: "opencode_native",
            label: "OpenCode native review",
            description: "Delegate analysis to OpenCode's own agent/task delegation; the parent submits via ve_submit_review.",
            experimental: true,
            modelSelection: "provider",
            requiredSystemPromptId: "system_review",
          },
        ],
        configFields: [
          {
            key: "variant",
            label: "Model Variant",
            type: "text",
            required: false,
            placeholder: "Optional provider-specific reasoning-effort variant (passed via --variant)",
          },
        ],
        // No model default is passed: when the agent config leaves the model
        // unset, the OpenCode CLI selects its own default.
        buildAdapter: (context) =>
          new OpenCodeAdapter({
            maxCommitsPerCycle: context.maxCommitsPerCycle,
          }),
      },
    },
  };
}
