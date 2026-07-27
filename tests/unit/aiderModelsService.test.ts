import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchAiderModels } from "../../src/agents/aiderModelsService.js";

function mockFetch(responses: Record<string, unknown>): typeof globalThis.fetch {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = responses[url];
    if (body === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

describe("fetchAiderModels", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches OpenAI models and maps id/name", async () => {
    const fetchFn = mockFetch({
      "https://api.openai.com/v1/models": {
        data: [
          { id: "gpt-4o", owned_by: "openai" },
          { id: "gpt-4o-mini", owned_by: "openai" },
        ],
      },
    });
    const models = await fetchAiderModels(
      { aiderBackend: "openai", aiderApiKey: "sk-key" },
      { fetch: fetchFn }
    );
    expect(models).toEqual([
      { id: "gpt-4o", name: "gpt-4o" },
      { id: "gpt-4o-mini", name: "gpt-4o-mini" },
    ]);
  });

  it("fetches Anthropic models via fetchAnthropicModels shape", async () => {
    const fetchFn = mockFetch({
      "https://api.anthropic.com/v1/models": {
        data: [
          { id: "claude-sonnet-4", display_name: "Claude Sonnet 4" },
          { id: "claude-opus-4", display_name: "Claude Opus 4" },
        ],
      },
    });
    const models = await fetchAiderModels(
      { aiderBackend: "anthropic", aiderApiKey: "sk-ant-key" },
      { fetch: fetchFn }
    );
    expect(models).toEqual([
      { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
      { id: "claude-opus-4", name: "Claude Opus 4" },
    ]);
  });

  it("fetches Ollama tags and prefixes ollama_chat/", async () => {
    const fetchFn = mockFetch({
      "http://127.0.0.1:11434/api/tags": {
        models: [{ name: "qwen2.5-coder:32b" }, { name: "llama3.2:3b" }],
      },
    });
    const models = await fetchAiderModels(
      { aiderBackend: "ollama", aiderApiBase: "http://127.0.0.1:11434" },
      { fetch: fetchFn }
    );
    expect(models).toEqual([
      { id: "ollama_chat/qwen2.5-coder:32b", name: "qwen2.5-coder:32b" },
      { id: "ollama_chat/llama3.2:3b", name: "llama3.2:3b" },
    ]);
  });

  it("uses default Ollama base when aiderApiBase is unset", async () => {
    const fetchFn = mockFetch({
      "http://127.0.0.1:11434/api/tags": { models: [{ name: "qwen2.5-coder:32b" }] },
    });
    const models = await fetchAiderModels(
      { aiderBackend: "ollama" },
      { fetch: fetchFn }
    );
    expect(models).toEqual([{ id: "ollama_chat/qwen2.5-coder:32b", name: "qwen2.5-coder:32b" }]);
  });

  it("fetches OpenRouter models", async () => {
    const fetchFn = mockFetch({
      "https://openrouter.ai/api/v1/models": {
        data: [
          { id: "anthropic/claude-3.7-sonnet", name: "Claude 3.7 Sonnet" },
          { id: "openai/gpt-4o", name: "GPT-4o" },
        ],
      },
    });
    const models = await fetchAiderModels(
      { aiderBackend: "openrouter", aiderApiKey: "or-key" },
      { fetch: fetchFn }
    );
    expect(models).toEqual([
      { id: "anthropic/claude-3.7-sonnet", name: "Claude 3.7 Sonnet" },
      { id: "openai/gpt-4o", name: "GPT-4o" },
    ]);
  });

  it("fetches DeepSeek models", async () => {
    const fetchFn = mockFetch({
      "https://api.deepseek.com/models": {
        data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
      },
    });
    const models = await fetchAiderModels(
      { aiderBackend: "deepseek", aiderApiKey: "ds-key" },
      { fetch: fetchFn }
    );
    expect(models).toEqual([
      { id: "deepseek-chat", name: "deepseek-chat" },
      { id: "deepseek-reasoner", name: "deepseek-reasoner" },
    ]);
  });

  it("fetches OpenAI-compatible models from a custom base URL", async () => {
    const fetchFn = mockFetch({
      "https://custom.example.com/v1/models": {
        data: [{ id: "my-model" }],
      },
    });
    const models = await fetchAiderModels(
      { aiderBackend: "openai_compat", aiderApiKey: "key", aiderApiBase: "https://custom.example.com" },
      { fetch: fetchFn }
    );
    expect(models).toEqual([{ id: "my-model", name: "my-model" }]);
  });

  it("throws on HTTP error", async () => {
    const fetchFn = vi.fn(async () => new Response("bad", { status: 401 })) as unknown as typeof globalThis.fetch;
    await expect(
      fetchAiderModels({ aiderBackend: "openai", aiderApiKey: "sk-key" }, { fetch: fetchFn })
    ).rejects.toThrow(/HTTP 401/);
  });
});