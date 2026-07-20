/**
 * Aider models service.
 *
 * Aider is a Python CLI that wraps any LLM backend via litellm. This service
 * discovers available models for a configured Aider integration by querying
 * the upstream provider's models endpoint (or Ollama's `/api/tags`). The chosen
 * model is stored on the `agents` table and passed to the CLI via the
 * `AIDER_MODEL` env var.
 *
 * Supported backends: openai, anthropic, ollama, openrouter, deepseek,
 * openai_compat (custom OpenAI-compatible base URL).
 */
import { getLogger } from "../logger.js";

const log = getLogger("aider-models-service");

export type AiderBackend = "openai" | "anthropic" | "ollama" | "openrouter" | "deepseek" | "openai_compat";

export interface AiderModelsConfig {
  aiderBackend?: string | undefined;
  aiderApiKey?: string | undefined;
  aiderApiBase?: string | undefined;
}

export interface AiderModelsServiceDependencies {
  fetch?: typeof globalThis.fetch | undefined;
}

interface DiscoveredModel {
  id: string;
  name: string;
}

const DEFAULT_OLLAMA_BASE = "http://127.0.0.1:11434";

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";

/** Fetch the list of models available to a configured Aider backend. */
export async function fetchAiderModels(
  config: AiderModelsConfig,
  deps: AiderModelsServiceDependencies = {}
): Promise<DiscoveredModel[]> {
  const backend = (config.aiderBackend ?? "openai") as AiderBackend;
  const apiKey = config.aiderApiKey?.trim() ?? "";
  const apiBase = config.aiderApiBase?.trim() ?? "";

  switch (backend) {
    case "openai":
      return fetchOpenAIStyleModels("https://api.openai.com/v1/models", apiKey, deps);
    case "anthropic":
      return fetchAnthropicModels(apiKey, deps);
    case "ollama":
      return fetchOllamaModels(apiBase || DEFAULT_OLLAMA_BASE, deps);
    case "openrouter":
      return fetchOpenAIStyleModels("https://openrouter.ai/api/v1/models", apiKey, deps);
    case "deepseek":
      return fetchOpenAIStyleModels("https://api.deepseek.com/models", apiKey, deps);
    case "openai_compat": {
      if (!apiBase) {
        throw new Error("No API base URL configured for the openai-compatible backend.");
      }
      const base = apiBase.replace(/\/+$/, "");
      return fetchOpenAIStyleModels(`${base}/v1/models`, apiKey, deps);
    }
    default:
      throw new Error(`Unknown Aider backend "${backend}".`);
  }
}

/** OpenAI-style `/v1/models` (OpenAI, OpenRouter, DeepSeek, OpenAI-compatible). */
async function fetchOpenAIStyleModels(
  url: string,
  apiKey: string,
  deps: AiderModelsServiceDependencies
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
    throw new Error(`Aider models request failed: HTTP ${res.status}`);
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
  log.info({ count: models.length, url }, "discovered OpenAI-style models for Aider");
  return models;
}

/** Anthropic `/v1/models` (uses `x-api-key` + `anthropic-version`). */
async function fetchAnthropicModels(
  apiKey: string,
  deps: AiderModelsServiceDependencies
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
    throw new Error(`Aider models request failed: HTTP ${res.status}`);
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
  log.info({ count: models.length }, "discovered Anthropic models for Aider");
  return models;
}

/** Ollama `/api/tags` (no auth; maps `models[].name` → `ollama_chat/<name>`). */
async function fetchOllamaModels(
  base: string,
  deps: AiderModelsServiceDependencies
): Promise<DiscoveredModel[]> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const url = `${base.replace(/\/+$/, "")}/api/tags`;
  const res = await fetchFn(url, {
    method: "GET",
    headers: { Accept: "application/json", "User-Agent": "virtual-engineer" },
  });
  if (!res.ok) {
    throw new Error(`Aider models request failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { models?: Array<{ name?: string }> };
  const models = (data.models ?? [])
    .map((m): DiscoveredModel | null => {
      const name = typeof m.name === "string" ? m.name.trim() : "";
      if (!name) return null;
      // Aider recommends the `ollama_chat/` prefix over `ollama/`.
      return { id: `ollama_chat/${name}`, name };
    })
    .filter((m): m is DiscoveredModel => m !== null);
  log.info({ count: models.length, url }, "discovered Ollama models for Aider");
  return models;
}