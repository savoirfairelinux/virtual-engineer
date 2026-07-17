import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

function tempDbPath(): string {
  return tempDatabasePath("ve-settings");
}

describe("SqliteStateStore — app settings", () => {
  let store: SqliteStateStore;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
  });

  afterEach(() => {
    store.close();
  });

  it("returns all-null settings when no row exists", async () => {
    const settings = await store.getAppSettings();
    expect(settings).toEqual({
      pollingIntervalMs: null,
      maxAgentCycles: null,
      maxRetryAttempts: null,
    });
  });

  it("inserts and reads back a full settings payload", async () => {
    const next = await store.updateAppSettings({
      pollingIntervalMs: 15000,
      maxAgentCycles: 4,
      maxRetryAttempts: 8,
    });
    expect(next).toEqual({ pollingIntervalMs: 15000, maxAgentCycles: 4, maxRetryAttempts: 8 });

    const read = await store.getAppSettings();
    expect(read).toEqual({ pollingIntervalMs: 15000, maxAgentCycles: 4, maxRetryAttempts: 8 });
  });

  it("merges partial updates without clobbering unspecified fields", async () => {
    await store.updateAppSettings({ pollingIntervalMs: 15000, maxAgentCycles: 4, maxRetryAttempts: 8 });
    const merged = await store.updateAppSettings({ maxAgentCycles: 2 });
    expect(merged).toEqual({ pollingIntervalMs: 15000, maxAgentCycles: 2, maxRetryAttempts: 8 });
  });

  it("clears a value when passed an explicit null", async () => {
    await store.updateAppSettings({ pollingIntervalMs: 15000, maxAgentCycles: 4, maxRetryAttempts: 8 });
    const cleared = await store.updateAppSettings({ pollingIntervalMs: null });
    expect(cleared.pollingIntervalMs).toBeNull();
    expect(cleared.maxAgentCycles).toBe(4);
  });
});
