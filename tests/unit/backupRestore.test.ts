import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { restoreBackupIfRequested } from "../../src/backup/backupRestore.js";
import { createBackupService } from "../../src/backup/backupService.js";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

const ADMIN_AUTH_SECRET = "b".repeat(32);
const openStores: SqliteStateStore[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
});

async function createSourceBackup(): Promise<{ archivePath: string }> {
  const sourceDatabasePath = tempDatabasePath("ve-backup-restore-source", { directory: true });
  const sourceStore = await SqliteStateStore.create(sourceDatabasePath);
  openStores.push(sourceStore);
  await sourceStore.updateAppSettings({ maxAgentCycles: 9 });

  const sourceDir = dirname(sourceDatabasePath);
  const promptsDir = join(sourceDir, "prompts");
  await mkdir(promptsDir, { recursive: true });
  await writeFile(join(promptsDir, "system_generic_code.md"), "Restored system prompt\n", "utf8");

  const service = createBackupService({
    backupDir: join(sourceDir, "backups"),
    promptsDir,
    stateStore: sourceStore,
    adminAuthSecret: ADMIN_AUTH_SECRET,
  });
  const backup = await service.createBackup();
  return { archivePath: join(sourceDir, "backups", backup.filename) };
}

describe("backup restoration", () => {
  it("restores database data and prompt overrides before the state store opens", async () => {
    const { archivePath } = await createSourceBackup();
    const targetDatabasePath = tempDatabasePath("ve-backup-restore-target", { directory: true });

    const result = await restoreBackupIfRequested({
      databasePath: targetDatabasePath,
      restoreFrom: archivePath,
      adminAuthSecret: ADMIN_AUTH_SECRET,
      force: false,
    });

    expect(result).toEqual(expect.objectContaining({ status: "restored" }));
    const restoredStore = await SqliteStateStore.create(targetDatabasePath);
    openStores.push(restoredStore);
    await expect(restoredStore.getAppSettings()).resolves.toMatchObject({ maxAgentCycles: 9 });
    await expect(restoredStore.getPrompt("system_generic_code")).resolves.toMatchObject({
      content: "Restored system prompt\n",
    });

    await expect(restoreBackupIfRequested({
      databasePath: targetDatabasePath,
      restoreFrom: archivePath,
      adminAuthSecret: ADMIN_AUTH_SECRET,
      force: false,
    })).resolves.toEqual(expect.objectContaining({ status: "already-restored" }));
  });

  it("rejects a different ADMIN_AUTH_SECRET before installing the database", async () => {
    const { archivePath } = await createSourceBackup();
    const targetDatabasePath = tempDatabasePath("ve-backup-restore-wrong-secret", { directory: true });

    await expect(restoreBackupIfRequested({
      databasePath: targetDatabasePath,
      restoreFrom: archivePath,
      adminAuthSecret: "c".repeat(32),
      force: false,
    })).rejects.toThrow("original ADMIN_AUTH_SECRET");
    await expect(readdir(dirname(targetDatabasePath))).resolves.not.toContain("ve.db");
  });

  it("refuses to overwrite an existing database unless force is enabled", async () => {
    const { archivePath } = await createSourceBackup();
    const targetDatabasePath = tempDatabasePath("ve-backup-restore-existing", { directory: true });
    const targetStore = await SqliteStateStore.create(targetDatabasePath);
    await targetStore.updateAppSettings({ maxAgentCycles: 2 });
    targetStore.close();

    await expect(restoreBackupIfRequested({
      databasePath: targetDatabasePath,
      restoreFrom: archivePath,
      adminAuthSecret: ADMIN_AUTH_SECRET,
      force: false,
    })).rejects.toThrow("VE_RESTORE_FORCE");

    const unchangedStore = await SqliteStateStore.create(targetDatabasePath);
    openStores.push(unchangedStore);
    await expect(unchangedStore.getAppSettings()).resolves.toMatchObject({ maxAgentCycles: 2 });
  });

  it("preserves existing data before a forced replacement", async () => {
    const { archivePath } = await createSourceBackup();
    const targetDatabasePath = tempDatabasePath("ve-backup-restore-force", { directory: true });
    const targetStore = await SqliteStateStore.create(targetDatabasePath);
    await targetStore.updateAppSettings({ maxAgentCycles: 2 });
    targetStore.close();

    const result = await restoreBackupIfRequested({
      databasePath: targetDatabasePath,
      restoreFrom: archivePath,
      adminAuthSecret: ADMIN_AUTH_SECRET,
      force: true,
    });

    expect(result).toEqual(expect.objectContaining({
      status: "restored",
      previousDataDirectory: expect.any(String),
    }));
    const restoredStore = await SqliteStateStore.create(targetDatabasePath);
    openStores.push(restoredStore);
    await expect(restoredStore.getAppSettings()).resolves.toMatchObject({ maxAgentCycles: 9 });
  });
});