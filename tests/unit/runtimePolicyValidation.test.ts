import { describe, expect, it } from "vitest";
import { validateRuntimePolicyYaml } from "../../src/admin/adminRuntimePolicyRoutes.js";

describe("validateRuntimePolicyYaml", () => {
  it("accepts a policy document containing the declared kind", () => {
    expect(validateRuntimePolicyYaml("network", "network_policies:\n  default: deny\n")).toBeNull();
  });

  it("rejects malformed YAML", () => {
    expect(validateRuntimePolicyYaml("network", "network_policies: [unterminated")).toMatch(/invalid YAML/i);
  });

  it("rejects a document without the declared policy section", () => {
    expect(validateRuntimePolicyYaml("network", "filesystem_policy:\n  default: deny\n")).toMatch(/network_policies/i);
  });

  it("rejects empty policy documents", () => {
    expect(validateRuntimePolicyYaml("process", "  \n")).toMatch(/empty/i);
  });

  it("rejects scalar policy sections", () => {
    expect(validateRuntimePolicyYaml("network", "network_policies: true\n")).toMatch(/object/i);
  });

  it("rejects additional top-level policy sections", () => {
    expect(validateRuntimePolicyYaml(
      "network",
      "network_policies:\n  default: deny\nfilesystem_policy:\n  allow_write: [/sandbox]\n",
    )).toMatch(/only.*network_policies/i);
  });

  it("rejects YAML aliases", () => {
    expect(validateRuntimePolicyYaml(
      "network",
      "network_policies: &rules\n  default: deny\nextra: *rules\n",
    )).toMatch(/alias|only/i);
  });

  it("rejects oversized policy documents", () => {
    expect(validateRuntimePolicyYaml("network", `network_policies:\n  note: ${"x".repeat(70_000)}\n`))
      .toMatch(/too large/i);
  });
});
