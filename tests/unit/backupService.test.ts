import { lstat, mkdir, mkdtemp, readFile, readdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { extract as extractTar } from "tar";
import { decryptBackupFile, loadBackupKeyring } from "../../src/backup/backupCrypto.js";
import { createBackupService, type BackupServiceDeps } from "../../src/backup/backupService.js";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";
import { TEST_BACKUP_KEY_HEX, TEST_BACKUP_KEY_ID, writeTestBackupKeyring } from "./helpers/backupKeyring.js";

const ADMIN_AUTH_SECRET = "a".repeat(32);

describe("backup service", () => {
  let store: SqliteStateStore;
  let backupDir: string;
  let promptsDir: string;
  let backupKeyringFile: string;

  beforeEach(async () => {
    const databasePath = tempDatabasePath("ve-backup", { directory: true });
    store = await SqliteStateStore.create(databasePath);
    backupDir = join(dirname(databasePath), "backups");
    promptsDir = join(dirname(databasePath), "prompts");
    backupKeyringFile = join(dirname(databasePath), "backup-keyring.json");
    await writeTestBackupKeyring(backupKeyringFile);
    await mkdir(promptsDir, { recursive: true });
  });

  afterEach(() => {
    store.close();
  });

  it("creates a private, timestamped archive and lists it", async () => {
    const service = buildBackupService();

    const backup = await service.createBackup();

    expect(backup.filename).toMatch(/^ve-backup-\d{8}T\d{9}Z-[a-f\d]{8}\.tar\.gz\.enc$/);
    expect((await stat(join(backupDir, backup.filename))).mode & 0o077).toBe(0);
    expect((await readFile(join(backupDir, backup.filename))).subarray(0, 2)).not.toEqual(Buffer.from([0x1f, 0x8b]));
    expect((await readdir(backupDir)).filter((filename) => filename.endsWith(".tar.gz"))).toEqual([]);
    await expect(service.listBackups()).resolves.toEqual([backup]);
  });

  it("grants the configured group read access to existing and new archives", async () => {
    const privateService = buildBackupService();
    const existingBackup = await privateService.createBackup();
    const accessGid = process.getgid?.();
    if (accessGid === undefined) return;
    const service = buildBackupService({ backupAccessGid: accessGid });

    await service.listBackups();
    const directoryStat = await stat(backupDir);
    const existingStat = await stat(join(backupDir, existingBackup.filename));
    const newBackup = await service.createBackup();
    const newStat = await stat(join(backupDir, newBackup.filename));

    expect(directoryStat.gid).toBe(accessGid);
    expect(directoryStat.mode & 0o7777).toBe(0o2750);
    expect(existingStat.gid).toBe(accessGid);
    expect(existingStat.mode & 0o777).toBe(0o640);
    expect(newStat.gid).toBe(accessGid);
    expect(newStat.mode & 0o777).toBe(0o640);
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

    const service = buildBackupService();
    const backup = await service.createBackup();
    const extractedDir = join(dirname(backupDir), "session-scrubbing-inspection");
    await extractBackupArchive(backup.filename, extractedDir);
    const snapshot = new Database(join(extractedDir, "database.sqlite"), { readonly: true });
    try {
      const row = snapshot.prepare("SELECT COUNT(*) AS count FROM user_sessions").get() as { count: number };
      expect(row.count).toBe(0);
    } finally {
      snapshot.close();
    }
  });

  it("writes the authenticated manifest schema as format version 2", async () => {
    const service = buildBackupService();
    const backup = await service.createBackup();
    const extractedDir = join(dirname(backupDir), "manifest-inspection");
    await extractBackupArchive(backup.filename, extractedDir);
    const manifest = JSON.parse(await readFile(join(extractedDir, "manifest.json"), "utf8")) as Record<string, unknown>;

    expect(manifest["formatVersion"]).toBe(2);
    expect(manifest["authenticationTag"]).toMatch(/^[a-f\d]{64}$/);
    expect(manifest["promptOverrides"]).toEqual([]);
    expect(manifest).not.toHaveProperty("adminAuthSecretFingerprint");
  });

  it("orders case-colliding prompt filenames independently of the host locale", async () => {
    await writeFile(join(promptsDir, "i.md"), "lowercase\n", "utf8");
    await writeFile(join(promptsDir, "I.md"), "uppercase\n", "utf8");
    const service = buildBackupService();

    const backup = await service.createBackup();
    const extractedDir = join(dirname(backupDir), "case-order-inspection");
    await extractBackupArchive(backup.filename, extractedDir);
    const manifest = JSON.parse(await readFile(join(extractedDir, "manifest.json"), "utf8")) as {
      promptOverrides: Array<{ filename: string }>;
    };

    expect(manifest.promptOverrides.map(({ filename }) => filename)).toEqual(["I.md", "i.md"]);
  });

  it("keeps only the newest archives when retention is applied", async () => {
    const service = buildBackupService();
    const first = await service.createBackup();
    const second = await service.createBackup();
    const third = await service.createBackup();

    await expect(service.prune(2)).resolves.toEqual([first.filename]);
    await expect(service.listBackups()).resolves.toEqual([third, second]);
  });

  it("scavenges stale interrupted backups without touching new artifacts, symlinks, or archives", async () => {
    const service = buildBackupService();
    const archive = await service.createBackup();
    const staleStage = await mkdtemp(join(backupDir, ".ve-backup-"));
    const freshStage = await mkdtemp(join(backupDir, ".ve-backup-"));
    const partialPath = join(backupDir, `.${archive.filename}.partial`);
    const outsidePath = join(dirname(backupDir), "unrelated-staging-target");
    const linkedStage = join(backupDir, ".ve-backup-ABC123");
    await writeFile(join(staleStage, "database.sqlite"), "plaintext snapshot");
    await writeFile(partialPath, "interrupted ciphertext");
    await writeFile(outsidePath, "untouched");
    await symlink(outsidePath, linkedStage);
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(staleStage, oldTime, oldTime);
    await utimes(partialPath, oldTime, oldTime);

    await service.cleanupStaleArtifacts();

    expect(await readdir(backupDir)).not.toContain(basename(staleStage));
    expect(await readdir(backupDir)).not.toContain(basename(partialPath));
    expect((await lstat(freshStage)).isDirectory()).toBe(true);
    expect((await lstat(linkedStage)).isSymbolicLink()).toBe(true);
    expect(await readFile(outsidePath, "utf8")).toBe("untouched");
    await expect(service.listBackups()).resolves.toEqual([archive]);
  });

  it("cleans old interrupted staging before creating the next archive", async () => {
    const service = buildBackupService();
    await mkdir(backupDir, { recursive: true });
    const staleStage = await mkdtemp(join(backupDir, ".ve-backup-"));
    await writeFile(join(staleStage, "database.sqlite"), "plaintext snapshot");
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(staleStage, oldTime, oldTime);

    await service.createBackup();

    expect(await readdir(backupDir)).not.toContain(basename(staleStage));
  });

  it("rejects backup creation when the encryption secret is unavailable", async () => {
    const service = buildBackupService({ adminAuthSecret: undefined });

    await expect(service.createBackup()).rejects.toThrow("ADMIN_AUTH_SECRET");
    await expect(service.listBackups()).resolves.toEqual([]);
  });

  it("refuses to create a plaintext archive when no backup keyring is configured", async () => {
    const service = buildBackupService({ backupKeyringFile: undefined });

    await expect(service.createBackup()).rejects.toThrow("BACKUP_KEYRING_FILE");
    await expect(service.listBackups()).resolves.toEqual([]);
  });

  it("reveals both setup secrets only until the marker is acknowledged", async () => {
    const markerFile = join(dirname(backupKeyringFile), ".backup-keyring-onboarding-pending");
    const adminMarkerFile = join(dirname(backupKeyringFile), ".admin-auth-secret-onboarding-pending");
    await writeFile(markerFile, "", { encoding: "utf8", mode: 0o600 });
    await writeFile(adminMarkerFile, "", { encoding: "utf8", mode: 0o600 });
    const service = buildBackupService({
      backupKeyringOnboardingMarkerFile: markerFile,
      adminAuthSecretOnboardingMarkerFile: adminMarkerFile,
    });

    await expect(service.hasPendingSecuritySecretsOnboarding()).resolves.toBe(true);
    await expect(service.revealSecuritySecretsOnboarding()).resolves.toEqual({
      adminAuthSecret: ADMIN_AUTH_SECRET,
      backupKeyring: {
        format: "virtual-engineer-backup-keyring",
        version: 1,
        activeKeyId: TEST_BACKUP_KEY_ID,
        keys: { [TEST_BACKUP_KEY_ID]: TEST_BACKUP_KEY_HEX },
      },
    });
    await expect(service.acknowledgeSecuritySecretsOnboarding()).resolves.toBe(true);
    await expect(service.hasPendingSecuritySecretsOnboarding()).resolves.toBe(false);
    await expect(service.revealSecuritySecretsOnboarding()).resolves.toBeNull();
    await expect(service.acknowledgeSecuritySecretsOnboarding()).resolves.toBe(false);
  });

  it("does not reveal secrets when no onboarding marker exists", async () => {
    const service = buildBackupService({
      backupKeyringOnboardingMarkerFile: join(dirname(backupKeyringFile), ".missing-onboarding-marker"),
    });

    await expect(service.hasPendingSecuritySecretsOnboarding()).resolves.toBe(false);
    await expect(service.revealSecuritySecretsOnboarding()).resolves.toBeNull();
  });

  it("refuses to reveal setup secrets when ADMIN_AUTH_SECRET is not configured", async () => {
    const markerFile = join(dirname(backupKeyringFile), ".admin-auth-secret-onboarding-pending");
    await writeFile(markerFile, "", { encoding: "utf8", mode: 0o600 });
    const service = buildBackupService({
      adminAuthSecretOnboardingMarkerFile: markerFile,
      adminAuthSecret: undefined,
    });

    await expect(service.revealSecuritySecretsOnboarding()).rejects.toThrow("ADMIN_AUTH_SECRET");
  });

  it("requires the backup keyring to be stored outside the archive directory", async () => {
    await mkdir(backupDir, { recursive: true });
    const keyringInBackupDir = join(backupDir, "backup-keyring.json");
    await writeTestBackupKeyring(keyringInBackupDir);
    const service = buildBackupService({ backupKeyringFile: keyringInBackupDir });

    await expect(service.createBackup()).rejects.toThrow("outside BACKUP_DIR");
    await expect(service.listBackups()).resolves.toEqual([]);
  });

  function buildBackupService(overrides: Partial<BackupServiceDeps> = {}) {
    return createBackupService({
      backupDir,
      backupKeyringFile,
      promptsDir,
      stateStore: store,
      adminAuthSecret: ADMIN_AUTH_SECRET,
      ...overrides,
    });
  }

  async function extractBackupArchive(filename: string, destination: string): Promise<void> {
    await mkdir(destination, { recursive: true });
    const plaintextArchivePath = join(destination, "backup.tar.gz");
    await decryptBackupFile(
      join(backupDir, filename),
      plaintextArchivePath,
      await loadBackupKeyring(backupKeyringFile),
    );
    await extractTar({ file: plaintextArchivePath, cwd: destination, strict: true });
  }
});