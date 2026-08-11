/**
 * Gemini CLI models service.
 *
 * Discovers available models from the Gemini Developer API's `/v1beta/models`
 * endpoint (also used by Vertex AI Express Mode). The chosen model is stored
 * on the `agents` table and passed to the CLI via `--model`.
 */
import { getLogger } from "../logger.js";

const log = getLogger("gemini-models-service");

const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export interface GeminiModelsServiceDependencies {
  fetch?: typeof globalThis.fetch | undefined;
}

interface RawGeminiModel {
  name?: string | undefined;
  displayName?: string | undefined;
}

interface GeminiModelsResponse {
  models?: RawGeminiModel[] | undefined;
}

/** Fetch the list of models available to a Gemini API key. */
export async function fetchGeminiModels(
  apiKey: string,
  deps: GeminiModelsServiceDependencies = {}
): Promise<Array<{ id: string; name: string }>> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const url = `${GEMINI_MODELS_URL}?key=${encodeURIComponent(apiKey)}`;
  const res = await fetchFn(url, {
    method: "GET",
    headers: { Accept: "application/json", "User-Agent": "virtual-engineer" },
  });

  if (!res.ok) {
    throw new Error(`Gemini models request failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as GeminiModelsResponse;
  const models = (data.models ?? [])
    .map((m) => {
      const rawName = typeof m.name === "string" ? m.name.trim() : "";
      const id = rawName.startsWith("models/") ? rawName.slice("models/".length) : rawName;
      const name = typeof m.displayName === "string" && m.displayName ? m.displayName : id;
      return id ? { id, name } : null;
    })
    .filter((m): m is { id: string; name: string } => m !== null);

  log.info({ count: models.length }, "discovered Gemini models");
  return models;
}
