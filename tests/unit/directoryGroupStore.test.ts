import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

describe("directoryGroupStore", () => {
  let store: SqliteStateStore;
  let dbPath: string;
  let sourceId: string;
  let groupId: string;

  beforeEach(async () => {
    dbPath = tempDatabasePath("ve-directory-groups");
    store = await SqliteStateStore.create(dbPath);
    sourceId = (await store.createAuthSource({ name: "Corp", kind: "ldap", configJson: "{}" })).id;
    groupId = (await store.createGroup({ name: "Developers" })).id;
  });

  afterEach(() => {
    store.close();
  });

  async function directoryUser(username: string, groups: string[]): Promise<{ userId: string; identityId: string }> {
    const { user, identity } = await store.createExternalUser({
      username, role: "operator", authSourceId: sourceId, externalSubject: `uuid-${username}`, externalUsername: username,
    });
    await store.replaceIdentityGroups(identity.id, groups);
    return { userId: user.id, identityId: identity.id };
  }

  it("creates, lists, and deletes mappings, rejecting duplicates and unknown targets", async () => {
    const mapping = await store.createGroupMapping({ authSourceId: sourceId, externalGroup: "cn=devs,ou=groups", groupId });

    await expect(store.listGroupMappings(sourceId)).resolves.toEqual([mapping]);
    await expect(store.createGroupMapping({ authSourceId: sourceId, externalGroup: "cn=devs,ou=groups", groupId }))
      .rejects.toMatchObject({ code: "DUPLICATE" });
    await expect(store.createGroupMapping({ authSourceId: sourceId, externalGroup: "cn=x", groupId: "missing" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(store.deleteGroupMapping("other-source", mapping.id)).resolves.toBe(false);
    await expect(store.deleteGroupMapping(sourceId, mapping.id)).resolves.toBe(true);
    await expect(store.listGroupMappings(sourceId)).resolves.toEqual([]);
  });

  it("replaces an identity's groups and resolves mapped VE groups and members", async () => {
    await store.createGroupMapping({ authSourceId: sourceId, externalGroup: "cn=devs,ou=groups", groupId });
    const alice = await directoryUser("alice", ["cn=devs,ou=groups", "cn=ops,ou=groups"]);
    await directoryUser("bob", ["cn=ops,ou=groups"]);

    await expect(store.listIdentityGroups(alice.identityId)).resolves.toEqual(["cn=devs,ou=groups", "cn=ops,ou=groups"]);
    await expect(store.listMappedGroupIds(sourceId, ["cn=devs,ou=groups"])).resolves.toEqual([groupId]);
    await expect(store.listMappedGroupIds(sourceId, [])).resolves.toEqual([]);
    await expect(store.listDirectoryMemberIds(groupId)).resolves.toEqual([alice.userId]);

    await store.replaceIdentityGroups(alice.identityId, ["cn=ops,ou=groups"]);
    await expect(store.listDirectoryMemberIds(groupId)).resolves.toEqual([]);
  });

  it("adds mapped-group policies to effective rules only while the source is enabled", async () => {
    const policy = await store.createPolicy({ name: "Auditors" });
    await store.setPolicyRules(policy.id, [{ permission: "audit.read" }]);
    await store.createBinding({ policyId: policy.id, principalType: "group", principalId: groupId });
    await store.createGroupMapping({ authSourceId: sourceId, externalGroup: "cn=devs,ou=groups", groupId });
    const alice = await directoryUser("alice", ["cn=devs,ou=groups"]);
    const permissions = async (): Promise<string[]> =>
      (await store.getEffectivePolicyRulesForUser(alice.userId)).map((rule) => rule.permission);

    expect(await permissions()).toContain("audit.read");

    await store.updateAuthSource(sourceId, { enabled: false });
    expect(await permissions()).not.toContain("audit.read");
    await expect(store.listDirectoryMemberIds(groupId)).resolves.toEqual([]);
  });

  it("keeps a directory user limited to mapped-group policies across a restart", async () => {
    const policy = await store.createPolicy({ name: "Auditors" });
    await store.setPolicyRules(policy.id, [{ permission: "audit.read" }]);
    await store.createBinding({ policyId: policy.id, principalType: "group", principalId: groupId });
    await store.createGroupMapping({ authSourceId: sourceId, externalGroup: "cn=devs,ou=groups", groupId });
    const alice = await directoryUser("alice", ["cn=devs,ou=groups"]);

    store.close();
    store = await SqliteStateStore.create(dbPath);

    await expect(store.listBindingsForPrincipal("user", alice.userId)).resolves.toEqual([]);
    const permissions = (await store.getEffectivePolicyRulesForUser(alice.userId)).map((rule) => rule.permission);
    expect(permissions).toContain("audit.read");
    expect(permissions).not.toContain("oauth.manage");
  });

  it("cascades mappings with their group and identity groups with their user", async () => {
    await store.createGroupMapping({ authSourceId: sourceId, externalGroup: "cn=devs,ou=groups", groupId });
    const alice = await directoryUser("alice", ["cn=devs,ou=groups"]);

    await store.deleteGroup(groupId);
    await expect(store.listGroupMappings(sourceId)).resolves.toEqual([]);

    await store.deleteUser(alice.userId);
    await expect(store.listIdentityGroups(alice.identityId)).resolves.toEqual([]);
  });

  it("stores the provisioning settings on the source", async () => {
    const created = await store.createAuthSource({ name: "Auto", kind: "ldap", configJson: "{}", autoProvision: true, defaultRole: "operator" });
    expect(created).toMatchObject({ autoProvision: true, defaultRole: "operator" });
    await expect(store.getAuthSourceById(sourceId)).resolves.toMatchObject({ autoProvision: false, defaultRole: "viewer" });

    await expect(store.updateAuthSource(created.id, { autoProvision: false, defaultRole: "viewer" }))
      .resolves.toMatchObject({ autoProvision: false, defaultRole: "viewer" });
  });
});
