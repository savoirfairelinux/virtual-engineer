import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { createLocalPasswordAuthenticator } from "../../src/admin/authentication/localPasswordAuthenticator.js";
import { hashPassword } from "../../src/admin/authentication/passwordHash.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

describe("createLocalPasswordAuthenticator", () => {
  let store: SqliteStateStore;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDatabasePath("ve-local-auth"));
  });

  afterEach(() => {
    store.close();
  });

  async function createUser(username: string, password: string, enabled = true): Promise<string> {
    const user = await store.createUser({
      id: randomUUID(),
      username,
      passwordHash: await hashPassword(password),
      role: "operator",
      enabled,
    });
    return user.id;
  }

  it("authenticates an enabled user with the correct password", async () => {
    const id = await createUser("alice", "Correct-Horse-1");
    const outcome = await createLocalPasswordAuthenticator(store).authenticate("alice", "Correct-Horse-1");

    expect(outcome.status).toBe("authenticated");
    expect(outcome.status === "authenticated" ? outcome.user.id : undefined).toBe(id);
  });

  it("rejects a wrong password", async () => {
    await createUser("alice", "Correct-Horse-1");
    const outcome = await createLocalPasswordAuthenticator(store).authenticate("alice", "wrong-Password-2");

    expect(outcome).toEqual({ status: "rejected" });
  });

  it("rejects an unknown username", async () => {
    const outcome = await createLocalPasswordAuthenticator(store).authenticate("nobody", "Correct-Horse-1");

    expect(outcome).toEqual({ status: "rejected" });
  });

  it("rejects a disabled user even with the correct password", async () => {
    await createUser("alice", "Correct-Horse-1", false);
    const outcome = await createLocalPasswordAuthenticator(store).authenticate("alice", "Correct-Horse-1");

    expect(outcome).toEqual({ status: "rejected" });
  });

  it("rejects a user whose stored hash is not a scrypt hash", async () => {
    await store.createUser({ id: randomUUID(), username: "alice", passwordHash: "!external", role: "viewer" });
    const outcome = await createLocalPasswordAuthenticator(store).authenticate("alice", "!external");

    expect(outcome).toEqual({ status: "rejected" });
  });
});
