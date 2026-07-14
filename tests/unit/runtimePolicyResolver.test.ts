import { describe, expect, it, vi } from "vitest";
import { createRuntimePolicyResolver } from "../../src/openshell/runtimePolicyResolver.js";

function policy(id: string, yaml: string) {
  return { id, name: id, kind: "network" as const, yaml, description: "", createdAt: new Date(), updatedAt: new Date() };
}

describe("createRuntimePolicyResolver", () => {
  it("prefers a project-bound policy over an agent-bound policy", async () => {
    const resolver = createRuntimePolicyResolver({
      getTask: vi.fn().mockResolvedValue({ projectId: "project-1" }),
      getProjectById: vi.fn().mockResolvedValue({ agentId: "agent-1" }),
      getRuntimePoliciesForProject: vi.fn().mockResolvedValue([policy("project-policy", "network:\n  default: deny")]),
      getRuntimePoliciesForAgent: vi.fn().mockResolvedValue([policy("agent-policy", "network:\n  default: allow")]),
    });

    await expect(resolver({ taskId: "task-1", mode: "coding" })).resolves.toContain("default: deny");
  });

  it("keeps agent policies for kinds not overridden by the project", async () => {
    const filesystem = { ...policy("agent-fs", "filesystem:\n  allow_write: [/sandbox]"), kind: "filesystem" as const };
    const resolver = createRuntimePolicyResolver({
      getTask: vi.fn().mockResolvedValue({ projectId: "project-1" }),
      getProjectById: vi.fn().mockResolvedValue({ agentId: "agent-1" }),
      getRuntimePoliciesForProject: vi.fn().mockResolvedValue([
        policy("project-network", "network:\n  default: deny"),
      ]),
      getRuntimePoliciesForAgent: vi.fn().mockResolvedValue([filesystem]),
    });

    const yaml = await resolver({ taskId: "task-1", mode: "coding" });
    expect(yaml).toContain("network:");
    expect(yaml).toContain("filesystem:");
  });

  it("falls back to the agent-bound policy", async () => {
    const resolver = createRuntimePolicyResolver({
      getTask: vi.fn().mockResolvedValue({ projectId: "project-1" }),
      getProjectById: vi.fn().mockResolvedValue({ agentId: "agent-1" }),
      getRuntimePoliciesForProject: vi.fn().mockResolvedValue([]),
      getRuntimePoliciesForAgent: vi.fn().mockResolvedValue([policy("agent-policy", "network:\n  default: allow")]),
    });

    await expect(resolver({ taskId: "task-1", mode: "review" })).resolves.toContain("default: allow");
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
        policy("one", "network:\n  default: deny"),
        policy("two", "network:\n  default: allow"),
      ]),
      getRuntimePoliciesForAgent: vi.fn().mockResolvedValue([]),
    });

    await expect(resolver({ taskId: "task-1", mode: "coding" })).rejects.toThrow(/multiple network runtime policies.*project-1/i);
  });

  it("composes project policies of distinct kinds", async () => {
    const filesystem = { ...policy("fs", "filesystem:\n  allow_read: [/sandbox]"), kind: "filesystem" as const };
    const resolver = createRuntimePolicyResolver({
      getTask: vi.fn().mockResolvedValue({ projectId: "project-1" }),
      getProjectById: vi.fn().mockResolvedValue({ agentId: "agent-1" }),
      getRuntimePoliciesForProject: vi.fn().mockResolvedValue([
        policy("net", "network:\n  default: deny"),
        filesystem,
      ]),
      getRuntimePoliciesForAgent: vi.fn().mockResolvedValue([]),
    });

    const yaml = await resolver({ taskId: "task-1", mode: "coding" });
    expect(yaml).toContain("network:");
    expect(yaml).toContain("filesystem:");
  });
});
