import { describe, expect, it, vi } from "vitest";
import { fetchAvailableModels, exchangeForSessionToken } from "../../src/agents/copilotModelsService.js";

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const COPILOT_MODELS_URL = "https://api.githubcopilot.com/models";

describe("exchangeForSessionToken", () => {
  it("exchanges a GitHub token for a session token", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: "copilot_session_abc" }),
    })) as unknown as typeof globalThis.fetch;

    const result = await exchangeForSessionToken("ghu_test", { fetch: mockFetch });

    expect(result).toBe("copilot_session_abc");
    expect(mockFetch).toHaveBeenCalledWith(
      COPILOT_TOKEN_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          "Authorization": "token ghu_test",
        }),
      }),
    );
  });

  it("throws when token exchange fails", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 401,
    })) as unknown as typeof globalThis.fetch;

    await expect(exchangeForSessionToken("bad", { fetch: mockFetch }))
      .rejects.toThrow("Copilot token exchange failed: HTTP 401");
  });

  it("throws when response has no token", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })) as unknown as typeof globalThis.fetch;

    await expect(exchangeForSessionToken("ghu_test", { fetch: mockFetch }))
      .rejects.toThrow("Copilot token exchange returned no token");
  });
});

describe("fetchAvailableModels", () => {
  function makeModelsFetch(models: Array<Record<string, unknown>>) {
    return vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: models }),
    })) as unknown as typeof globalThis.fetch;
  }

  it("filters to chat-capable, picker-enabled, non-blocked models", async () => {
    const mockFetch = makeModelsFetch([
      { id: "gpt-4o", name: "GPT-4o", capabilities: { type: "chat" }, model_picker_enabled: true },
      { id: "codex", name: "Codex", capabilities: { type: "completion" }, model_picker_enabled: true },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", capabilities: { type: "chat" }, model_picker_enabled: false },
      { id: "blocked-model", name: "Blocked", capabilities: { type: "chat" }, model_picker_enabled: true, policy: { state: "blocked" } },
      { id: "o1-pro", name: "o1 Pro", capabilities: { type: "chat" }, model_picker_enabled: true },
    ]);

    const models = await fetchAvailableModels("session_tok", { fetch: mockFetch });

    expect(models.map((m) => m.id)).toEqual(["o1-pro", "gpt-4o"]);
  });

  it("deduplicates by model id", async () => {
    const mockFetch = makeModelsFetch([
      { id: "gpt-4o", name: "GPT-4o", capabilities: { type: "chat" }, model_picker_enabled: true },
      { id: "gpt-4o", name: "GPT-4o Copy", capabilities: { type: "chat" }, model_picker_enabled: true },
    ]);

    const models = await fetchAvailableModels("session_tok", { fetch: mockFetch });

    expect(models).toHaveLength(1);
    expect(models[0]!.name).toBe("GPT-4o");
  });

  it("sorts by category: powerful > versatile > balanced > lightweight", async () => {
    const mockFetch = makeModelsFetch([
      { id: "gpt-4o-mini", name: "GPT-4o Mini", capabilities: { type: "chat" }, model_picker_enabled: true },
      { id: "o3-pro", name: "o3 Pro", capabilities: { type: "chat" }, model_picker_enabled: true },
      { id: "gpt-4o", name: "GPT-4o", capabilities: { type: "chat" }, model_picker_enabled: true },
      { id: "claude-haiku", name: "Claude Haiku", capabilities: { type: "chat" }, model_picker_enabled: true },
    ]);

    const models = await fetchAvailableModels("session_tok", { fetch: mockFetch });
    const categories = models.map((m) => m.category);

    expect(categories).toEqual(["powerful", "versatile", "balanced", "lightweight"]);
  });

  it("returns empty array when no models pass filters", async () => {
    const mockFetch = makeModelsFetch([
      { id: "codex", capabilities: { type: "completion" }, model_picker_enabled: true },
    ]);

    const models = await fetchAvailableModels("session_tok", { fetch: mockFetch });

    expect(models).toEqual([]);
  });

  it("includes context window and capabilities from nested API structure", async () => {
    const mockFetch = makeModelsFetch([
      {
        id: "gpt-4o",
        name: "GPT-4o",
        capabilities: {
          type: "chat",
          family: "gpt-4o",
          limits: { max_context_window_tokens: 128000 },
        },
        model_picker_enabled: true,
      },
    ]);

    const models = await fetchAvailableModels("session_tok", { fetch: mockFetch });

    expect(models).toHaveLength(1);
    const model = models[0]!;
    expect(model.id).toBe("gpt-4o");
    expect(model.contextWindowTokens).toBe(128000);
    expect(model.capabilities).toEqual({
      type: "chat",
      family: "gpt-4o",
      limits: { max_context_window_tokens: 128000 },
    });
  });

  it("sends correct headers including Copilot-Integration-Id", async () => {
    const mockFetch = makeModelsFetch([]);

    await fetchAvailableModels("my_session_token", { fetch: mockFetch });

    expect(mockFetch).toHaveBeenCalledWith(
      COPILOT_MODELS_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          "Authorization": "Bearer my_session_token",
          "Copilot-Integration-Id": "vscode-chat",
        }),
      }),
    );
  });

  it("throws when models API returns non-OK", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 403,
    })) as unknown as typeof globalThis.fetch;

    await expect(fetchAvailableModels("tok", { fetch: mockFetch }))
      .rejects.toThrow("Copilot models API returned HTTP 403");
  });

  it("extracts supportedReasoningEfforts from capabilities.supports.reasoning_effort array", async () => {
    const mockFetch = makeModelsFetch([{
      id: "claude-opus-4.6",
      name: "Claude Opus 4.6",
      vendor: "Anthropic",
      version: "claude-opus-4.6",
      capabilities: {
        type: "chat",
        supports: { reasoning_effort: ["low", "medium", "high"] },
      },
      model_picker_enabled: true,
    }]);
    const models = await fetchAvailableModels("token", { fetch: mockFetch });
    expect(models).toHaveLength(1);
    expect(models[0]!.supportedReasoningEfforts).toEqual(["low", "medium", "high"]);
  });

  it("leaves supportedReasoningEfforts undefined when absent", async () => {
    const mockFetch = makeModelsFetch([{
      id: "gpt-4o",
      name: "GPT-4o",
      vendor: "OpenAI",
      version: "gpt-4o",
      capabilities: { type: "chat" },
      model_picker_enabled: true,
    }]);
    const models = await fetchAvailableModels("token", { fetch: mockFetch });
    expect(models[0]!.supportedReasoningEfforts).toBeUndefined();
  });

  it("keeps 'none' and filters out unrecognised values from reasoning_effort array", async () => {
    const mockFetch = makeModelsFetch([{
      id: "gpt-5.4-mini",
      name: "GPT 5.4 mini",
      vendor: "OpenAI",
      version: "gpt-5.4-mini",
      capabilities: {
        type: "chat",
        supports: { reasoning_effort: ["none", "low", "ultra", "medium", "high", "xhigh"] },
      },
      model_picker_enabled: true,
    }]);
    const models = await fetchAvailableModels("token", { fetch: mockFetch });
    expect(models[0]!.supportedReasoningEfforts).toEqual(["none", "low", "medium", "high", "xhigh"]);
  });
});
