import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import type { UserRole } from "../../src/interfaces.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

function tempDbPath(): string {
  return tempDatabasePath("ve-pbac");
}

async function makeUser(store: SqliteStateStore, role: UserRole = "operator") {
  return store.createUser({
    id: randomUUID(),
    username: `user-${randomUUID().slice(0, 8)}`,
    passwordHash: "scrypt:16384:8:1:salt:hash",
    role,
  });
}

describe("groupStore", () => {
  let store: SqliteStateStore;
  beforeEach(async () => { store = await SqliteStateStore.create(tempDbPath()); });
  afterEach(() => { store.close(); });

  it("creates, lists, updates and deletes groups", async () => {
    const g = await store.createGroup({ name: "Team A", description: "first" });
    expect(g.name).toBe("Team A");
    expect((await store.listGroups()).some((x) => x.id === g.id)).toBe(true);

    const updated = await store.updateGroup(g.id, { description: "changed" });
    expect(updated?.description).toBe("changed");

    expect(await store.deleteGroup(g.id)).toBe(true);
    expect(await store.getGroupById(g.id)).toBeNull();
  });

  it("rejects duplicate group names with code DUPLICATE", async () => {
    await store.createGroup({ name: "Dup" });
    await expect(store.createGroup({ name: "Dup" })).rejects.toMatchObject({ code: "DUPLICATE" });
  });

  it("manages membership and resolves groups-for-user and members-for-group", async () => {
    const g = await store.createGroup({ name: "Members" });
    const u1 = await makeUser(store);
    const u2 = await makeUser(store);

    await store.addUserToGroup(g.id, u1.id);
    await store.addUserToGroup(g.id, u2.id);
    await store.addUserToGroup(g.id, u1.id); // idempotent

    expect((await store.listGroupMemberIds(g.id)).sort()).toEqual([u1.id, u2.id].sort());
    expect((await store.listGroupsForUser(u1.id)).map((x) => x.id)).toEqual([g.id]);

    expect(await store.removeUserFromGroup(g.id, u1.id)).toBe(true);
    expect(await store.listGroupMemberIds(g.id)).toEqual([u2.id]);
  });

  it("cascades membership rows when a group is deleted", async () => {
    const g = await store.createGroup({ name: "Temp" });
    const u = await makeUser(store);
    await store.addUserToGroup(g.id, u.id);
    await store.deleteGroup(g.id);
    expect(await store.listGroupsForUser(u.id)).toEqual([]);
  });
});

describe("policyStore", () => {
  let store: SqliteStateStore;
  beforeEach(async () => { store = await SqliteStateStore.create(tempDbPath()); });
  afterEach(() => { store.close(); });

  it("creates policies and replaces their rule set atomically", async () => {
    const p = await store.createPolicy({ name: "Custom", description: "d" });
    await store.setPolicyRules(p.id, [
      { permission: "project.read", resourceId: "proj-1" },
      { permission: "project.write", resourceId: null },
    ]);
    let rules = await store.listPolicyRules(p.id);
    expect(rules).toHaveLength(2);

    // Replacing overwrites, not appends.
    await store.setPolicyRules(p.id, [{ permission: "task.read", resourceId: null }]);
    rules = await store.listPolicyRules(p.id);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.permission).toBe("task.read");
    expect(rules[0]?.resourceId).toBeNull();
  });

  it("rejects duplicate policy names and duplicate bindings", async () => {
    await store.createPolicy({ name: "PDup" });
    await expect(store.createPolicy({ name: "PDup" })).rejects.toMatchObject({ code: "DUPLICATE" });

    const p = await store.createPolicy({ name: "Bindable" });
    const u = await makeUser(store);
    await store.createBinding({ policyId: p.id, principalType: "user", principalId: u.id });
    await expect(
      store.createBinding({ policyId: p.id, principalType: "user", principalId: u.id })
    ).rejects.toMatchObject({ code: "DUPLICATE" });
  });

  it("rejects non-system bindings for built-in system policies", async () => {
    const user = await makeUser(store);
    const resourceOwner = (await store.listPolicies()).find((policy) => policy.name === "Resource Owner");
    expect(resourceOwner).toBeDefined();

    await expect(store.createBinding({
      policyId: resourceOwner!.id,
      principalType: "user",
      principalId: user.id,
    })).rejects.toMatchObject({ code: "SYSTEM_POLICY_BINDING" });
  });

  it("cascades rules and bindings when a policy is deleted", async () => {
    const p = await store.createPolicy({ name: "Doomed" });
    const u = await makeUser(store);
    await store.setPolicyRules(p.id, [{ permission: "project.read", resourceId: null }]);
    await store.createBinding({ policyId: p.id, principalType: "user", principalId: u.id });

    expect(await store.deletePolicy(p.id)).toBe(true);
    expect(await store.listPolicyRules(p.id)).toEqual([]);
    expect(await store.listBindingsForPrincipal("user", u.id)).toEqual([]);
  });

  it("resolves effective rules from direct user and group bindings", async () => {
    const u = await makeUser(store);
    const g = await store.createGroup({ name: "G" });
    await store.addUserToGroup(g.id, u.id);

    const direct = await store.createPolicy({ name: "Direct" });
    await store.setPolicyRules(direct.id, [{ permission: "project.read", resourceId: "p1" }]);
    await store.createBinding({ policyId: direct.id, principalType: "user", principalId: u.id });

    const viaGroup = await store.createPolicy({ name: "ViaGroup" });
    await store.setPolicyRules(viaGroup.id, [{ permission: "integration.read", resourceId: null }]);
    await store.createBinding({ policyId: viaGroup.id, principalType: "group", principalId: g.id });

    // A policy bound to nobody must not leak in.
    const unbound = await store.createPolicy({ name: "Unbound" });
    await store.setPolicyRules(unbound.id, [{ permission: "user.manage", resourceId: null }]);

    const rules = await store.getEffectivePolicyRulesForUser(u.id);
    const perms = rules
      .filter((rule) => rule.principalType !== "system")
      .map((rule) => rule.permission)
      .sort();
    expect(perms).toEqual(["integration.read", "project.read"]);
    expect(rules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        permission: "project.read",
        principalType: "user",
        principalId: u.id,
      }),
      expect.objectContaining({
        permission: "integration.read",
        principalType: "group",
        principalId: g.id,
      }),
    ]));
  });

  it("includes system-principal rules for every registered user", async () => {
    const user = await makeUser(store);
    const policy = await store.createPolicy({ name: "System owner rules" });
    await store.setPolicyRules(policy.id, [{ permission: "prompt.read", resourceId: null }]);
    await store.createBinding({
      policyId: policy.id,
      principalType: "system",
      principalId: "resource_owner",
    });

    await expect(store.getEffectivePolicyRulesForUser(user.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          permission: "prompt.read",
          principalType: "system",
          principalId: "resource_owner",
        }),
      ])
    );
  });

  it("returns only system rules for a user with no explicit bindings", async () => {
    const u = await makeUser(store);
    const rules = await store.getEffectivePolicyRulesForUser(u.id);
    expect(new Set(rules.map((rule) => rule.principalId))).toEqual(new Set([
      "registered_users",
      "resource_owner",
      "project_owners",
    ]));
  });
});

