/**
 * Goose models service.
 *
 * Goose is a Rust CLI (https://goose-docs.ai) that wraps any LLM provider. This
 * service discovers available models for a configured Goose integration by
 * querying the upstream provider's models endpoint (or Ollama's `/api/tags`).
 * The chosen model is stored on the `agents` table and passed to the CLI via the
 * `GOOSE_MODEL` env var.
 *
 * Supported providers: anthropic, openai, openrouter, ollama, deepseek, groq,
 * gemini, azure_openai, bedrock (env-only — no discovery), perplexity, mistral,
 * xai, cerebras, openai_compat (custom OpenAI-compatible base URL).
 */
import { getLogger } from "../logger.js";

const log = getLogger("goose-models-service");

export type GooseProvider =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "ollama"
  | "deepseek"
  | "groq"
  | "gemini"
  | "azure_openai"
  | "bedrock"
  | "perplexity"
  | "mistral"
  | "xai"
  | "cerebras"
  | "openai_compat";

export interface GooseModelsConfig {
  gooseProvider?: string | undefined;
  gooseApiKey?: string | undefined;
  gooseApiBase?: string | undefined;
}

export interface GooseModelsServiceDependencies {
  fetch?: typeof globalThis.fetch | undefined;
}

interface DiscoveredModel {
  id: string;
  name: string;
}

const DEFAULT_OLLAMA_BASE = "http://127.0.0.1:11434";

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";

/** Fetch the list of models available to a configured Goose provider. */
export async function fetchGooseModels(
  config: GooseModelsConfig,
  deps: GooseModelsServiceDependencies = {}
): Promise<DiscoveredModel[]> {
  const provider = (config.gooseProvider ?? "anthropic") as GooseProvider;
  const apiKey = config.gooseApiKey?.trim() ?? "";
  const apiBase = config.gooseApiBase?.trim() ?? "";

  switch (provider) {
    case "anthropic":
      return fetchAnthropicModels(apiKey, deps);
    case "openai":
      return fetchOpenAIStyleModels("https://api.openai.com/v1/models", apiKey, deps);
    case "openrouter":
      return fetchOpenAIStyleModels("https://openrouter.ai/api/v1/models", apiKey, deps);
    case "ollama":
      return fetchOllamaModels(apiBase || DEFAULT_OLLAMA_BASE, deps);
    case "deepseek":
      return fetchOpenAIStyleModels("https://api.deepseek.com/models", apiKey, deps);
    case "groq":
      return fetchOpenAIStyleModels("https://api.groq.com/openai/v1/models", apiKey, deps);
    case "gemini":
      return fetchGeminiModels(apiKey, deps);
    case "azure_openai": {
      if (!apiBase) {
        throw new Error("No Azure OpenAI endpoint configured for the Goose provider.");
      }
      return fetchAzureOpenAIModels(apiBase, apiKey, deps);
    }
    case "bedrock":
      // Bedrock models are discovered via the AWS SDK, not a simple HTTP call.
      // Return an empty list — the operator must enter the model id manually.
      log.info("Bedrock model discovery is not supported; enter the model id manually.");
      return [];
    case "perplexity":
      return fetchOpenAIStyleModels("https://api.perplexity.ai/models", apiKey, deps);
    case "mistral":
      return fetchOpenAIStyleModels("https://api.mistral.ai/v1/models", apiKey, deps);
    case "xai":
      return fetchOpenAIStyleModels("https://api.x.ai/v1/models", apiKey, deps);
    case "cerebras":
      return fetchOpenAIStyleModels("https://api.cerebras.ai/v1/models", apiKey, deps);
    case "openai_compat": {
      if (!apiBase) {
        throw new Error("No API base URL configured for the openai-compatible Goose provider.");
      }
      const base = apiBase.replace(/\/+$/, "");
      return fetchOpenAIStyleModels(`${base}/v1/models`, apiKey, deps);
    }
    default:
      throw new Error(`Unknown Goose provider "${String(provider)}".`);
  }
}

