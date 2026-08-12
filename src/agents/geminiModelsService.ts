/**
 * Gemini CLI models service.
 *
 * Discovers available models from the Gemini Developer API's `/v1beta/models`
 * endpoint (also used by Vertex AI Express Mode). The chosen model is stored
 * on the `agents` table and passed to the CLI via `--model`.
 */
import { getLogger } from "../logger.js";
import { buildGeminiModelsRequest, type GeminiApiRoutingConfig } from "./geminiApi.js";

const log = getLogger("gemini-models-service");

export interface GeminiModelsServiceDependencies {
  fetch?: typeof globalThis.fetch | undefined;
}

interface RawGeminiModel {
  name?: string | undefined;
  displayName?: string | undefined;
}

interface GeminiModelsResponse {
  models?: RawGeminiModel[] | undefined;
  publisherModels?: RawGeminiModel[] | undefined;
}

/** Fetch the list of models available to a Gemini API key. */
export async function fetchGeminiModels(
  config: GeminiApiRoutingConfig,
  deps: GeminiModelsServiceDependencies = {}
): Promise<Array<{ id: string; name: string }>> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const request = buildGeminiModelsRequest(config);
  const res = await fetchFn(request.url, {
    method: "GET",
    headers: request.headers,
  });

  if (!res.ok) {
    throw new Error(`Gemini models request failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as GeminiModelsResponse;
  const models = (data.publisherModels ?? data.models ?? [])
    .map((m) => {
      const rawName = typeof m.name === "string" ? m.name.trim() : "";
      const id = rawName
        .replace(/^publishers\/google\/models\//, "")
        .replace(/^models\//, "");
      const name = typeof m.displayName === "string" && m.displayName ? m.displayName : id;
      return id ? { id, name } : null;
    })
    .filter((m): m is { id: string; name: string } => m !== null);

  log.info({ count: models.length, authMode: config.authMode ?? "api_key" }, "discovered Gemini models");
  return models;
}
