/**
 * Codex models service.
 *
 * For API-key integrations, discovers available models from the OpenAI
 * `/v1/models` endpoint. For subscription (access-token) integrations that
 * endpoint is not reachable with a ChatGPT-managed token, so a curated static
 * list of known Codex-capable model ids is returned instead. The chosen model
 * is stored on the `agents` table and passed to the CLI via `--model`.
 */
import { getLogger } from "../logger.js";

const log = getLogger("codex-models-service");

const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

export interface CodexModelsServiceDependencies {
  fetch?: typeof globalThis.fetch | undefined;
}

interface RawOpenAiModel {
  id?: string | undefined;
}

interface OpenAiModelsResponse {
  data?: RawOpenAiModel[] | undefined;
}

/**
 * Curated Codex model ids offered for subscription (access-token) integrations.
 * These drift as OpenAI ships new models — verify against the installed Codex
 * CLI's `codex debug models` output before relying on this list in production.
 */
export const CODEX_SUBSCRIPTION_MODELS: Array<{ id: string; name: string }> = [
  { id: "gpt-5.1-codex-max", name: "GPT-5.1 Codex Max" },
  { id: "gpt-5.5", name: "GPT-5.5" },
];

/** Fetch the list of models available to an OpenAI API key. */
export async function fetchOpenAiModels(
  apiKey: string,
  deps: CodexModelsServiceDependencies = {}
): Promise<Array<{ id: string; name: string }>> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const res = await fetchFn(OPENAI_MODELS_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "User-Agent": "virtual-engineer",
    },
  });

  if (!res.ok) {
    throw new Error(`OpenAI models request failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as OpenAiModelsResponse;
  const models = (data.data ?? [])
    .map((m) => {
      const id = typeof m.id === "string" ? m.id.trim() : "";
      return id ? { id, name: id } : null;
    })
    .filter((m): m is { id: string; name: string } => m !== null);

  log.info({ count: models.length }, "discovered OpenAI models");
  return models;
}
