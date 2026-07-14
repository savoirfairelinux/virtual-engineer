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

  it("rejects additional top-level policy sections", () => {
    expect(validateRuntimePolicyYaml(
      "network",
      "network:\n  default: deny\nfilesystem:\n  allow_write: [/sandbox]\n",
    )).toMatch(/only.*network/i);
  });

  it("rejects YAML aliases", () => {
    expect(validateRuntimePolicyYaml(
      "network",
      "network: &rules\n  default: deny\nextra: *rules\n",
    )).toMatch(/alias|only/i);
  });

  it("rejects oversized policy documents", () => {
    expect(validateRuntimePolicyYaml("network", `network:\n  note: ${"x".repeat(70_000)}\n`))
      .toMatch(/too large/i);
  });
});
