import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGeminiDescriptor } from "../../src/plugins/descriptors/gemini.js";
import { ModelDiscoveryConfigError } from "../../src/plugins/registry.js";

describe("createGeminiDescriptor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const descriptor = createGeminiDescriptor(undefined);

  it("declares the gemini provider with agent_execution capability", () => {
    expect(descriptor.provider).toBe("gemini");
    expect(descriptor.name).toBe("Gemini CLI");
    expect(descriptor.capabilities.agent_execution?.buildAdapter).toBeDefined();
  });

  it("declares no experimental native review strategy (ve_direct only)", () => {
    const strategies = descriptor.capabilities.agent_execution?.reviewStrategies ?? [];
    expect(strategies).toHaveLength(0);
  });

  it("requiredFields include authMode, apiKey, and vertex-only project/location fields", () => {
    const keys = descriptor.requiredFields.map((f) => f.key);
    expect(keys).toEqual(["authMode", "apiKey", "googleCloudProject", "googleCloudLocation"]);
    const projectField = descriptor.requiredFields.find((f) => f.key === "googleCloudProject");
    expect(projectField?.dependsOn).toEqual({ field: "authMode", value: "vertex_ai" });
  });

  describe("discoverModels", () => {
    it("throws when no key is configured", async () => {
      await expect(descriptor.discoverModels?.({ authMode: "api_key" })).rejects.toThrow(
        ModelDiscoveryConfigError
      );
    });
  });
});
