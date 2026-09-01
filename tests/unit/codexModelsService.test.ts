import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchOpenAiModels, fetchCodexSubscriptionModels } from "../../src/agents/codexModelsService.js";

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

describe("fetchCodexSubscriptionModels", () => {
  const catalog = {
    models: [
      { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", priority: 1, supported_in_api: true },
      { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", priority: 7, supported_in_api: true },
      { slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "hide", priority: 16, supported_in_api: true },
      { slug: "codex-internal", display_name: "Internal", visibility: "list", priority: 2, supported_in_api: false },
    ],
  };

  it("runs `codex debug models` in the agent container image and maps the live catalog", async () => {
    const execFile = vi.fn(async () => ({ stdout: JSON.stringify(catalog) }));
    const models = await fetchCodexSubscriptionModels({ execFile });

    expect(execFile).toHaveBeenCalledWith("docker", expect.arrayContaining(["run", "--rm", "codex", "debug", "models"]));
    // Hidden and API-unsupported entries are dropped; remaining ones are sorted by priority.
    expect(models).toEqual([
      { id: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
      { id: "gpt-5.5", name: "GPT-5.5" },
    ]);
  });

  it("throws a descriptive error when the container invocation fails", async () => {
    const execFile = vi.fn(async () => { throw new Error("docker: command not found"); });
    await expect(fetchCodexSubscriptionModels({ execFile })).rejects.toThrow("Failed to query the Codex model catalog");
  });
});
