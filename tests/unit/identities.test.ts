import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import {
  applyIdentitySignature,
  resolveProjectIdentity,
} from "../../src/utils/identitySignature.js";
import type { IdentityRecord } from "../../src/interfaces.js";

function tempDbPath(): string {
  return join(tmpdir(), `ve-identities-${randomUUID()}.db`);
}

async function makeAgent(store: SqliteStateStore) {
  return store.createAgent({
    name: "Coding Agent",
    type: "coding",
    modelConfigJson: JSON.stringify({ model: "gpt-4.1", apiKey: "tok" }),
    enabled: true,
  });
}

describe("SqliteStateStore — identities", () => {
  let store: SqliteStateStore;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
  });

  afterEach(() => {
    store.close();
  });

  it("creates and retrieves an identity with defaults", async () => {
    const identity = await store.createIdentity({ name: "Virtual Engineer" });
    expect(identity.name).toBe("Virtual Engineer");
    expect(identity.email).toBe("");
    expect(identity.username).toBe("");
    expect(identity.signature).toBe("");
    const fetched = await store.getIdentityById(identity.id);
    expect(fetched?.id).toBe(identity.id);
  });

  it("persists all identity fields", async () => {
    const identity = await store.createIdentity({
      name: "VE Bot",
      email: "ve@example.com",
      username: "ve-bot",
      signature: "— Virtual Engineer",
    });
    expect(identity.email).toBe("ve@example.com");
    expect(identity.username).toBe("ve-bot");
    expect(identity.signature).toBe("— Virtual Engineer");
  });

  it("lists identities ordered by name", async () => {
    await store.createIdentity({ name: "Zeta" });
    await store.createIdentity({ name: "Alpha" });
    const list = await store.listIdentities();
    expect(list.map((i) => i.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("updates mutable identity fields", async () => {
    const identity = await store.createIdentity({ name: "Old" });
    const updated = await store.updateIdentity(identity.id, {
      name: "New",
      signature: "sig",
    });
    expect(updated.name).toBe("New");
    expect(updated.signature).toBe("sig");
  });

  it("links a workflow (project) to an identity and detaches on delete", async () => {
    const agent = await makeAgent(store);
    const identity = await store.createIdentity({ name: "VE", signature: "— VE" });
    const project = await store.createProject({
      name: "Coding",
      type: "coding",
      agentId: agent.id,
      identityId: identity.id,
    });
    expect(project.identityId).toBe(identity.id);

    const cleared = await store.updateProject(project.id, { identityId: null });
    expect(cleared.identityId).toBeNull();

    const relinked = await store.updateProject(project.id, { identityId: identity.id });
    expect(relinked.identityId).toBe(identity.id);

    await store.deleteIdentity(identity.id);
    const after = await store.getProjectById(project.id);
    expect(after?.identityId).toBeNull();
    expect(await store.getIdentityById(identity.id)).toBeNull();
  });

  it("defaults project identity to null when unset", async () => {
    const agent = await makeAgent(store);
    const project = await store.createProject({
      name: "NoIdentity",
      type: "coding",
      agentId: agent.id,
    });
    expect(project.identityId).toBeNull();
  });
});

describe("identity signature helpers", () => {
  const identity: IdentityRecord = {
    id: "id-1" as IdentityRecord["id"],
    name: "VE",
    email: "",
    username: "",
    signature: "— Virtual Engineer",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("appends the signature to a body", () => {
    expect(applyIdentitySignature("Looks good.", identity)).toBe(
      "Looks good.\n\n— Virtual Engineer"
    );
  });

  it("is a no-op without an identity", () => {
    expect(applyIdentitySignature("Body", null)).toBe("Body");
  });

  it("is a no-op when the signature is empty", () => {
    expect(applyIdentitySignature("Body", { ...identity, signature: "  " })).toBe("Body");
  });

  it("does not append the signature twice", () => {
    const once = applyIdentitySignature("Body", identity);
    expect(applyIdentitySignature(once, identity)).toBe(once);
  });

  it("resolves a project's identity via the store", async () => {
    const store = { getIdentityById: async () => identity };
    expect(await resolveProjectIdentity(store, { identityId: "id-1" })).toBe(identity);
    expect(await resolveProjectIdentity(store, { identityId: null })).toBeNull();
    expect(await resolveProjectIdentity(store, null)).toBeNull();
  });
});
