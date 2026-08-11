import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCodexDescriptor } from "../../src/plugins/descriptors/codex.js";
import { ModelDiscoveryConfigError } from "../../src/plugins/registry.js";

describe("createCodexDescriptor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const descriptor = createCodexDescriptor(undefined);

  it("declares the codex provider with agent_execution capability", () => {
    expect(descriptor.provider).toBe("codex");
    expect(descriptor.name).toBe("Codex");
    expect(descriptor.capabilities.agent_execution?.buildAdapter).toBeDefined();
  });

  it("declares the codex_native review strategy", () => {
    const strategies = descriptor.capabilities.agent_execution?.reviewStrategies ?? [];
    expect(strategies).toHaveLength(1);
    expect(strategies[0]?.id).toBe("codex_native");
    expect(strategies[0]?.modelSelection).toBe("provider");
    expect(strategies[0]?.requiredSystemPromptId).toBe("system_review");
  });

  it("requiredFields include authMode, apiKey, and accessToken", () => {
    const keys = descriptor.requiredFields.map((f) => f.key);
    expect(keys).toEqual(["authMode", "apiKey", "accessToken"]);
  });

  it("configFields expose only reasoningEffort", () => {
    const fields = descriptor.capabilities.agent_execution?.configFields ?? [];
    expect(fields.map((f) => f.key)).toEqual(["reasoningEffort"]);
  });

  describe("discoverModels", () => {
    it("throws when api_key mode has no key configured", async () => {
      await expect(
        descriptor.discoverModels?.({ authMode: "api_key" })
      ).rejects.toThrow(ModelDiscoveryConfigError);
    });

    it("returns the curated list for subscription mode", async () => {
      const models = await descriptor.discoverModels?.({ authMode: "subscription" });
      expect(models?.length).toBeGreaterThan(0);
    });
  });
});
