import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createBackupService } from "../../src/backup/backupService.js";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

const ADMIN_AUTH_SECRET = "a".repeat(32);

describe("backup service", () => {
  let store: SqliteStateStore;
  let backupDir: string;
  let promptsDir: string;

  beforeEach(async () => {
    const databasePath = tempDatabasePath("ve-backup", { directory: true });
    store = await SqliteStateStore.create(databasePath);
    backupDir = join(dirname(databasePath), "backups");
    promptsDir = join(dirname(databasePath), "prompts");
    await mkdir(promptsDir, { recursive: true });
  });

  afterEach(() => {
    store.close();
  });

  it("creates a private, timestamped archive and lists it", async () => {
    const service = createBackupService({
      backupDir,
      promptsDir,
      stateStore: store,
      adminAuthSecret: ADMIN_AUTH_SECRET,
    });

    const backup = await service.createBackup();

    expect(backup.filename).toMatch(/^ve-backup-\d{8}T\d{9}Z-[a-f\d]{8}\.tar\.gz$/);
    expect((await stat(join(backupDir, backup.filename))).mode & 0o077).toBe(0);
    await expect(service.listBackups()).resolves.toEqual([backup]);
  });

  it("keeps only the newest archives when retention is applied", async () => {
    const service = createBackupService({
      backupDir,
      promptsDir,
      stateStore: store,
      adminAuthSecret: ADMIN_AUTH_SECRET,
    });
    const first = await service.createBackup();
    const second = await service.createBackup();
    const third = await service.createBackup();

    await expect(service.prune(2)).resolves.toEqual([first.filename]);
    await expect(service.listBackups()).resolves.toEqual([third, second]);
  });

  it("rejects backup creation when the encryption secret is unavailable", async () => {
    const service = createBackupService({
      backupDir,
      promptsDir,
      stateStore: store,
      adminAuthSecret: undefined,
    });

    await expect(service.createBackup()).rejects.toThrow("ADMIN_AUTH_SECRET");
    await expect(service.listBackups()).resolves.toEqual([]);
  });
});