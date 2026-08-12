/**
 * Cursor models service.
 *
 * Cursor exposes a real REST endpoint for model discovery
 * (`GET https://api.cursor.com/v1/models`, the Cloud Agents API), unlike
 * Codex/Gemini which needed a curated static fallback. These are Cloud Agents
 * API model ids; they should be verified against the local CLI's actual
 * accepted `--model` values before fully trusting parity (the CLI's own
 * `/model` slash command examples use a similarly-shaped but not guaranteed
 * identical id format — see .github/copilot-instructions.md "Further
 * Considerations").
 */
const CURSOR_MODELS_URL = "https://api.cursor.com/v1/models";

export interface CursorModelsServiceDependencies {
  fetch?: typeof globalThis.fetch | undefined;
}

interface RawCursorModel {
  id?: string | undefined;
  displayName?: string | undefined;
}

interface CursorModelsResponse {
  items?: RawCursorModel[] | undefined;
}

/** Fetch the list of models available to a Cursor API key. */
export async function fetchCursorModels(
  apiKey: string,
  deps: CursorModelsServiceDependencies = {}
): Promise<Array<{ id: string; name: string }>> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const res = await fetchFn(CURSOR_MODELS_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "User-Agent": "virtual-engineer",
    },
  });

  if (!res.ok) {
    throw new Error(`Cursor models request failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as CursorModelsResponse;
  const models = (data.items ?? [])
    .map((m) => {
      const id = typeof m.id === "string" ? m.id.trim() : "";
      if (!id) return null;
      const name = typeof m.displayName === "string" && m.displayName.trim() ? m.displayName.trim() : id;
      return { id, name };
    })
    .filter((m): m is { id: string; name: string } => m !== null);

  return models;
}
