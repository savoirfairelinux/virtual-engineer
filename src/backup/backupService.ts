import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  chown,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
  open,
} from "node:fs/promises";
import { isAbsolute, parse, relative, resolve, sep, join } from "node:path";
import type { Readable } from "node:stream";
import { create as createTar } from "tar";
import { getLogger } from "../logger.js";
import { encryptBackupFile, loadBackupKeyring, type BackupKeyringFileContent } from "./backupCrypto.js";
import {
  createBackupManifest,
  isBackupFilename,
  MAX_BACKUP_ARCHIVE_ENTRIES,
  MAX_BACKUP_PROMPT_FILES,
  MAX_BACKUP_PROMPT_OVERRIDE_BYTES,
  parseBackupCreatedAt,
  sha256File,
  type BackupPromptOverride,
  type BackupInfo,
} from "./backupArchive.js";

const log = getLogger("backup");
const MIN_SECRET_LENGTH = 32;
const PROMPT_FILENAME_PATTERN = /^[A-Za-z0-9_-]+\.md$/;

export interface PendingSecuritySecrets {
  adminAuthSecret?: string;
  backupKeyring?: BackupKeyringFileContent;
}

export interface BackupStateStore {
  backupDatabaseTo(destinationPath: string): Promise<void>;
}

export interface BackupServiceDeps {
  backupDir: string;
  backupAccessGid?: number | undefined;
  backupKeyringFile?: string | undefined;
  backupKeyringOnboardingMarkerFile?: string | undefined;
  adminAuthSecretOnboardingMarkerFile?: string | undefined;
  promptsDir: string;
  stateStore: BackupStateStore;
  adminAuthSecret: string | undefined;
}

export interface BackupService {
  createBackup(): Promise<BackupInfo>;
  listBackups(): Promise<BackupInfo[]>;
  deleteBackup(filename: string): Promise<boolean>;
  prune(retentionCount: number): Promise<string[]>;
  openBackup(filename: string): Promise<{ info: BackupInfo; stream: Readable }>;
  hasPendingSecuritySecretsOnboarding(): Promise<boolean>;
  revealSecuritySecretsOnboarding(): Promise<PendingSecuritySecrets | null>;
  acknowledgeSecuritySecretsOnboarding(): Promise<boolean>;
}

