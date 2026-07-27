import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

function tempDbPath(): string {
  return tempDatabasePath("ve-audit");
}

describe("auditStore", () => {
  let store: SqliteStateStore;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
  });

  afterEach(() => {
    store.close();
  });

  it("appends an entry with defaults and returns it parsed", async () => {
    const entry = await store.appendAuditEntry({
      actorName: "alice",
      action: "integration.create",
    });
    expect(entry.id).toBeGreaterThan(0);
    expect(entry.actorUserId).toBeNull();
    expect(entry.actorName).toBe("alice");
    expect(entry.action).toBe("integration.create");
    expect(entry.targetType).toBeNull();
    expect(entry.targetId).toBeNull();
    expect(entry.details).toEqual({});
    expect(entry.createdAt).toBeInstanceOf(Date);
  });

  it("serializes details into details_json and parses them on read", async () => {
    const entry = await store.appendAuditEntry({
      actorUserId: "u-1",
      actorName: "alice",
      action: "project.update",
      targetType: "project",
      targetId: "p-1",
      details: { name: "New Name", enabled: true },
    });
    expect(entry.actorUserId).toBe("u-1");
    expect(entry.targetType).toBe("project");
    expect(entry.targetId).toBe("p-1");
    expect(entry.details).toEqual({ name: "New Name", enabled: true });

    const { entries } = await store.listAuditEntries();
    expect(entries[0]?.details).toEqual({ name: "New Name", enabled: true });
  });

  it("lists entries newest-first (created_at DESC, id DESC)", async () => {
    await store.appendAuditEntry({ actorName: "a", action: "first" });
    await store.appendAuditEntry({ actorName: "a", action: "second" });
    await store.appendAuditEntry({ actorName: "a", action: "third" });

    const { entries, total } = await store.listAuditEntries();
    expect(total).toBe(3);
    expect(entries.map((e) => e.action)).toEqual(["third", "second", "first"]);
  });

  it("filters by action and actorName; total reflects the filter", async () => {
    await store.appendAuditEntry({ actorName: "alice", action: "task.pause" });
    await store.appendAuditEntry({ actorName: "alice", action: "task.resume" });
    await store.appendAuditEntry({ actorName: "bob", action: "task.pause" });

    const byAction = await store.listAuditEntries({ action: "task.pause" });
    expect(byAction.total).toBe(2);
    expect(byAction.entries.every((e) => e.action === "task.pause")).toBe(true);

    const byActor = await store.listAuditEntries({ actorName: "alice" });
    expect(byActor.total).toBe(2);
    expect(byActor.entries.every((e) => e.actorName === "alice")).toBe(true);

    const combined = await store.listAuditEntries({ action: "task.pause", actorName: "bob" });
    expect(combined.total).toBe(1);
    expect(combined.entries[0]?.actorName).toBe("bob");
  });

  it("paginates with limit and offset while total stays constant", async () => {
    for (let i = 0; i < 5; i++) {
      await store.appendAuditEntry({ actorName: "a", action: `action-${i}` });
    }

    const page1 = await store.listAuditEntries({ limit: 2, offset: 0 });
    expect(page1.total).toBe(5);
    expect(page1.entries.map((e) => e.action)).toEqual(["action-4", "action-3"]);

    const page2 = await store.listAuditEntries({ limit: 2, offset: 2 });
    expect(page2.total).toBe(5);
    expect(page2.entries.map((e) => e.action)).toEqual(["action-2", "action-1"]);

    const page3 = await store.listAuditEntries({ limit: 2, offset: 4 });
    expect(page3.entries.map((e) => e.action)).toEqual(["action-0"]);
  });

  it("defaults to a limit of 50 and caps the limit at 200", async () => {
    for (let i = 0; i < 205; i++) {
      await store.appendAuditEntry({ actorName: "a", action: "bulk" });
    }

    const defaulted = await store.listAuditEntries();
    expect(defaulted.entries.length).toBe(50);
    expect(defaulted.total).toBe(205);

    const capped = await store.listAuditEntries({ limit: 500 });
    expect(capped.entries.length).toBe(200);
    expect(capped.total).toBe(205);
  });
});
