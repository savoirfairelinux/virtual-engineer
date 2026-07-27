/**
 * Claude models service.
 *
 * For API-key integrations, discovers available models from the Anthropic
 * `/v1/models` endpoint. For subscription (OAuth) integrations the models API
 * is not reliably reachable with a subscription token, so a curated static list
 * of Claude model aliases is returned instead. The chosen model is stored on
 * the `agents` table and passed to the CLI via the `CLAUDE_MODEL` env var.
 */
import { getLogger } from "../logger.js";

const log = getLogger("claude-models-service");

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";

export interface ClaudeModelsServiceDependencies {
  fetch?: typeof globalThis.fetch | undefined;
}

interface RawAnthropicModel {
  id?: string | undefined;
  display_name?: string | undefined;
}

interface AnthropicModelsResponse {
  data?: RawAnthropicModel[] | undefined;
}

/**
 * Curated Claude model aliases offered for subscription (OAuth) integrations.
 * The Agent SDK resolves these aliases to concrete model IDs at runtime.
 */
export const CLAUDE_SUBSCRIPTION_MODELS: Array<{ id: string; name: string }> = [
  { id: "sonnet", name: "Claude Sonnet (latest)" },
  { id: "opus", name: "Claude Opus (latest)" },
  { id: "haiku", name: "Claude Haiku (latest)" },
];

/** Fetch the list of models available to an Anthropic API key. */
export async function fetchAnthropicModels(
  apiKey: string,
  deps: ClaudeModelsServiceDependencies = {}
): Promise<Array<{ id: string; name: string }>> {
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
    throw new Error(`Anthropic models request failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as AnthropicModelsResponse;
  const models = (data.data ?? [])
    .map((m) => {
      const id = typeof m.id === "string" ? m.id.trim() : "";
      if (!id) return null;
      const name = typeof m.display_name === "string" && m.display_name.trim() ? m.display_name.trim() : id;
      return { id, name };
    })
    .filter((m): m is { id: string; name: string } => m !== null);

  log.info({ count: models.length }, "discovered Anthropic models");
  return models;
}
