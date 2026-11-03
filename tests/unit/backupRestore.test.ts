import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { create as createTar, extract as extractTar } from "tar";
import { chmod, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { decryptBackupFile, encryptBackupFile, loadBackupKeyring, readBackupEncryptionHeader } from "../../src/backup/backupCrypto.js";
import {
  restoreBackupIfRequested as restoreWithKeyring,
  type RestoreBackupOptions,
} from "../../src/backup/backupRestore.js";
import { createBackupService } from "../../src/backup/backupService.js";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";
import { TEST_BACKUP_KEY_HEX, TEST_BACKUP_KEY_ID, writeTestBackupKeyring } from "./helpers/backupKeyring.js";

const ADMIN_AUTH_SECRET = "b".repeat(32);
const openStores: SqliteStateStore[] = [];
let backupKeyringFile: string;

beforeEach(async () => {
  const keyringDatabasePath = tempDatabasePath("ve-backup-restore-keyring", { directory: true });
  backupKeyringFile = join(dirname(keyringDatabasePath), "backup-keyring.json");
  await writeTestBackupKeyring(backupKeyringFile);
});

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
});

async function createSourceBackup(): Promise<{ archivePath: string; sourceStore: SqliteStateStore }> {
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
    backupKeyringFile,
    promptsDir,
    stateStore: sourceStore,
    adminAuthSecret: ADMIN_AUTH_SECRET,
  });
  const backup = await service.createBackup();
  return { archivePath: join(sourceDir, "backups", backup.filename), sourceStore };
}

