import { describe, expect, it } from "vitest";
import { validateRuntimePolicyYaml } from "../../src/admin/adminRuntimePolicyRoutes.js";

describe("validateRuntimePolicyYaml", () => {
  const validNetworkPolicy = [
    "network_policies:",
    "  allow_api:",
    "    name: allow_api",
    "    binaries:",
    "      - path: /usr/local/bin/node",
    "    endpoints:",
    "      - host: api.example.com",
    "        port: 443",
    "        access: full",
    "        protocol: rest",
    "        enforcement: enforce",
    "",
  ].join("\n");

  it("accepts an OpenShell network rule map", () => {
    expect(validateRuntimePolicyYaml("network", validNetworkPolicy)).toBeNull();
  });

  it("rejects the legacy default/allow network shape", () => {
    expect(validateRuntimePolicyYaml("network", "network_policies:\n  default: deny\n  allow: []\n"))
      .toMatch(/named rules|default.*unsupported/i);
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
      `${validNetworkPolicy}filesystem_policy:\n  read_write: [/sandbox]\n`,
    )).toMatch(/only.*network_policies/i);
  });

  it("rejects YAML aliases", () => {
    expect(validateRuntimePolicyYaml(
      "network",
      "network_policies: &rules\n  allow_api: {}\nextra: *rules\n",
    )).toMatch(/alias|only/i);
  });

  it("rejects oversized policy documents", () => {
    expect(validateRuntimePolicyYaml("network", `network_policies:\n  note: ${"x".repeat(70_000)}\n`))
      .toMatch(/too large/i);
  });
});