export function createBackupService(deps: BackupServiceDeps): BackupService {
  const backupDir = resolve(deps.backupDir);
  const promptsDir = resolve(deps.promptsDir);
  if (backupDir === parse(backupDir).root) {
    throw new Error("BACKUP_DIR cannot be a filesystem root.");
  }

  let creationInFlight: Promise<BackupInfo> | undefined;
  async function openBackup(filename: string): Promise<{ info: BackupInfo; stream: Readable }> {
    if (!isBackupFilename(filename)) throw new Error("Invalid backup filename.");
    await ensureBackupDirectory();
    const filePath = join(backupDir, filename);
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const fileInfo = await handle.stat();
      const createdAt = parseBackupCreatedAt(filename);
      if (!fileInfo.isFile() || !createdAt) throw new Error("Backup path is not a regular backup archive.");
      return {
        info: { filename, createdAt, sizeBytes: fileInfo.size },
        stream: handle.createReadStream({ autoClose: true }),
      };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  let lastCreatedAtMs = 0;

  async function hasPendingSecuritySecretsOnboarding(): Promise<boolean> {
    const [adminPending, keyringPending] = await Promise.all([
      hasPendingOnboardingMarker(deps.adminAuthSecretOnboardingMarkerFile),
      hasPendingOnboardingMarker(deps.backupKeyringOnboardingMarkerFile),
    ]);
    return adminPending || keyringPending;
  }

  async function revealSecuritySecretsOnboarding(): Promise<PendingSecuritySecrets | null> {
    const [adminPending, keyringPending] = await Promise.all([
      hasPendingOnboardingMarker(deps.adminAuthSecretOnboardingMarkerFile),
      hasPendingOnboardingMarker(deps.backupKeyringOnboardingMarkerFile),
    ]);
    if (!adminPending && !keyringPending) return null;

    const secrets: PendingSecuritySecrets = {};
    if (adminPending) {
      if (!deps.adminAuthSecret) throw new Error("ADMIN_AUTH_SECRET is not configured for onboarding.");
      secrets.adminAuthSecret = deps.adminAuthSecret;
    }
    if (keyringPending) {
      const keyring = await loadBackupKeyring(deps.backupKeyringFile);
      secrets.backupKeyring = {
        format: "virtual-engineer-backup-keyring",
        version: 1,
        activeKeyId: keyring.activeKeyId,
        keys: Object.fromEntries(
          [...keyring.keys].map(([keyId, key]) => [keyId, key.toString("hex")]),
        ),
      };
    }
    return secrets;
  }

  async function acknowledgeSecuritySecretsOnboarding(): Promise<boolean> {
    let acknowledged = false;
    for (const markerFile of [deps.adminAuthSecretOnboardingMarkerFile, deps.backupKeyringOnboardingMarkerFile]) {
      if (!(await hasPendingOnboardingMarker(markerFile))) continue;
      try {
        await unlink(markerFile!);
        acknowledged = true;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") continue;
        throw error;
      }
    }
    return acknowledged;
  }

  async function ensureBackupDirectory(): Promise<void> {
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const info = await lstat(backupDir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("BACKUP_DIR must be a real directory, not a symbolic link.");
    }
    const accessGid = deps.backupAccessGid;
    if (accessGid === undefined) {
      await chmod(backupDir, 0o700);
      return;
    }

    if (info.gid !== accessGid) await chown(backupDir, info.uid, accessGid);
    await chmod(backupDir, 0o2750);
    const entries = await readdir(backupDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !isBackupFilename(entry.name)) continue;
      const filePath = join(backupDir, entry.name);
      const fileInfo = await lstat(filePath);
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) continue;
      if (fileInfo.gid !== accessGid) await chown(filePath, fileInfo.uid, accessGid);
      if ((fileInfo.mode & 0o777) !== 0o640) await chmod(filePath, 0o640);
    }
  }

  async function createBackup(): Promise<BackupInfo> {
    if (creationInFlight) return creationInFlight;
    const current = performBackup();
    creationInFlight = current;
    try {
      return await current;
    } finally {
      if (creationInFlight === current) creationInFlight = undefined;
    }
  }

  async function performBackup(): Promise<BackupInfo> {
    const secret = deps.adminAuthSecret;
    if (!secret || secret.length < MIN_SECRET_LENGTH) {
      throw new Error("ADMIN_AUTH_SECRET must be configured to create backups.");
    }
    if (deps.backupKeyringFile !== undefined
      && isPathInside(backupDir, resolve(deps.backupKeyringFile))) {
      throw new Error("BACKUP_KEYRING_FILE must be stored outside BACKUP_DIR.");
    }
    const keyring = await loadBackupKeyring(deps.backupKeyringFile);

    await ensureBackupDirectory();
    const timestampMs = Math.max(Date.now(), lastCreatedAtMs + 1);
    lastCreatedAtMs = timestampMs;
    const createdAtDate = new Date(timestampMs);
    const createdAt = createdAtDate.toISOString();
    const timestamp = createdAt.replace(/[-:.]/g, "");
    const filename = `ve-backup-${timestamp}-${randomUUID().slice(0, 8)}.tar.gz.enc`;
    const stagingDir = await mkdtemp(join(backupDir, ".ve-backup-"));
    const partialPath = join(backupDir, `.${filename}.partial`);
    const finalPath = join(backupDir, filename);

    try {
      await chmod(stagingDir, 0o700);
      const databasePath = join(stagingDir, "database.sqlite");
      await deps.stateStore.backupDatabaseTo(databasePath);
      await chmod(databasePath, 0o600);

      const promptOverrides = await copyPromptOverrides(promptsDir, stagingDir);
      const databaseSha256 = await sha256File(databasePath);
      const manifest = createBackupManifest(createdAt, databaseSha256, promptOverrides, secret);
      await writeFile(join(stagingDir, "manifest.json"), `${JSON.stringify(manifest)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });

      const archiveEntries = ["manifest.json", "database.sqlite"];
      if (promptOverrides.length > 0) archiveEntries.push("prompts");
      const entryCount = archiveEntries.length + promptOverrides.length;
      if (entryCount > MAX_BACKUP_ARCHIVE_ENTRIES) {
        throw new Error("Prompt overrides exceed the backup archive entry limit.");
      }
      const plaintextArchivePath = join(stagingDir, "backup.tar.gz");
      await createTar({ cwd: stagingDir, file: plaintextArchivePath, gzip: true, strict: true }, archiveEntries);
      await chmod(plaintextArchivePath, 0o600);
      await encryptBackupFile(plaintextArchivePath, partialPath, keyring);
      const accessGid = deps.backupAccessGid;
      const partialInfo = await lstat(partialPath);
      if (accessGid !== undefined) await chown(partialPath, partialInfo.uid, accessGid);
      await chmod(partialPath, accessGid === undefined ? 0o600 : 0o640);
      await rename(partialPath, finalPath);

      const archiveStat = await stat(finalPath);
      const info: BackupInfo = { filename, createdAt, sizeBytes: archiveStat.size };
      log.info({ filename, sizeBytes: archiveStat.size }, "backup archive created");
      return info;
    } catch (error) {
      log.error({ err: error, filename }, "backup archive creation failed");
      throw error;
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
      await rm(partialPath, { force: true });
    }
  }

  async function listBackups(): Promise<BackupInfo[]> {
    await ensureBackupDirectory();
    const entries = await readdir(backupDir, { withFileTypes: true });
    const backups: BackupInfo[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !isBackupFilename(entry.name)) continue;
      const createdAt = parseBackupCreatedAt(entry.name);
      if (!createdAt) continue;
      const filePath = join(backupDir, entry.name);
      const info = await lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      backups.push({ filename: entry.name, createdAt, sizeBytes: info.size });
    }
    return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt)
      || right.filename.localeCompare(left.filename));
  }

  async function deleteBackup(filename: string): Promise<boolean> {
    if (!isBackupFilename(filename)) throw new Error("Invalid backup filename.");
    await ensureBackupDirectory();
    const filePath = join(backupDir, filename);
    try {
      const info = await lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Backup path is not a regular file.");
      await unlink(filePath);
      log.info({ filename }, "backup archive deleted");
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }

  async function prune(retentionCount: number): Promise<string[]> {
    if (!Number.isInteger(retentionCount) || retentionCount < 1) {
      throw new Error("Backup retention must be a positive integer.");
    }
    const backups = await listBackups();
    const removed: string[] = [];
    for (const backup of backups.slice(retentionCount)) {
      if (await deleteBackup(backup.filename)) removed.push(backup.filename);
    }
    return removed;
  }

  return {
    createBackup,
    listBackups,
    deleteBackup,
    prune,
    openBackup,
    hasPendingSecuritySecretsOnboarding,
    revealSecuritySecretsOnboarding,
    acknowledgeSecuritySecretsOnboarding,
  };
}

async function hasPendingOnboardingMarker(markerFile: string | undefined): Promise<boolean> {
  if (!markerFile) return false;
  let handle;
  try {
    handle = await open(markerFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }

  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0) {
      throw new Error("Security secrets onboarding marker must be a private regular file.");
    }
    return true;
  } finally {
    await handle.close();
  }
}

async function copyPromptOverrides(promptsDir: string, stagingDir: string): Promise<BackupPromptOverride[]> {
  let entries;
  try {
    entries = await readdir(promptsDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }

  const promptTargetDir = join(stagingDir, "prompts");
  const copied: BackupPromptOverride[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !PROMPT_FILENAME_PATTERN.test(entry.name)) continue;
    if (copied.length >= MAX_BACKUP_PROMPT_FILES) {
      throw new Error("Prompt overrides exceed the backup file count limit.");
    }
    const sourcePath = join(promptsDir, entry.name);
    const sourceStat = await stat(sourcePath);
    if (sourceStat.size > MAX_BACKUP_PROMPT_OVERRIDE_BYTES) {
      throw new Error(`Prompt override '${entry.name}' exceeds the backup size limit.`);
    }
    if (copied.length === 0) await mkdir(promptTargetDir, { mode: 0o700 });
    const targetPath = join(promptTargetDir, entry.name);
    await copyFile(sourcePath, targetPath);
    await chmod(targetPath, 0o600);
    const copiedStat = await stat(targetPath);
    if (copiedStat.size > MAX_BACKUP_PROMPT_OVERRIDE_BYTES) {
      throw new Error(`Prompt override '${entry.name}' exceeds the backup size limit.`);
    }
    copied.push({ filename: entry.name, sha256: await sha256File(targetPath) });
  }
  return copied;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relativePath = relative(parentPath, candidatePath);
  return relativePath === ""
    || (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`));
}