describe("built-in policy seeding & migration", () => {
  let store: SqliteStateStore;
  beforeEach(async () => { store = await SqliteStateStore.create(tempDbPath()); });
  afterEach(() => { store.close(); });

  it("seeds role and Gerrit-style system policies", async () => {
    const policies = await store.listPolicies();
    const operator = policies.find((p) => p.name === "Operator");
    const viewer = policies.find((p) => p.name === "Viewer");
    const registered = policies.find((p) => p.name === "Registered Users");
    const resourceOwner = policies.find((p) => p.name === "Resource Owner");
    const projectOwners = policies.find((p) => p.name === "Project Owners");
    expect(operator?.builtin).toBe(true);
    expect(viewer?.builtin).toBe(true);
    expect(registered?.builtin).toBe(true);
    expect(resourceOwner?.builtin).toBe(true);
    expect(projectOwners?.builtin).toBe(true);

    const opRules = await store.listPolicyRules(operator!.id);
    expect(opRules.some((r) => r.permission === "project.create")).toBe(true);
    expect(opRules.some((r) => r.permission === "project.write")).toBe(false);
    expect(opRules.every((r) => r.resourceId === null)).toBe(true);
    expect(opRules.some((r) => r.permission === "user.manage")).toBe(false);

    await expect(store.listBindingsForPrincipal("system", "registered_users"))
      .resolves.toEqual([expect.objectContaining({ policyId: registered!.id })]);
    await expect(store.listBindingsForPrincipal("system", "resource_owner"))
      .resolves.toEqual([expect.objectContaining({ policyId: resourceOwner!.id })]);
    await expect(store.listBindingsForPrincipal("system", "project_owners"))
      .resolves.toEqual([expect.objectContaining({ policyId: projectOwners!.id })]);
  });

  it("binds a pre-existing operator user to the Operator policy on re-open", async () => {
    const path = tempDbPath();
    const first = await SqliteStateStore.create(path);
    const u = await first.createUser({
      id: randomUUID(), username: "legacy-op", passwordHash: "scrypt:16384:8:1:s:h", role: "operator",
    });
    first.close();

    // Re-opening runs the seed/migration against the now-existing user.
    const reopened = await SqliteStateStore.create(path);
    const bindings = await reopened.listBindingsForPrincipal("user", u.id);
    expect(bindings).toHaveLength(1);
    const operator = (await reopened.listPolicies()).find((p) => p.name === "Operator");
    expect(bindings[0]?.policyId).toBe(operator!.id);
    reopened.close();
  });

  it("does not override a user that already has PBAC bindings", async () => {
    const path = tempDbPath();
    const first = await SqliteStateStore.create(path);
    const u = await first.createUser({
      id: randomUUID(), username: "managed", passwordHash: "scrypt:16384:8:1:s:h", role: "viewer",
    });
    const custom = await first.createPolicy({ name: "Custom" });
    await first.createBinding({ policyId: custom.id, principalType: "user", principalId: u.id });
    first.close();

    const reopened = await SqliteStateStore.create(path);
    const bindings = await reopened.listBindingsForPrincipal("user", u.id);
    // Still only the custom binding — the Viewer built-in was NOT auto-added.
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.policyId).toBe(custom.id);
    reopened.close();
  });

  it("does not bind admin users to any built-in policy", async () => {
    const path = tempDbPath();
    const first = await SqliteStateStore.create(path);
    const admin = await first.createUser({
      id: randomUUID(), username: "root", passwordHash: "scrypt:16384:8:1:s:h", role: "admin",
    });
    first.close();

    const reopened = await SqliteStateStore.create(path);
    expect(await reopened.listBindingsForPrincipal("user", admin.id)).toEqual([]);
    reopened.close();
  });
});
