import { describe, expect, it, vi } from "vitest";
import { createRuntimePolicyResolver } from "../../src/openshell/runtimePolicyResolver.js";

function policy(id: string, yaml: string) {
  return { id, name: id, kind: "network" as const, yaml, description: "", createdAt: new Date(), updatedAt: new Date() };
}

const denyNetwork = [
  "network_policies:",
  "  allow_api:",
  "    name: allow_api",
  "    binaries: [{ path: /usr/local/bin/node }]",
  "    endpoints: [{ host: api.example.com, port: 443, access: full, protocol: rest, enforcement: enforce }]",
  "",
].join("\n");

describe("createRuntimePolicyResolver", () => {
  it("prefers a project-bound policy over an agent-bound policy", async () => {
    const resolver = createRuntimePolicyResolver({
      getTask: vi.fn().mockResolvedValue({ projectId: "project-1" }),
      getProjectById: vi.fn().mockResolvedValue({ agentId: "agent-1" }),
      getRuntimePoliciesForProject: vi.fn().mockResolvedValue([policy("project-policy", denyNetwork)]),
      getRuntimePoliciesForAgent: vi.fn().mockResolvedValue([policy("agent-policy", "network_policies:\n  agent_rule: {}\n")]),
    });

    const yaml = await resolver({ taskId: "task-1", mode: "coding" });
    expect(yaml).toContain("allow_api:");
    expect(yaml).not.toContain("agent_rule:");
    expect(yaml).toContain("version: 1");
    expect(yaml).toContain("run_as_user: sandbox");
  });

  it("keeps agent policies for kinds not overridden by the project", async () => {
    const filesystem = { ...policy("agent-fs", "filesystem_policy:\n  read_write: [/sandbox, /tmp]\n"), kind: "filesystem" as const };
    const resolver = createRuntimePolicyResolver({
      getTask: vi.fn().mockResolvedValue({ projectId: "project-1" }),
      getProjectById: vi.fn().mockResolvedValue({ agentId: "agent-1" }),
      getRuntimePoliciesForProject: vi.fn().mockResolvedValue([
        policy("project-network", denyNetwork),
      ]),
      getRuntimePoliciesForAgent: vi.fn().mockResolvedValue([filesystem]),
    });

    const yaml = await resolver({ taskId: "task-1", mode: "coding" });
    expect(yaml).toContain("network_policies:");
    expect(yaml).toContain("filesystem_policy:");
  });

  it("falls back to the agent-bound policy", async () => {
    const resolver = createRuntimePolicyResolver({
      getTask: vi.fn().mockResolvedValue({ projectId: "project-1" }),
      getProjectById: vi.fn().mockResolvedValue({ agentId: "agent-1" }),
      getRuntimePoliciesForProject: vi.fn().mockResolvedValue([]),
      getRuntimePoliciesForAgent: vi.fn().mockResolvedValue([policy("agent-policy", denyNetwork)]),
    });

    await expect(resolver({ taskId: "task-1", mode: "review" })).resolves.toContain("allow_api:");
  });

  it("returns undefined when the task has no effective policy", async () => {
    const resolver = createRuntimePolicyResolver({
      getTask: vi.fn().mockResolvedValue(null),
      getProjectById: vi.fn(),
      getRuntimePoliciesForProject: vi.fn(),
      getRuntimePoliciesForAgent: vi.fn(),
    });

    await expect(resolver({ taskId: "missing", mode: "coding" })).resolves.toBeUndefined();
  });

  it("rejects ambiguous bindings at the same precedence level", async () => {
    const resolver = createRuntimePolicyResolver({
      getTask: vi.fn().mockResolvedValue({ projectId: "project-1" }),
      getProjectById: vi.fn().mockResolvedValue({ agentId: "agent-1" }),
      getRuntimePoliciesForProject: vi.fn().mockResolvedValue([
        policy("one", denyNetwork),
        policy("two", "network_policies:\n  other: {}\n"),
      ]),
      getRuntimePoliciesForAgent: vi.fn().mockResolvedValue([]),
    });

    await expect(resolver({ taskId: "task-1", mode: "coding" })).rejects.toThrow(/multiple network runtime policies.*project-1/i);
  });

  it("composes project policies of distinct kinds", async () => {
    const filesystem = { ...policy("fs", "filesystem_policy:\n  read_only: [/sandbox]"), kind: "filesystem" as const };
    const resolver = createRuntimePolicyResolver({
      getTask: vi.fn().mockResolvedValue({ projectId: "project-1" }),
      getProjectById: vi.fn().mockResolvedValue({ agentId: "agent-1" }),
      getRuntimePoliciesForProject: vi.fn().mockResolvedValue([
        policy("net", denyNetwork),
        filesystem,
      ]),
      getRuntimePoliciesForAgent: vi.fn().mockResolvedValue([]),
    });

    const yaml = await resolver({ taskId: "task-1", mode: "coding" });
    expect(yaml).toContain("network_policies:");
    expect(yaml).toContain("filesystem_policy:");
  });
});
