import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeBackupSnapshot } from "../../src/state/backupSnapshot.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

describe("backup snapshot worker", () => {
  it("removes session contents and produces a standalone database before resolving", async () => {
    const databasePath = tempDatabasePath("ve-snapshot-worker", { directory: true });
    const database = new Database(databasePath);
    try {
      database.exec("PRAGMA journal_mode=WAL; CREATE TABLE user_sessions (token TEXT)");
      database.prepare("INSERT INTO user_sessions VALUES (?)").run("session-token-not-for-backup");
    } finally {
      database.close();
    }

    await sanitizeBackupSnapshot(databasePath);

    const snapshot = new Database(databasePath, { readonly: true });
    try {
      expect(snapshot.prepare("SELECT COUNT(*) AS count FROM user_sessions").get()).toEqual({ count: 0 });
      expect(snapshot.pragma("journal_mode", { simple: true })).toBe("delete");
    } finally {
      snapshot.close();
    }
    expect((await readFile(databasePath)).includes(Buffer.from("session-token-not-for-backup"))).toBe(false);
  });

  it("rejects worker failures instead of reporting an unsanitized snapshot as complete", async () => {
    const databasePath = tempDatabasePath("ve-snapshot-worker-failure", { directory: true });
    const database = new Database(databasePath);
    try {
      database.exec(`
        CREATE TABLE user_sessions (token TEXT);
        INSERT INTO user_sessions VALUES ('active-session');
        CREATE TRIGGER deny_session_cleanup BEFORE DELETE ON user_sessions
        BEGIN SELECT RAISE(ABORT, 'session cleanup denied'); END;
      `);
    } finally {
      database.close();
    }

    await expect(sanitizeBackupSnapshot(databasePath)).rejects.toThrow("session cleanup denied");
  });

  it("preserves errors when the snapshot cannot be opened in the worker", async () => {
    const databasePath = tempDatabasePath("ve-snapshot-worker-open-failure", { directory: true });

    await expect(sanitizeBackupSnapshot(dirname(databasePath))).rejects.toThrow("unable to open database file");
  });
});
