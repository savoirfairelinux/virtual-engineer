import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOpenCodeDescriptor } from "../../src/plugins/descriptors/opencode.js";
import { ModelDiscoveryConfigError } from "../../src/plugins/registry.js";

describe("createOpenCodeDescriptor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const descriptor = createOpenCodeDescriptor(undefined);

  it("declares the opencode provider with agent_execution capability", () => {
    expect(descriptor.provider).toBe("opencode");
    expect(descriptor.name).toBe("OpenCode");
    expect(descriptor.capabilities.agent_execution?.buildAdapter).toBeDefined();
  });

  it("declares the opencode_native review strategy", () => {
    const strategies = descriptor.capabilities.agent_execution?.reviewStrategies ?? [];
    expect(strategies).toHaveLength(1);
    expect(strategies[0]?.id).toBe("opencode_native");
    expect(strategies[0]?.modelSelection).toBe("provider");
    expect(strategies[0]?.requiredSystemPromptId).toBe("system_review");
  });

  it("requiredFields include provider selector, api key, and api base", () => {
    const keys = descriptor.requiredFields.map((f) => f.key);
    expect(keys).toEqual(["openCodeProvider", "openCodeApiKey", "openCodeApiBase"]);
    const providerField = descriptor.requiredFields.find((f) => f.key === "openCodeProvider");
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

  it("configFields declare the optional model variant", () => {
    const keys = descriptor.capabilities.agent_execution!.configFields!.map((f) => f.key);
    expect(keys).toEqual(["variant"]);
  });

  it("buildAdapter returns an OpenCodeAdapter", () => {
    const adapter = descriptor.capabilities.agent_execution!.buildAdapter!({
      maxCommitsPerCycle: 7,
    });
    expect(adapter.name).toBe("opencode");
  });

  it("testConnection delegates to validateOpenCodeConnection", async () => {
    const fetchFn = vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof globalThis.fetch;
    vi.stubGlobal("fetch", fetchFn);
    const result = await descriptor.testConnection!({ openCodeProvider: "openai", openCodeApiKey: "bad" });
    expect(result.success).toBe(false);
  });

  it("discoverModels throws ModelDiscoveryConfigError when the key is missing", async () => {
    await expect(
      descriptor.discoverModels!({ openCodeProvider: "openai" })
    ).rejects.toBeInstanceOf(ModelDiscoveryConfigError);
  });

  it("discoverModels throws ModelDiscoveryConfigError for openai_compat without a base", async () => {
    await expect(
      descriptor.discoverModels!({ openCodeProvider: "openai_compat", openCodeApiKey: "key" })
    ).rejects.toBeInstanceOf(ModelDiscoveryConfigError);
  });

  it("discoverModels returns models for a configured OpenAI provider", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "gpt-5.5" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as unknown as typeof globalThis.fetch;
    vi.stubGlobal("fetch", fetchFn);
    const models = await descriptor.discoverModels!({ openCodeProvider: "openai", openCodeApiKey: "sk-key" });
    expect(models).toEqual([{ id: "gpt-5.5", name: "gpt-5.5" }]);
  });

  it("discoverModels returns an empty list for bedrock (env-only)", async () => {
    const models = await descriptor.discoverModels!({ openCodeProvider: "bedrock" });
    expect(models).toEqual([]);
  });
});
