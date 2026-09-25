import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

describe("authSourceStore", () => {
  let store: SqliteStateStore;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDatabasePath("ve-auth-sources"));
  });

  afterEach(() => {
    store.close();
  });

  it("creates and reads a source with defaults", async () => {
    const created = await store.createAuthSource({ name: "Corp LDAP", kind: "ldap", configJson: "{\"url\":\"ldaps://x\"}" });

    expect(created).toMatchObject({ name: "Corp LDAP", kind: "ldap", enabled: true, priority: 100, configJson: "{\"url\":\"ldaps://x\"}" });
    expect(created.createdAt).toBeInstanceOf(Date);
    await expect(store.getAuthSourceById(created.id)).resolves.toEqual(created);
    await expect(store.getAuthSourceById("missing")).resolves.toBeNull();
  });

  it("lists sources by ascending priority, then name", async () => {
    await store.createAuthSource({ name: "b", kind: "ldap", priority: 20, configJson: "{}" });
    await store.createAuthSource({ name: "a", kind: "ldap", priority: 20, configJson: "{}" });
    await store.createAuthSource({ name: "z", kind: "ldap", priority: 5, configJson: "{}" });

    expect((await store.listAuthSources()).map((source) => source.name)).toEqual(["z", "a", "b"]);
  });

  it("rejects duplicate names on create and rename", async () => {
    await store.createAuthSource({ name: "Corp", kind: "ldap", configJson: "{}" });
    const other = await store.createAuthSource({ name: "Other", kind: "ldap", configJson: "{}" });

    await expect(store.createAuthSource({ name: "Corp", kind: "ldap", configJson: "{}" })).rejects.toMatchObject({ code: "DUPLICATE" });
    await expect(store.updateAuthSource(other.id, { name: "Corp" })).rejects.toMatchObject({ code: "DUPLICATE" });
  });

  it("updates selected fields and deletes", async () => {
    const created = await store.createAuthSource({ name: "Corp", kind: "ldap", configJson: "{}" });

    const updated = await store.updateAuthSource(created.id, { enabled: false, priority: 3, configJson: "{\"a\":1}" });
    expect(updated).toMatchObject({ name: "Corp", enabled: false, priority: 3, configJson: "{\"a\":1}" });

    await expect(store.deleteAuthSource(created.id)).resolves.toBe(true);
    await expect(store.deleteAuthSource(created.id)).resolves.toBe(false);
    await expect(store.updateAuthSource(created.id, { enabled: true })).resolves.toBeNull();
  });
});
