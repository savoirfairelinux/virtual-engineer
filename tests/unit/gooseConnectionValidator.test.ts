import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateGooseConnection } from "../../src/agents/gooseConnectionValidator.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("validateGooseConnection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns success for a valid Anthropic provider", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ data: [{ id: "claude-sonnet-4-5" }] })) as unknown as typeof globalThis.fetch;
    vi.stubGlobal("fetch", fetchFn);
    const result = await validateGooseConnection({ gooseProvider: "anthropic", gooseApiKey: "sk-ant-key" });
    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
  });

  it("returns failure when the Anthropic key is missing", async () => {
    const result = await validateGooseConnection({ gooseProvider: "anthropic", gooseApiKey: "" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No API key/);
  });

  it("returns failure on 401 for OpenAI", async () => {
    const fetchFn = vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof globalThis.fetch;
    vi.stubGlobal("fetch", fetchFn);
    const result = await validateGooseConnection({ gooseProvider: "openai", gooseApiKey: "bad" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid or unauthorized/);
  });

  it("probes Ollama without a key", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ models: [{ name: "qwen2.5" }] })) as unknown as typeof globalThis.fetch;
    vi.stubGlobal("fetch", fetchFn);
    const result = await validateGooseConnection({ gooseProvider: "ollama", gooseApiBase: "http://localhost:11434" });
    expect(result.success).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("returns failure for openai_compat without a base URL", async () => {
    const result = await validateGooseConnection({ gooseProvider: "openai_compat", gooseApiKey: "key" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No API base URL/);
  });

  it("returns failure for azure_openai without an endpoint", async () => {
    const result = await validateGooseConnection({ gooseProvider: "azure_openai", gooseApiKey: "key" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No Azure OpenAI endpoint/);
  });

  it("returns failure for an unknown provider", async () => {
    const result = await validateGooseConnection({ gooseProvider: "unknown", gooseApiKey: "key" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown Goose provider/);
  });

  it("returns failure on network error", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("network down"); }) as unknown as typeof globalThis.fetch;
    vi.stubGlobal("fetch", fetchFn);
    const result = await validateGooseConnection({ gooseProvider: "openai", gooseApiKey: "key" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("network down");
  });

  it("probes Groq endpoint", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ data: [{ id: "llama-3.3-70b" }] })) as unknown as typeof globalThis.fetch;
    vi.stubGlobal("fetch", fetchFn);
    const result = await validateGooseConnection({ gooseProvider: "groq", gooseApiKey: "groq-key" });
    expect(result.success).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.groq.com/openai/v1/models",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("probes Gemini endpoint with key query param", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ models: [{ name: "models/gemini-1.5-flash" }] })) as unknown as typeof globalThis.fetch;
    vi.stubGlobal("fetch", fetchFn);
    const result = await validateGooseConnection({ gooseProvider: "gemini", gooseApiKey: "google-key" });
    expect(result.success).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1/models?key=google-key",
      expect.objectContaining({ method: "GET" })
    );
  });
});