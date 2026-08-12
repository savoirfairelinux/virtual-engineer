import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchCursorModels } from "../../src/agents/cursorModelsService.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchCursorModels", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches models with a bearer token", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ items: [{ id: "composer-2", displayName: "Composer 2" }] }));
    const models = await fetchCursorModels("cursor-key", { fetch: fetchFn as unknown as typeof globalThis.fetch });
    expect(models).toEqual([{ id: "composer-2", name: "Composer 2" }]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.cursor.com/v1/models",
      expect.objectContaining({ method: "GET", headers: expect.objectContaining({ Authorization: "Bearer cursor-key" }) })
    );
  });

  it("falls back to the id when displayName is missing", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ items: [{ id: "gpt-5" }] }));
    const models = await fetchCursorModels("cursor-key", { fetch: fetchFn as unknown as typeof globalThis.fetch });
    expect(models).toEqual([{ id: "gpt-5", name: "gpt-5" }]);
  });

  it("throws on a non-ok response", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, 500));
    await expect(
      fetchCursorModels("cursor-key", { fetch: fetchFn as unknown as typeof globalThis.fetch })
    ).rejects.toThrow("HTTP 500");
  });

  it("filters out entries without a usable id", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ items: [{ id: "" }, { id: "gpt-5" }] }));
    const models = await fetchCursorModels("cursor-key", { fetch: fetchFn as unknown as typeof globalThis.fetch });
    expect(models).toEqual([{ id: "gpt-5", name: "gpt-5" }]);
  });
});