describe("backup restoration", () => {
  it("restores both sides of a key rotation and preserves the old target on failed or forced restores", async () => {
    const { archivePath: oldArchive, sourceStore } = await createSourceBackup();
    const sourceDir = dirname(dirname(oldArchive));
    const newKeyId = "rotated-backup-key";
    await writeFile(backupKeyringFile, `${JSON.stringify({
      format: "virtual-engineer-backup-keyring",
      version: 1,
      activeKeyId: newKeyId,
      keys: { [TEST_BACKUP_KEY_ID]: TEST_BACKUP_KEY_HEX, [newKeyId]: "c".repeat(64) },
    })}\n`, { mode: 0o600 });
    await sourceStore.updateAppSettings({ maxAgentCycles: 12 });
    const newArchive = join(sourceDir, "backups", (await createBackupService({
      backupDir: dirname(oldArchive),
      backupKeyringFile,
      promptsDir: join(sourceDir, "prompts"),
      stateStore: sourceStore,
      adminAuthSecret: ADMIN_AUTH_SECRET,
    }).createBackup()).filename);
    await expect(readBackupEncryptionHeader(oldArchive)).resolves.toMatchObject({ keyId: TEST_BACKUP_KEY_ID });
    await expect(readBackupEncryptionHeader(newArchive)).resolves.toMatchObject({ keyId: newKeyId });

    const targetDatabasePath = tempDatabasePath("ve-backup-key-rotation", { directory: true });
    await restoreBackupIfRequested({
      databasePath: targetDatabasePath,
      restoreFrom: oldArchive,
      adminAuthSecret: ADMIN_AUTH_SECRET,
      force: false,
    });
    const originalStore = await SqliteStateStore.create(targetDatabasePath);
    await expect(originalStore.getAppSettings()).resolves.toMatchObject({ maxAgentCycles: 9 });
    originalStore.close();

    await expect(restoreBackupIfRequested({
      databasePath: targetDatabasePath,
      restoreFrom: newArchive,
      adminAuthSecret: ADMIN_AUTH_SECRET,
      force: false,
    })).rejects.toThrow("VE_RESTORE_FORCE");

    const incorrectKeyringFile = join(dirname(backupKeyringFile), "incorrect-keyring.json");
    await writeFile(incorrectKeyringFile, `${JSON.stringify({
      format: "virtual-engineer-backup-keyring",
      version: 1,
      activeKeyId: newKeyId,
      keys: { [newKeyId]: "f".repeat(64) },
    })}\n`, { mode: 0o600 });
    await expect(restoreWithKeyring({
      databasePath: targetDatabasePath,
      restoreFrom: newArchive,
      backupKeyringFile: incorrectKeyringFile,
      adminAuthSecret: ADMIN_AUTH_SECRET,
      force: true,
    })).rejects.toThrow(/authentication/i);
    await expect(restoreBackupIfRequested({
      databasePath: targetDatabasePath,
      restoreFrom: newArchive,
      adminAuthSecret: "wrong-secret-".repeat(4),
      force: true,
    })).rejects.toThrow(/ADMIN_AUTH_SECRET/);
    const unchangedStore = await SqliteStateStore.create(targetDatabasePath);
    await expect(unchangedStore.getAppSettings()).resolves.toMatchObject({ maxAgentCycles: 9 });
    unchangedStore.close();

    const result = await restoreBackupIfRequested({
      databasePath: targetDatabasePath,
      restoreFrom: newArchive,
      adminAuthSecret: ADMIN_AUTH_SECRET,
      force: true,
    });
    expect(result?.status).toBe("restored");
    if (!result?.previousDataDirectory) throw new Error("Expected old data to be preserved");
    const preservedDatabase = new Database(join(result.previousDataDirectory, "ve.db"), { readonly: true });
    try {
      expect(preservedDatabase.prepare("SELECT max_agent_cycles FROM app_settings WHERE id = 'global'").get())
        .toMatchObject({ max_agent_cycles: 9 });
    } finally {
      preservedDatabase.close();
    }
    const restoredStore = await SqliteStateStore.create(targetDatabasePath);
    openStores.push(restoredStore);
    await expect(restoredStore.getAppSettings()).resolves.toMatchObject({ maxAgentCycles: 12 });
  });

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

  it("restores legacy plaintext tar.gz archives", async () => {
    const { archivePath } = await createSourceBackup();
    const legacyArchivePath = join(dirname(archivePath), "legacy-backup.tar.gz");
    await decryptBackupFile(archivePath, legacyArchivePath, await loadBackupKeyring(backupKeyringFile));
    const targetDatabasePath = tempDatabasePath("ve-backup-restore-legacy", { directory: true });

    await restoreBackupIfRequested({
      databasePath: targetDatabasePath,
      restoreFrom: legacyArchivePath,
      adminAuthSecret: ADMIN_AUTH_SECRET,
      force: false,
    });

    const restoredStore = await SqliteStateStore.create(targetDatabasePath);
    openStores.push(restoredStore);
    await expect(restoredStore.getAppSettings()).resolves.toMatchObject({ maxAgentCycles: 9 });
  });

  it("does not parse a corrupted encrypted envelope as a legacy gzip archive", async () => {
    const { archivePath } = await createSourceBackup();
    const renamedCorruptArchive = join(dirname(archivePath), "renamed-corrupt.tar.gz");
    const contents = await readFile(archivePath);
    const tagOffset = contents.length - 1;
    contents[tagOffset] = (contents[tagOffset] ?? 0) ^ 0xff;
    await writeFile(renamedCorruptArchive, contents, { mode: 0o600 });
    const targetDatabasePath = tempDatabasePath("ve-backup-restore-invalid-envelope", { directory: true });

    await expect(restoreBackupIfRequested({
      databasePath: targetDatabasePath,
      restoreFrom: renamedCorruptArchive,
      adminAuthSecret: ADMIN_AUTH_SECRET,
      force: false,
    })).rejects.toThrow("authentication failed");
    await expect(readdir(dirname(targetDatabasePath))).resolves.not.toContain("ve.db");
  });

  it("rejects a different ADMIN_AUTH_SECRET before installing the database", async () => {
    const { archivePath } = await createSourceBackup();
    const targetDatabasePath = tempDatabasePath("ve-backup-restore-wrong-secret", { directory: true });

    await expect(restoreBackupIfRequested({
      databasePath: targetDatabasePath,
      restoreFrom: archivePath,
      adminAuthSecret: "c".repeat(32),
      force: false,
    })).rejects.toThrow(/ADMIN_AUTH_SECRET/);
    await expect(readdir(dirname(targetDatabasePath))).resolves.not.toContain("ve.db");
  });

  it("does not replace existing state when encrypted archive authentication fails", async () => {
    const { archivePath } = await createSourceBackup();
    const targetDatabasePath = tempDatabasePath("ve-backup-restore-bad-tag", { directory: true });
    const originalStore = await SqliteStateStore.create(targetDatabasePath);
    await originalStore.updateAppSettings({ maxAgentCycles: 2 });
    originalStore.close();

    const tamperedArchive = await readFile(archivePath);
    tamperedArchive[tamperedArchive.length - 1] = (tamperedArchive[tamperedArchive.length - 1] ?? 0) ^ 1;
    await writeFile(archivePath, tamperedArchive);

    await expect(restoreBackupIfRequested({
      databasePath: targetDatabasePath,
      restoreFrom: archivePath,
      adminAuthSecret: ADMIN_AUTH_SECRET,
      force: true,
    })).rejects.toThrow(/authentication/i);

    const unchangedStore = await SqliteStateStore.create(targetDatabasePath);
    openStores.push(unchangedStore);
    await expect(unchangedStore.getAppSettings()).resolves.toMatchObject({ maxAgentCycles: 2 });
  });

  it("rejects modified prompt content when its manifest remains unchanged", async () => {
    const { archivePath } = await createSourceBackup();
    const tamperedArchive = await rewriteBackup(archivePath, async (directory) => {
      const promptPath = join(directory, "prompts", "system_generic_code.md");
      await writeFile(promptPath, "Injected prompt\n", "utf8");
    });
    const targetDatabasePath = tempDatabasePath("ve-backup-restore-tampered-prompt", { directory: true });

    await expect(restoreBackupIfRequested({
      databasePath: targetDatabasePath,
      restoreFrom: tamperedArchive,
      adminAuthSecret: ADMIN_AUTH_SECRET,
      force: false,
    })).rejects.toThrow("prompt");
  });

  it("forces restrictive permissions when archive headers request permissive modes", async () => {
    const { archivePath } = await createSourceBackup();
    const permissiveArchive = await rewriteBackup(archivePath, async (directory) => {
      await chmod(join(directory, "database.sqlite"), 0o777);
      await chmod(join(directory, "prompts"), 0o777);
      await chmod(join(directory, "prompts", "system_generic_code.md"), 0o777);
    });
    const targetDatabasePath = tempDatabasePath("ve-backup-restore-permissions", { directory: true });
    const promptsPath = join(dirname(targetDatabasePath), "prompts");

    await restoreBackupIfRequested({
      databasePath: targetDatabasePath,
      restoreFrom: permissiveArchive,
      adminAuthSecret: ADMIN_AUTH_SECRET,
      force: false,
    });

    expect((await stat(targetDatabasePath)).mode & 0o777).toBe(0o600);
    expect((await stat(promptsPath)).mode & 0o777).toBe(0o700);
    expect((await stat(join(promptsPath, "system_generic_code.md"))).mode & 0o777).toBe(0o600);
  });

  it("rejects a modified database even when its public checksum is recomputed", async () => {
    const { archivePath } = await createSourceBackup();
    const tamperedArchive = await rewriteBackup(archivePath, async (directory, manifest) => {
      const database = new Database(join(directory, "database.sqlite"));
      try {
        database.prepare("UPDATE app_settings SET max_agent_cycles = ? WHERE id = ?").run(7, "global");
      } finally {
        database.close();
      }
      manifest["databaseSha256"] = await sha256File(join(directory, "database.sqlite"));
    });
    const targetDatabasePath = tempDatabasePath("ve-backup-restore-tampered-database", { directory: true });

    await expect(restoreBackupIfRequested({
      databasePath: targetDatabasePath,
      restoreFrom: tamperedArchive,
      adminAuthSecret: ADMIN_AUTH_SECRET,
      force: false,
    })).rejects.toThrow("authentication");
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

  it("does not reapply a completed forced restore on restart", async () => {
    const { archivePath } = await createSourceBackup();
    const targetDatabasePath = tempDatabasePath("ve-backup-restore-force-restart", { directory: true });
    const originalStore = await SqliteStateStore.create(targetDatabasePath);
    await originalStore.updateAppSettings({ maxAgentCycles: 2 });
    originalStore.close();

    await restoreBackupIfRequested({
      databasePath: targetDatabasePath,
      restoreFrom: archivePath,
      adminAuthSecret: ADMIN_AUTH_SECRET,
      force: true,
    });
    const restoredStore = await SqliteStateStore.create(targetDatabasePath);
    await restoredStore.updateAppSettings({ maxAgentCycles: 3 });
    restoredStore.close();

    await expect(restoreBackupIfRequested({
      databasePath: targetDatabasePath,
      restoreFrom: archivePath,
      adminAuthSecret: ADMIN_AUTH_SECRET,
      force: true,
    })).resolves.toEqual(expect.objectContaining({ status: "already-restored" }));

    const currentStore = await SqliteStateStore.create(targetDatabasePath);
    openStores.push(currentStore);
    await expect(currentStore.getAppSettings()).resolves.toMatchObject({ maxAgentCycles: 3 });
  });

  it("detects a replacement archive even when its path, size, and mtime are unchanged", async () => {
    const { archivePath } = await createSourceBackup();
    const targetDatabasePath = tempDatabasePath("ve-backup-restore-replaced-source", { directory: true });
    const preservedTimestamp = new Date(1_700_000_000_000);
    await utimes(archivePath, preservedTimestamp, preservedTimestamp);
    const originalStat = await stat(archivePath);

    await restoreBackupIfRequested({
      databasePath: targetDatabasePath,
      restoreFrom: archivePath,
      adminAuthSecret: ADMIN_AUTH_SECRET,
      force: true,
    });
    const changedStore = await SqliteStateStore.create(targetDatabasePath);
    await changedStore.updateAppSettings({ maxAgentCycles: 3 });
    changedStore.close();

    const plaintextArchivePath = `${archivePath}.replacement.tar.gz`;
    const replacementArchivePath = `${archivePath}.replacement.enc`;
    await decryptBackupFile(archivePath, plaintextArchivePath, await loadBackupKeyring(backupKeyringFile));
    await encryptBackupFile(
      plaintextArchivePath,
      replacementArchivePath,
      await loadBackupKeyring(backupKeyringFile),
    );
    const replacement = await readFile(replacementArchivePath);
    await writeFile(archivePath, replacement);
    await utimes(archivePath, preservedTimestamp, preservedTimestamp);
    const replacementStat = await stat(archivePath);
    expect(replacementStat.size).toBe(originalStat.size);
    expect(replacementStat.mtimeMs).toBe(originalStat.mtimeMs);

    await expect(restoreBackupIfRequested({
      databasePath: targetDatabasePath,
      restoreFrom: archivePath,
      adminAuthSecret: ADMIN_AUTH_SECRET,
      force: true,
    })).resolves.toEqual(expect.objectContaining({ status: "restored" }));

    const restoredStore = await SqliteStateStore.create(targetDatabasePath);
    openStores.push(restoredStore);
    await expect(restoredStore.getAppSettings()).resolves.toMatchObject({ maxAgentCycles: 9 });
  });

  it("does not trust a matching restore marker when its database is missing", async () => {
    const { archivePath } = await createSourceBackup();
    const targetDatabasePath = tempDatabasePath("ve-backup-restore-stale-marker", { directory: true });
    const options = {
      databasePath: targetDatabasePath,
      restoreFrom: archivePath,
      adminAuthSecret: ADMIN_AUTH_SECRET,
      force: false,
    };
    await restoreBackupIfRequested(options);
    await rm(targetDatabasePath);

    await expect(restoreBackupIfRequested(options)).rejects.toThrow("installed database or prompts are missing");
  });

  it("rejects archives beyond the entry limit while listing entries", async () => {
    const targetDatabasePath = tempDatabasePath("ve-backup-restore-too-many-entries", { directory: true });
    const archiveDirectory = dirname(tempDatabasePath("ve-backup-many-entries-source", { directory: true }));
    const promptDirectory = join(archiveDirectory, "prompts");
    const databasePath = join(archiveDirectory, "database.sqlite");
    const archivePath = join(archiveDirectory, "too-many-entries.tar.gz");
    await mkdir(promptDirectory, { recursive: true });
    await writeFile(join(archiveDirectory, "manifest.json"), "{}\n", "utf8");
    await writeFile(databasePath, "not a database", "utf8");
    for (let index = 0; index < 257; index += 1) {
      await writeFile(join(promptDirectory, `override-${index}.md`), "prompt\n", "utf8");
    }
    await createTar({ cwd: archiveDirectory, file: archivePath, gzip: true, strict: true }, [
      "manifest.json",
      "database.sqlite",
      "prompts",
    ]);

    await expect(restoreBackupIfRequested({
      databasePath: targetDatabasePath,
      restoreFrom: archivePath,
      adminAuthSecret: ADMIN_AUTH_SECRET,
      force: false,
    })).rejects.toThrow("too many files");
  });
});

async function rewriteBackup(
  archivePath: string,
  update: (directory: string, manifest: Record<string, unknown>) => Promise<void>,
): Promise<string> {
  const directory = join(dirname(archivePath), `tampered-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(directory, { recursive: true });
  const plaintextArchivePath = join(directory, "source.tar.gz");
  await decryptBackupFile(archivePath, plaintextArchivePath, await loadBackupKeyring(backupKeyringFile));
  await extractTar({ file: plaintextArchivePath, cwd: directory, strict: true });
  const manifestPath = join(directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  await update(directory, manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  const rewrittenPlaintextPath = join(directory, "rewritten.tar.gz");
  const rewrittenPath = `${archivePath}.tampered.tar.gz.enc`;
  await createTar({ cwd: directory, file: rewrittenPlaintextPath, gzip: true, strict: true }, [
    "manifest.json",
    "database.sqlite",
    "prompts",
  ]);
  await encryptBackupFile(
    rewrittenPlaintextPath,
    rewrittenPath,
    await loadBackupKeyring(backupKeyringFile),
  );
  return rewrittenPath;
}

async function sha256File(filePath: string): Promise<string> {
  const contents = await readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

async function restoreBackupIfRequested(
  options: Omit<RestoreBackupOptions, "backupKeyringFile">,
) {
  return restoreWithKeyring({ ...options, backupKeyringFile });
}