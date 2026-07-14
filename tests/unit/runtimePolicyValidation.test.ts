import { describe, expect, it } from "vitest";
import { validateRuntimePolicyYaml } from "../../src/admin/adminRuntimePolicyRoutes.js";

describe("validateRuntimePolicyYaml", () => {
  it("accepts a policy document containing the declared kind", () => {
    expect(validateRuntimePolicyYaml("network", "network:\n  default: deny\n")).toBeNull();
  });

  it("rejects malformed YAML", () => {
    expect(validateRuntimePolicyYaml("network", "network: [unterminated")).toMatch(/invalid YAML/i);
  });

  it("rejects a document without the declared policy section", () => {
    expect(validateRuntimePolicyYaml("network", "filesystem:\n  default: deny\n")).toMatch(/network/i);
  });

  it("rejects empty policy documents", () => {
    expect(validateRuntimePolicyYaml("process", "  \n")).toMatch(/empty/i);
  });

  it("rejects scalar policy sections", () => {
    expect(validateRuntimePolicyYaml("network", "network: true\n")).toMatch(/object/i);
  });
});
