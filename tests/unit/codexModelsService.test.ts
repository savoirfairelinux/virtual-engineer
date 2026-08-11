import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchOpenAiModels, CODEX_SUBSCRIPTION_MODELS } from "../../src/agents/codexModelsService.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchOpenAiModels", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches models with a bearer token", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ data: [{ id: "gpt-5.5" }] }));
    const models = await fetchOpenAiModels("sk-openai-key", { fetch: fetchFn as unknown as typeof globalThis.fetch });
    expect(models).toEqual([{ id: "gpt-5.5", name: "gpt-5.5" }]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({ method: "GET", headers: expect.objectContaining({ Authorization: "Bearer sk-openai-key" }) })
    );
  });

  it("throws on a non-ok response", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, 500));
    await expect(
      fetchOpenAiModels("sk-openai-key", { fetch: fetchFn as unknown as typeof globalThis.fetch })
    ).rejects.toThrow("HTTP 500");
  });

  it("filters out entries without a usable id", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ data: [{ id: "" }, { id: "gpt-5.5" }] }));
    const models = await fetchOpenAiModels("sk-openai-key", { fetch: fetchFn as unknown as typeof globalThis.fetch });
    expect(models).toEqual([{ id: "gpt-5.5", name: "gpt-5.5" }]);
  });
});

describe("CODEX_SUBSCRIPTION_MODELS", () => {
  it("is a non-empty curated list", () => {
    expect(CODEX_SUBSCRIPTION_MODELS.length).toBeGreaterThan(0);
    for (const model of CODEX_SUBSCRIPTION_MODELS) {
      expect(model.id).toBeTruthy();
      expect(model.name).toBeTruthy();
    }
  });
});
