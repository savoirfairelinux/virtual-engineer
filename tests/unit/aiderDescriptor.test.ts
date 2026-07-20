import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAiderDescriptor } from "../../src/plugins/descriptors/aider.js";
import { ModelDiscoveryConfigError } from "../../src/plugins/registry.js";

describe("createAiderDescriptor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const descriptor = createAiderDescriptor(undefined);

  it("declares the aider provider with agent_execution capability", () => {
    expect(descriptor.provider).toBe("aider");
    expect(descriptor.name).toBe("Aider");
    expect(descriptor.capabilities.agent_execution?.buildAdapter).toBeDefined();
  });

  it("requiredFields include backend selector, api key, and api base", () => {
    const keys = descriptor.requiredFields.map((f) => f.key);
    expect(keys).toEqual(["aiderBackend", "aiderApiKey", "aiderApiBase"]);
    const backendField = descriptor.requiredFields.find((f) => f.key === "aiderBackend");
    expect(backendField?.type).toBe("select");
    expect(backendField?.options?.map((o) => o.value)).toEqual([
      "openai",
      "anthropic",
      "ollama",
      "openrouter",
      "deepseek",
      "openai_compat",
    ]);
  });

  it("buildAdapter returns an AiderAdapter", () => {
    const adapter = descriptor.capabilities.agent_execution!.buildAdapter!({
      maxCommitsPerCycle: 7,
      dockerNetwork: "ve-net",
    });
    expect(adapter.name).toBe("aider");
  });

  it("testConnection delegates to validateAiderConnection", async () => {
    const fetchFn = vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof globalThis.fetch;
    vi.stubGlobal("fetch", fetchFn);
    const result = await descriptor.testConnection!({ aiderBackend: "openai", aiderApiKey: "bad" });
    expect(result.success).toBe(false);
  });

  it("discoverModels throws ModelDiscoveryConfigError when the key is missing", async () => {
    await expect(
      descriptor.discoverModels!({ aiderBackend: "openai" })
    ).rejects.toBeInstanceOf(ModelDiscoveryConfigError);
  });

  it("discoverModels throws ModelDiscoveryConfigError for openai_compat without a base", async () => {
    await expect(
      descriptor.discoverModels!({ aiderBackend: "openai_compat", aiderApiKey: "key" })
    ).rejects.toBeInstanceOf(ModelDiscoveryConfigError);
  });

  it("discoverModels returns models for a configured OpenAI backend", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as unknown as typeof globalThis.fetch;
    vi.stubGlobal("fetch", fetchFn);
    const models = await descriptor.discoverModels!({ aiderBackend: "openai", aiderApiKey: "sk-key" });
    expect(models).toEqual([{ id: "gpt-4o", name: "gpt-4o" }]);
  });
});