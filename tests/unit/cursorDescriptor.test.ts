import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCursorDescriptor } from "../../src/plugins/descriptors/cursor.js";
import { ModelDiscoveryConfigError } from "../../src/plugins/registry.js";

describe("createCursorDescriptor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const descriptor = createCursorDescriptor(undefined);

  it("declares the cursor provider with agent_execution capability", () => {
    expect(descriptor.provider).toBe("cursor");
    expect(descriptor.name).toBe("Cursor");
    expect(descriptor.capabilities.agent_execution?.buildAdapter).toBeDefined();
  });

  it("declares no review strategies (ve_direct only)", () => {
    const strategies = descriptor.capabilities.agent_execution?.reviewStrategies ?? [];
    expect(strategies).toHaveLength(0);
  });

  it("requiredFields expose only apiKey", () => {
    const keys = descriptor.requiredFields.map((f) => f.key);
    expect(keys).toEqual(["apiKey"]);
  });

  it("declares no configFields", () => {
    const fields = descriptor.capabilities.agent_execution?.configFields ?? [];
    expect(fields).toHaveLength(0);
  });

  describe("discoverModels", () => {
    it("throws when no key is configured", async () => {
      await expect(descriptor.discoverModels?.({})).rejects.toThrow(ModelDiscoveryConfigError);
    });
  });
});
