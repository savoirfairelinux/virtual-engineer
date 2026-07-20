import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateAiderConnection } from "../../src/agents/aiderConnectionValidator.js";

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("validateAiderConnection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns success for a valid OpenAI key", async () => {
    const fetchFn = vi.fn(async () => okResponse({ data: [{ id: "gpt-4o" }] })) as unknown as typeof globalThis.fetch;
    const result = await validateAiderConnection(
      { aiderBackend: "openai", aiderApiKey: "sk-key" },
      { fetch: fetchFn }
    );
    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
  });

  it("returns failure when OpenAI key is missing", async () => {
    const result = await validateAiderConnection({ aiderBackend: "openai" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No API key/);
  });

  it("returns failure on 401", async () => {
    const fetchFn = vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof globalThis.fetch;
    const result = await validateAiderConnection(
      { aiderBackend: "openai", aiderApiKey: "bad" },
      { fetch: fetchFn }
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid|unauthorized/i);
  });

  it("validates Anthropic backend", async () => {
    const fetchFn = vi.fn(async () => okResponse({ data: [{ id: "claude-sonnet-4" }] })) as unknown as typeof globalThis.fetch;
    const result = await validateAiderConnection(
      { aiderBackend: "anthropic", aiderApiKey: "sk-ant-key" },
      { fetch: fetchFn }
    );
    expect(result.success).toBe(true);
  });

  it("validates Ollama backend without a key", async () => {
    const fetchFn = vi.fn(async () => okResponse({ models: [{ name: "qwen2.5-coder:32b" }] })) as unknown as typeof globalThis.fetch;
    const result = await validateAiderConnection(
      { aiderBackend: "ollama", aiderApiBase: "http://127.0.0.1:11434" },
      { fetch: fetchFn }
    );
    expect(result.success).toBe(true);
  });

  it("validates OpenRouter backend", async () => {
    const fetchFn = vi.fn(async () => okResponse({ data: [{ id: "openai/gpt-4o" }] })) as unknown as typeof globalThis.fetch;
    const result = await validateAiderConnection(
      { aiderBackend: "openrouter", aiderApiKey: "or-key" },
      { fetch: fetchFn }
    );
    expect(result.success).toBe(true);
  });

  it("validates DeepSeek backend", async () => {
    const fetchFn = vi.fn(async () => okResponse({ data: [{ id: "deepseek-chat" }] })) as unknown as typeof globalThis.fetch;
    const result = await validateAiderConnection(
      { aiderBackend: "deepseek", aiderApiKey: "ds-key" },
      { fetch: fetchFn }
    );
    expect(result.success).toBe(true);
  });

  it("validates openai_compat backend with custom base", async () => {
    const fetchFn = vi.fn(async () => okResponse({ data: [{ id: "my-model" }] })) as unknown as typeof globalThis.fetch;
    const result = await validateAiderConnection(
      { aiderBackend: "openai_compat", aiderApiKey: "key", aiderApiBase: "https://custom.example.com" },
      { fetch: fetchFn }
    );
    expect(result.success).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://custom.example.com/v1/models",
      expect.anything()
    );
  });

  it("returns failure for openai_compat without a base URL", async () => {
    const result = await validateAiderConnection({
      aiderBackend: "openai_compat",
      aiderApiKey: "key",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/base URL/i);
  });

  it("returns failure on network error", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const result = await validateAiderConnection(
      { aiderBackend: "openai", aiderApiKey: "sk-key" },
      { fetch: fetchFn }
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("ECONNREFUSED");
  });
});