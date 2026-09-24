import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { extract as extractTar } from "tar";
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

  it("excludes active admin sessions from the archived SQLite snapshot", async () => {
    const user = await store.createUser({
      id: "backup-session-user",
      username: "backup-session-user",
      passwordHash: "test-password-hash",
      role: "admin",
    });
    const tokenHash = "e".repeat(64);
    await store.createSession({
      tokenHash,
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(store.getSessionByTokenHash(tokenHash)).resolves.not.toBeNull();

    const service = createBackupService({
      backupDir,
      promptsDir,
      stateStore: store,
      adminAuthSecret: ADMIN_AUTH_SECRET,
    });
    const backup = await service.createBackup();
    const extractedDir = join(dirname(backupDir), "session-scrubbing-inspection");
    await mkdir(extractedDir);
    await extractTar({ file: join(backupDir, backup.filename), cwd: extractedDir, strict: true });
    const snapshot = new Database(join(extractedDir, "database.sqlite"), { readonly: true });
    try {
      const row = snapshot.prepare("SELECT COUNT(*) AS count FROM user_sessions").get() as { count: number };
      expect(row.count).toBe(0);
    } finally {
      snapshot.close();
    }
  });

  it("writes the authenticated manifest schema as format version 2", async () => {
    const service = createBackupService({
      backupDir,
      promptsDir,
      stateStore: store,
      adminAuthSecret: ADMIN_AUTH_SECRET,
    });
    const backup = await service.createBackup();
    const extractedDir = join(dirname(backupDir), "manifest-inspection");
    await mkdir(extractedDir);
    await extractTar({ file: join(backupDir, backup.filename), cwd: extractedDir, strict: true });
    const manifest = JSON.parse(await readFile(join(extractedDir, "manifest.json"), "utf8")) as Record<string, unknown>;

    expect(manifest["formatVersion"]).toBe(2);
    expect(manifest["authenticationTag"]).toMatch(/^[a-f\d]{64}$/);
    expect(manifest["promptOverrides"]).toEqual([]);
    expect(manifest).not.toHaveProperty("adminAuthSecretFingerprint");
  });

  it("orders case-colliding prompt filenames independently of the host locale", async () => {
    await writeFile(join(promptsDir, "i.md"), "lowercase\n", "utf8");
    await writeFile(join(promptsDir, "I.md"), "uppercase\n", "utf8");
    const service = createBackupService({
      backupDir,
      promptsDir,
      stateStore: store,
      adminAuthSecret: ADMIN_AUTH_SECRET,
    });

    const backup = await service.createBackup();
    const extractedDir = join(dirname(backupDir), "case-order-inspection");
    await mkdir(extractedDir);
    await extractTar({ file: join(backupDir, backup.filename), cwd: extractedDir, strict: true });
    const manifest = JSON.parse(await readFile(join(extractedDir, "manifest.json"), "utf8")) as {
      promptOverrides: Array<{ filename: string }>;
    };

    expect(manifest.promptOverrides.map(({ filename }) => filename)).toEqual(["I.md", "i.md"]);
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