/** OpenAI-style `/v1/models` (OpenAI, OpenRouter, DeepSeek, Groq, Perplexity, Mistral, xAI, Cerebras, OpenAI-compatible). */
async function fetchOpenAIStyleModels(
  url: string,
  apiKey: string,
  deps: GooseModelsServiceDependencies
): Promise<DiscoveredModel[]> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const res = await fetchFn(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "User-Agent": "virtual-engineer",
    },
  });
  if (!res.ok) {
    throw new Error(`Goose models request failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { data?: Array<{ id?: string; name?: string }> };
  const models = (data.data ?? [])
    .map((m): DiscoveredModel | null => {
      const id = typeof m.id === "string" ? m.id.trim() : "";
      if (!id) return null;
      const name = typeof m.name === "string" && m.name.trim() ? m.name.trim() : id;
      return { id, name };
    })
    .filter((m): m is DiscoveredModel => m !== null);
  log.info({ count: models.length, url }, "discovered OpenAI-style models for Goose");
  return models;
}

/** Anthropic `/v1/models` (uses `x-api-key` + `anthropic-version`). */
async function fetchAnthropicModels(
  apiKey: string,
  deps: GooseModelsServiceDependencies
): Promise<DiscoveredModel[]> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const res = await fetchFn(ANTHROPIC_MODELS_URL, {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      Accept: "application/json",
      "User-Agent": "virtual-engineer",
    },
  });
  if (!res.ok) {
    throw new Error(`Goose models request failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { data?: Array<{ id?: string; display_name?: string }> };
  const models = (data.data ?? [])
    .map((m): DiscoveredModel | null => {
      const id = typeof m.id === "string" ? m.id.trim() : "";
      if (!id) return null;
      const name =
        typeof m.display_name === "string" && m.display_name.trim() ? m.display_name.trim() : id;
      return { id, name };
    })
    .filter((m): m is DiscoveredModel => m !== null);
  log.info({ count: models.length }, "discovered Anthropic models for Goose");
  return models;
}

/** Ollama `/api/tags` (no auth; maps `models[].name` → `ollama_chat/<name>`). */
async function fetchOllamaModels(
  base: string,
  deps: GooseModelsServiceDependencies
): Promise<DiscoveredModel[]> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const url = `${base.replace(/\/+$/, "")}/api/tags`;
  const res = await fetchFn(url, {
    method: "GET",
    headers: { Accept: "application/json", "User-Agent": "virtual-engineer" },
  });
  if (!res.ok) {
    throw new Error(`Goose models request failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { models?: Array<{ name?: string }> };
  const models = (data.models ?? [])
    .map((m): DiscoveredModel | null => {
      const name = typeof m.name === "string" ? m.name.trim() : "";
      if (!name) return null;
      // Goose's Ollama provider expects the `ollama_chat/` prefix (litellm convention).
      return { id: `ollama_chat/${name}`, name };
    })
    .filter((m): m is DiscoveredModel => m !== null);
  log.info({ count: models.length, url }, "discovered Ollama models for Goose");
  return models;
}

/** Google Gemini `/v1/models` (uses `key` query param). */
async function fetchGeminiModels(
  apiKey: string,
  deps: GooseModelsServiceDependencies
): Promise<DiscoveredModel[]> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const url = `https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(apiKey)}`;
  const res = await fetchFn(url, {
    method: "GET",
    headers: { Accept: "application/json", "User-Agent": "virtual-engineer" },
  });
  if (!res.ok) {
    throw new Error(`Goose models request failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { models?: Array<{ name?: string; displayName?: string }> };
  const models = (data.models ?? [])
    .map((m): DiscoveredModel | null => {
      const rawName = typeof m.name === "string" ? m.name.trim() : "";
      if (!rawName) return null;
      // Gemini returns "models/gemini-1.5-flash" — strip the "models/" prefix.
      const id = rawName.startsWith("models/") ? rawName.slice("models/".length) : rawName;
      const displayName =
        typeof m.displayName === "string" && m.displayName.trim() ? m.displayName.trim() : id;
      return { id, name: displayName };
    })
    .filter((m): m is DiscoveredModel => m !== null);
  log.info({ count: models.length }, "discovered Gemini models for Goose");
  return models;
}

/** Azure OpenAI `/openai/models` (uses `api-key` header). */
async function fetchAzureOpenAIModels(
  endpoint: string,
  apiKey: string,
  deps: GooseModelsServiceDependencies
): Promise<DiscoveredModel[]> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const url = `${endpoint.replace(/\/+$/, "")}/openai/models?api-version=2024-10-21`;
  const res = await fetchFn(url, {
    method: "GET",
    headers: { "api-key": apiKey, Accept: "application/json", "User-Agent": "virtual-engineer" },
  });
  if (!res.ok) {
    throw new Error(`Goose models request failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { data?: Array<{ id?: string }> };
  const models = (data.data ?? [])
    .map((m): DiscoveredModel | null => {
      const id = typeof m.id === "string" ? m.id.trim() : "";
      if (!id) return null;
      return { id, name: id };
    })
    .filter((m): m is DiscoveredModel => m !== null);
  log.info({ count: models.length, url }, "discovered Azure OpenAI models for Goose");
  return models;
}