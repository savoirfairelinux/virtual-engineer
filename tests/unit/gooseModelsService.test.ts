import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchGooseModels } from "../../src/agents/gooseModelsService.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchGooseModels", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches OpenAI-style models for the openai provider", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ data: [{ id: "gpt-4o", name: "GPT-4o" }] })) as unknown as typeof globalThis.fetch;
    vi.stubGlobal("fetch", fetchFn);
    const models = await fetchGooseModels({ gooseProvider: "openai", gooseApiKey: "sk-key" });
    expect(models).toEqual([{ id: "gpt-4o", name: "GPT-4o" }]);
  });

  it("fetches Anthropic models with display_name", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ data: [{ id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5" }] })) as unknown as typeof globalThis.fetch;
    vi.stubGlobal("fetch", fetchFn);
    const models = await fetchGooseModels({ gooseProvider: "anthropic", gooseApiKey: "sk-ant-key" });
    expect(models).toEqual([{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }]);
  });

  it("fetches Ollama models and prefixes with ollama_chat/", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ models: [{ name: "qwen2.5" }] })) as unknown as typeof globalThis.fetch;
    vi.stubGlobal("fetch", fetchFn);
    const models = await fetchGooseModels({ gooseProvider: "ollama", gooseApiBase: "http://localhost:11434" });
    expect(models).toEqual([{ id: "ollama_chat/qwen2.5", name: "qwen2.5" }]);
  });

  it("fetches Gemini models and strips the models/ prefix", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ models: [{ name: "models/gemini-1.5-flash", displayName: "Gemini 1.5 Flash" }] })) as unknown as typeof globalThis.fetch;
    vi.stubGlobal("fetch", fetchFn);
    const models = await fetchGooseModels({ gooseProvider: "gemini", gooseApiKey: "google-key" });
    expect(models).toEqual([{ id: "gemini-1.5-flash", name: "Gemini 1.5 Flash" }]);
  });

  it("fetches Azure OpenAI models", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ data: [{ id: "gpt-4o" }] })) as unknown as typeof globalThis.fetch;
    vi.stubGlobal("fetch", fetchFn);
    const models = await fetchGooseModels({ gooseProvider: "azure_openai", gooseApiKey: "az-key", gooseApiBase: "https://my-endpoint.openai.azure.com" });
    expect(models).toEqual([{ id: "gpt-4o", name: "gpt-4o" }]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://my-endpoint.openai.azure.com/openai/models?api-version=2024-10-21",
      expect.objectContaining({ method: "GET", headers: expect.objectContaining({ "api-key": "az-key" }) })
    );
  });

  it("returns an empty list for bedrock (env-only)", async () => {
    const models = await fetchGooseModels({ gooseProvider: "bedrock" });
    expect(models).toEqual([]);
  });

  it("throws for openai_compat without a base URL", async () => {
    await expect(
      fetchGooseModels({ gooseProvider: "openai_compat", gooseApiKey: "key" })
    ).rejects.toThrow(/No API base URL/);
  });

  it("throws for azure_openai without an endpoint", async () => {
    await expect(
      fetchGooseModels({ gooseProvider: "azure_openai", gooseApiKey: "key" })
    ).rejects.toThrow(/No Azure OpenAI endpoint/);
  });

  it("throws on HTTP error", async () => {
    const fetchFn = vi.fn(async () => new Response("error", { status: 500 })) as unknown as typeof globalThis.fetch;
    vi.stubGlobal("fetch", fetchFn);
    await expect(
      fetchGooseModels({ gooseProvider: "openai", gooseApiKey: "key" })
    ).rejects.toThrow(/HTTP 500/);
  });

  it("throws for an unknown provider", async () => {
    await expect(
      fetchGooseModels({ gooseProvider: "unknown", gooseApiKey: "key" })
    ).rejects.toThrow(/Unknown Goose provider/);
  });

  it("fetches models for openai_compat with a custom base URL", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ data: [{ id: "custom-model" }] })) as unknown as typeof globalThis.fetch;
    vi.stubGlobal("fetch", fetchFn);
    const models = await fetchGooseModels({ gooseProvider: "openai_compat", gooseApiKey: "key", gooseApiBase: "https://custom.example.com" });
    expect(models).toEqual([{ id: "custom-model", name: "custom-model" }]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://custom.example.com/v1/models",
      expect.objectContaining({ method: "GET" })
    );
  });
});