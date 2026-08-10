import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGooseDescriptor } from "../../src/plugins/descriptors/goose.js";
import { ModelDiscoveryConfigError } from "../../src/plugins/registry.js";

describe("createGooseDescriptor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const descriptor = createGooseDescriptor(undefined);

  it("declares the goose provider with agent_execution capability", () => {
    expect(descriptor.provider).toBe("goose");
    expect(descriptor.name).toBe("Goose");
    expect(descriptor.capabilities.agent_execution?.buildAdapter).toBeDefined();
  });

  it("declares the goose_native review strategy", () => {
    const strategies = descriptor.capabilities.agent_execution?.reviewStrategies ?? [];
    expect(strategies).toHaveLength(1);
    expect(strategies[0]?.id).toBe("goose_native");
    expect(strategies[0]?.modelSelection).toBe("provider");
    expect(strategies[0]?.requiredSystemPromptId).toBe("system_review");
  });

  it("requiredFields include provider selector, api key, and api base", () => {
    const keys = descriptor.requiredFields.map((f) => f.key);
    expect(keys).toEqual(["gooseProvider", "gooseApiKey", "gooseApiBase"]);
    const providerField = descriptor.requiredFields.find((f) => f.key === "gooseProvider");
    expect(providerField?.type).toBe("select");
    expect(providerField?.options?.map((o) => o.value)).toEqual([
      "anthropic",
      "openai",
      "openrouter",
      "ollama",
      "deepseek",
      "groq",
      "gemini",
      "azure_openai",
      "bedrock",
      "perplexity",
      "mistral",
      "xai",
      "cerebras",
      "openai_compat",
    ]);
  });

  it("configFields declare goose execution options", () => {
    const keys = descriptor.capabilities.agent_execution!.configFields!.map((f) => f.key);
    expect(keys).toEqual([
      "gooseMode",
      "gooseMaxTurns",
      "gooseMaxTokens",
      "gooseTemperature",
      "gooseAutoCompactThreshold",
    ]);
  });

  it("buildAdapter returns a GooseAdapter", () => {
    const adapter = descriptor.capabilities.agent_execution!.buildAdapter!({
      maxCommitsPerCycle: 7,
    });
    expect(adapter.name).toBe("goose");
  });

  it("testConnection delegates to validateGooseConnection", async () => {
    const fetchFn = vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof globalThis.fetch;
    vi.stubGlobal("fetch", fetchFn);
    const result = await descriptor.testConnection!({ gooseProvider: "openai", gooseApiKey: "bad" });
    expect(result.success).toBe(false);
  });

  it("discoverModels throws ModelDiscoveryConfigError when the key is missing", async () => {
    await expect(
      descriptor.discoverModels!({ gooseProvider: "openai" })
    ).rejects.toBeInstanceOf(ModelDiscoveryConfigError);
  });

  it("discoverModels throws ModelDiscoveryConfigError for openai_compat without a base", async () => {
    await expect(
      descriptor.discoverModels!({ gooseProvider: "openai_compat", gooseApiKey: "key" })
    ).rejects.toBeInstanceOf(ModelDiscoveryConfigError);
  });

  it("discoverModels throws ModelDiscoveryConfigError for azure_openai without an endpoint", async () => {
    await expect(
      descriptor.discoverModels!({ gooseProvider: "azure_openai", gooseApiKey: "key" })
    ).rejects.toBeInstanceOf(ModelDiscoveryConfigError);
  });

  it("discoverModels returns models for a configured OpenAI provider", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as unknown as typeof globalThis.fetch;
    vi.stubGlobal("fetch", fetchFn);
    const models = await descriptor.discoverModels!({ gooseProvider: "openai", gooseApiKey: "sk-key" });
    expect(models).toEqual([{ id: "gpt-4o", name: "gpt-4o" }]);
  });

  it("discoverModels returns models for a configured Anthropic provider", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as unknown as typeof globalThis.fetch;
    vi.stubGlobal("fetch", fetchFn);
    const models = await descriptor.discoverModels!({ gooseProvider: "anthropic", gooseApiKey: "sk-ant-key" });
    expect(models).toEqual([{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }]);
  });

  it("discoverModels returns an empty list for bedrock (env-only)", async () => {
    const models = await descriptor.discoverModels!({ gooseProvider: "bedrock" });
    expect(models).toEqual([]);
  });
});