import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { SqliteStateStore } from "../../src/state/stateStore.js";

function tempDbPath(): string {
  return join(tmpdir(), `ve-policy-${randomUUID()}.db`);
}

describe("SqliteStateStore — runtime policies", () => {
  let store: SqliteStateStore;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
  });

  afterEach(() => {
    store.close();
  });

  it("creates, reads, updates and lists policies", async () => {
    const created = await store.createRuntimePolicy({
      name: "review-readonly",
      kind: "network",
      yaml: "network:\n  default: deny\n",
      description: "read-only egress",
    });
    expect(created.id).toBeTruthy();
    expect(created.kind).toBe("network");

    const read = await store.getRuntimePolicyById(created.id);
    expect(read?.name).toBe("review-readonly");

    const updated = await store.updateRuntimePolicy(created.id, { name: "review-ro" });
    expect(updated.name).toBe("review-ro");
    expect(updated.yaml).toContain("default: deny");

    const listed = await store.listRuntimePolicies({ kind: "network" });
    expect(listed).toHaveLength(1);
    expect(await store.listRuntimePolicies({ kind: "process" })).toHaveLength(0);
  });

  it("binds a policy to an agent and resolves it back", async () => {
    const agent = await store.createAgent({
      name: "a",
      type: "coding",
      modelConfigJson: "{}",
    });
    const policy = await store.createRuntimePolicy({ name: "p", kind: "network" });

    const binding = await store.bindRuntimePolicy({ policyId: policy.id, agentId: agent.id });
    expect(binding.agentId).toBe(agent.id);
    expect(binding.projectId).toBeNull();

    const forAgent = await store.getRuntimePoliciesForAgent(agent.id);
    expect(forAgent.map((p) => p.id)).toEqual([policy.id]);
    expect(await store.getRuntimePoliciesForProject("nope")).toHaveLength(0);

    await store.unbindRuntimePolicy(binding.id);
    expect(await store.getRuntimePoliciesForAgent(agent.id)).toHaveLength(0);
  });

  it("rejects a binding that targets both or neither scope", async () => {
    const policy = await store.createRuntimePolicy({ name: "p", kind: "network" });
    await expect(store.bindRuntimePolicy({ policyId: policy.id })).rejects.toThrow(/exactly one/i);
    await expect(
      store.bindRuntimePolicy({ policyId: policy.id, projectId: "x", agentId: "y" })
    ).rejects.toThrow(/exactly one/i);
  });

  it("rejects two policies of the same kind on one agent", async () => {
    const agent = await store.createAgent({ name: "a", type: "coding", modelConfigJson: "{}" });
    const first = await store.createRuntimePolicy({ name: "first", kind: "network" });
    const second = await store.createRuntimePolicy({ name: "second", kind: "network" });
    await store.bindRuntimePolicy({ policyId: first.id, agentId: agent.id });

    await expect(store.bindRuntimePolicy({ policyId: second.id, agentId: agent.id }))
      .rejects.toThrow(/network.*already bound/i);
  });

  it("enforces target-plus-kind uniqueness in SQLite", () => {
    const raw = (store as unknown as { raw: {
      prepare(sql: string): { all(): Array<{ name: string; unique: number }> };
    } }).raw;
    const indexes = raw.prepare("PRAGMA index_list('runtime_policy_bindings')").all();
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "uq_runtime_policy_binding_project_kind", unique: 1 }),
      expect.objectContaining({ name: "uq_runtime_policy_binding_agent_kind", unique: 1 }),
    ]));
  });

  it("deleting a policy removes its bindings", async () => {
    const agent = await store.createAgent({ name: "a", type: "coding", modelConfigJson: "{}" });
    const policy = await store.createRuntimePolicy({ name: "p", kind: "network" });
    await store.bindRuntimePolicy({ policyId: policy.id, agentId: agent.id });

    await store.deleteRuntimePolicy(policy.id);
    expect(await store.getRuntimePolicyById(policy.id)).toBeNull();
    expect(await store.getRuntimePoliciesForAgent(agent.id)).toHaveLength(0);
  });
});

describe("SqliteStateStore — policy denial events", () => {
  let store: SqliteStateStore;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
  });

  afterEach(() => {
    store.close();
  });

  it("records and lists denials newest-first with defaults", async () => {
    const e = await store.recordPolicyDenial({
      runtime: "openshell",
      category: "network",
      host: "api.github.com",
      method: "POST",
      path: "/repos/x/issues",
      reason: "not permitted by policy",
    });
    expect(e.id).toBeGreaterThan(0);
    expect(e.decision).toBe("deny");

    await store.recordPolicyDenial({ runtime: "openshell", host: "pypi.org" });

    const all = await store.listPolicyDenials();
    expect(all).toHaveLength(2);
    // newest-first
    expect(all[0]?.host).toBe("pypi.org");
  });

  it("filters denials by project", async () => {
    await store.recordPolicyDenial({ projectId: "p1", host: "a" });
    await store.recordPolicyDenial({ projectId: "p2", host: "b" });
    const p1 = await store.listPolicyDenials({ projectId: "p1" });
    expect(p1).toHaveLength(1);
    expect(p1[0]?.host).toBe("a");
  });
});
