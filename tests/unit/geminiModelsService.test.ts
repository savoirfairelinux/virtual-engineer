import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchGeminiModels } from "../../src/agents/geminiModelsService.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchGeminiModels", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches models with the key as a query param and strips the models/ prefix", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ models: [{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" }] })
    );
    const models = await fetchGeminiModels(
      { authMode: "api_key", apiKey: "gemini-key" },
      { fetch: fetchFn as unknown as typeof globalThis.fetch }
    );
    expect(models).toEqual([{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models?key=gemini-key",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("throws on a non-ok response", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, 500));
    await expect(
      fetchGeminiModels(
        { authMode: "api_key", apiKey: "gemini-key" },
        { fetch: fetchFn as unknown as typeof globalThis.fetch }
      )
    ).rejects.toThrow("HTTP 500");
  });

  it("falls back to the id when displayName is absent", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ models: [{ name: "models/gemini-2.5-flash" }] }));
    const models = await fetchGeminiModels(
      { authMode: "api_key", apiKey: "gemini-key" },
      { fetch: fetchFn as unknown as typeof globalThis.fetch }
    );
    expect(models).toEqual([{ id: "gemini-2.5-flash", name: "gemini-2.5-flash" }]);
  });

  it("filters out entries without a usable id", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ models: [{ name: "" }, { name: "models/gemini-2.5-pro" }] }));
    const models = await fetchGeminiModels(
      { authMode: "api_key", apiKey: "gemini-key" },
      { fetch: fetchFn as unknown as typeof globalThis.fetch }
    );
    expect(models).toEqual([{ id: "gemini-2.5-pro", name: "gemini-2.5-pro" }]);
  });

  it("discovers publisher models from the configured regional Vertex backend", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        publisherModels: [
          {
            name: "publishers/google/models/gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
          },
        ],
      })
    );

    const models = await fetchGeminiModels(
      {
        authMode: "vertex_ai",
        apiKey: "vertex-key",
        googleCloudProject: "my-project",
        googleCloudLocation: "europe-west4",
      },
      { fetch: fetchFn as unknown as typeof globalThis.fetch }
    );

    expect(models).toEqual([{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://europe-west4-aiplatform.googleapis.com/v1beta1/publishers/google/models",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-goog-api-key": "vertex-key" }),
      })
    );
  });
});
