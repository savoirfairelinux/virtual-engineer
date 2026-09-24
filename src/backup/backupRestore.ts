import Database from "better-sqlite3";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { extract as extractTar, list as listTar } from "tar";
import { getLogger } from "../logger.js";
import { runDatabaseMigrations } from "../state/databaseMigrations.js";
import {
  fingerprintAdminAuthSecret,
  verifyBackupManifest,
  sha256File,
} from "./backupArchive.js";

const log = getLogger("backup-restore");
const MAX_ARCHIVE_ENTRIES = 258;
const MAX_DATABASE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PROMPT_OVERRIDE_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_FILES = 256;

interface ArchiveEntry {
  path: string;
  type: string;
  size: number;
}

interface RestoreMarker {
  format: "virtual-engineer-restore-marker";
  version: 1;
  archivePath: string;
  archiveSize: number;
  archiveMtimeMs: number;
  databaseSha256: string;
  adminAuthSecretFingerprint: string;
}

export interface RestoreBackupOptions {
  databasePath: string;
  restoreFrom: string | undefined;
  adminAuthSecret: string | undefined;
  force: boolean;
}

export interface BackupRestoreResult {
  status: "restored" | "already-restored";
  databaseSha256: string;
  previousDataDirectory: string | null;
}

export async function restoreBackupIfRequested(
  options: RestoreBackupOptions
): Promise<BackupRestoreResult | null> {
  if (!options.restoreFrom) return null;

  const databasePath = resolve(options.databasePath);
  const databaseDir = dirname(databasePath);
  const promptsPath = join(databaseDir, "prompts");
  const archivePath = resolve(options.restoreFrom);
  const markerPath = `${databasePath}.restore-marker`;
  await mkdir(databaseDir, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(databaseDir);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error("The database directory must be a real directory before restore.");
  }

  const archiveInfo = await lstat(archivePath);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink()) {
    throw new Error("Restore source must be a regular archive file.");
  }
  const archiveStat = await stat(archivePath);

  if (!options.force) {
    const marker = await readRestoreMarker(markerPath);
    if (markerMatches(marker, archivePath, archiveStat, options.adminAuthSecret)) {
      log.info({ archivePath, databaseSha256: marker.databaseSha256 }, "backup restore already applied");
      return {
        status: "already-restored",
        databaseSha256: marker.databaseSha256,
        previousDataDirectory: null,
      };
    }
  }

  const existingTargets = await existingRestoreTargets(databasePath, promptsPath, markerPath);
  if (existingTargets.length > 0 && !options.force) {
    throw new Error("Restore target already contains data; set VE_RESTORE_FORCE=true to preserve and replace it.");
  }

  log.warn({ archivePath }, "restore requested; stop the previous Virtual Engineer instance before continuing");
  const stagingDir = await mkdtemp(join(databaseDir, ".ve-restore-"));
  await chmod(stagingDir, 0o700);
  const movedTargets: Array<{ originalPath: string; preservedPath: string }> = [];
  let quarantineDir: string | null = null;
  let installedDatabase = false;
  let installedPrompts = false;

  try {
    const archiveEntries = await inspectArchive(archivePath);
    validateArchiveEntries(archiveEntries);
    await extractTar({
      file: archivePath,
      cwd: stagingDir,
      strict: true,
      preservePaths: false,
      preserveOwner: false,
      unlink: true,
      maxDepth: 2,
      filter: (entryPath) => isAllowedArchivePath(entryPath),
    });

    const manifest = verifyBackupManifest(
      parseJson(await readFile(join(stagingDir, "manifest.json"), "utf8")),
      options.adminAuthSecret
    );
    const stagedDatabasePath = join(stagingDir, "database.sqlite");
    const actualDatabaseSha256 = await sha256File(stagedDatabasePath);
    if (actualDatabaseSha256 !== manifest.databaseSha256) {
      throw new Error("Backup database checksum does not match its manifest.");
    }
    migrateAndValidateDatabase(stagedDatabasePath);

    const stagedPromptsPath = join(stagingDir, "prompts");
    await mkdir(stagedPromptsPath, { recursive: true, mode: 0o700 });
    for (const entry of archiveEntries) {
      const entryPath = normalizedEntryPath(entry.path);
      if (!entryPath.startsWith("prompts/")) continue;
      await chmod(join(stagingDir, entryPath), 0o600);
    }

    try {
      if (existingTargets.length > 0) {
        const stamp = new Date().toISOString().replace(/[-:.]/g, "");
        quarantineDir = join(databaseDir, `.pre-restore-${stamp}-${randomUUID().slice(0, 8)}`);
        await mkdir(quarantineDir, { mode: 0o700 });
        for (const originalPath of existingTargets) {
          const preservedPath = join(quarantineDir, basename(originalPath));
          await rename(originalPath, preservedPath);
          movedTargets.push({ originalPath, preservedPath });
        }
      }

      await rename(stagedDatabasePath, databasePath);
      installedDatabase = true;
      await rename(stagedPromptsPath, promptsPath);
      installedPrompts = true;
      await writeRestoreMarker(markerPath, {
        format: "virtual-engineer-restore-marker",
        version: 1,
        archivePath,
        archiveSize: archiveStat.size,
        archiveMtimeMs: archiveStat.mtimeMs,
        databaseSha256: manifest.databaseSha256,
        adminAuthSecretFingerprint: fingerprintAdminAuthSecret(options.adminAuthSecret ?? ""),
      });
    } catch (error) {
      if (installedPrompts) await rm(promptsPath, { recursive: true, force: true });
      if (installedDatabase) {
        await rm(databasePath, { force: true });
        await rm(`${databasePath}-wal`, { force: true });
        await rm(`${databasePath}-shm`, { force: true });
      }
      let rollbackFailed = false;
      for (const moved of movedTargets.reverse()) {
        try {
          await rename(moved.preservedPath, moved.originalPath);
        } catch (rollbackError) {
          rollbackFailed = true;
          log.error({ err: rollbackError, preservedPath: moved.preservedPath }, "restore rollback failed");
        }
      }
      if (quarantineDir && !rollbackFailed) await rm(quarantineDir, { recursive: true, force: true });
      if (rollbackFailed) {
        throw new AggregateError([error], `Restore failed; preserved data remains at ${quarantineDir ?? "the pre-restore area"}.`);
      }
      throw error;
    }

    log.info({ archivePath, databaseSha256: manifest.databaseSha256, quarantineDir }, "backup restored");
    return {
      status: "restored",
      databaseSha256: manifest.databaseSha256,
      previousDataDirectory: quarantineDir,
    };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

async function inspectArchive(archivePath: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  await listTar({
    file: archivePath,
    strict: true,
    onReadEntry: (entry) => {
      entries.push({ path: entry.path, type: entry.type, size: entry.size });
    },
  });
  return entries;
}

function validateArchiveEntries(entries: readonly ArchiveEntry[]): void {
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error("Backup archive contains too many files.");
  const seen = new Set<string>();
  let manifestFound = false;
  let databaseFound = false;
  let promptCount = 0;

  for (const entry of entries) {
    if (!isAllowedArchivePath(entry.path)) throw new Error(`Backup archive contains an unsafe path: ${entry.path}`);
    const path = normalizedEntryPath(entry.path);
    if (seen.has(path)) throw new Error(`Backup archive contains a duplicate path: ${path}`);
    seen.add(path);

    if (path === "prompts") {
      if (entry.type !== "Directory") throw new Error("Backup prompt entry is not a directory.");
      continue;
    }
    if (entry.type !== "File" && entry.type !== "OldFile") {
      throw new Error(`Backup archive contains an unsupported entry type: ${entry.type}`);
    }
    if (path === "manifest.json") {
      manifestFound = true;
      if (entry.size > MAX_MANIFEST_BYTES) throw new Error("Backup manifest is too large.");
      continue;
    }
    if (path === "database.sqlite") {
      databaseFound = true;
      if (entry.size < 1 || entry.size > MAX_DATABASE_BYTES) throw new Error("Backup database size is invalid.");
      continue;
    }
    if (path.startsWith("prompts/")) {
      promptCount += 1;
      if (promptCount > MAX_PROMPT_FILES || entry.size > MAX_PROMPT_OVERRIDE_BYTES) {
        throw new Error("Backup prompt overrides exceed the allowed size or count.");
      }
      continue;
    }
    throw new Error(`Backup archive contains an unexpected file: ${path}`);
  }

  if (!manifestFound || !databaseFound) throw new Error("Backup archive is missing its manifest or database.");
}

function isAllowedArchivePath(entryPath: string): boolean {
  if (entryPath.includes("\\") || entryPath.startsWith("/") || entryPath.includes("\0")) return false;
  const path = normalizedEntryPath(entryPath);
  const parts = path.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return false;
  return path === "manifest.json"
    || path === "database.sqlite"
    || path === "prompts"
    || /^prompts\/[A-Za-z0-9_-]+\.md$/.test(path);
}

function normalizedEntryPath(entryPath: string): string {
  return entryPath.replace(/\/+$/, "");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Backup manifest is not valid JSON.");
  }
}

function migrateAndValidateDatabase(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    assertDatabaseIntegrity(database);
    database.pragma("foreign_keys = ON");
    runDatabaseMigrations(database);
    database.pragma("wal_checkpoint(TRUNCATE)");
    database.pragma("journal_mode = DELETE");
    assertDatabaseIntegrity(database);
  } catch (error) {
    throw new Error(`Backup database is not compatible with this version: ${errorMessage(error)}`);
  } finally {
    database.close();
  }
}

function assertDatabaseIntegrity(database: Database.Database): void {
  const rows = database.pragma("integrity_check") as Array<Record<string, unknown>>;
  if (rows.length !== 1 || rows[0]?.["integrity_check"] !== "ok") {
    throw new Error("SQLite integrity_check failed.");
  }
}

async function existingRestoreTargets(databasePath: string, promptsPath: string, markerPath: string): Promise<string[]> {
  const candidates = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, promptsPath, markerPath];
  const existing: string[] = [];
  for (const path of candidates) {
    try {
      await lstat(path);
      existing.push(path);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }
  return existing;
}

async function readRestoreMarker(markerPath: string): Promise<RestoreMarker | null> {
  try {
    const info = await lstat(markerPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Restore marker is not a regular file.");
    const value = parseJson(await readFile(markerPath, "utf8"));
    if (!isRestoreMarker(value)) return null;
    return value;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function markerMatches(
  marker: RestoreMarker | null,
  archivePath: string,
  archiveStat: Awaited<ReturnType<typeof stat>>,
  adminAuthSecret: string | undefined
): marker is RestoreMarker {
  if (!marker || !adminAuthSecret || adminAuthSecret.length < 32) return false;
  const expected = Buffer.from(fingerprintAdminAuthSecret(adminAuthSecret), "hex");
  const actual = Buffer.from(marker.adminAuthSecretFingerprint, "hex");
  return marker.archivePath === archivePath
    && marker.archiveSize === archiveStat.size
    && marker.archiveMtimeMs === archiveStat.mtimeMs
    && timingSafeEqual(expected, actual);
}

function isRestoreMarker(value: unknown): value is RestoreMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record["format"] === "virtual-engineer-restore-marker"
    && record["version"] === 1
    && typeof record["archivePath"] === "string"
    && typeof record["archiveSize"] === "number"
    && typeof record["archiveMtimeMs"] === "number"
    && typeof record["databaseSha256"] === "string"
    && /^[a-f\d]{64}$/.test(record["databaseSha256"])
    && typeof record["adminAuthSecretFingerprint"] === "string"
    && /^[a-f\d]{64}$/.test(record["adminAuthSecretFingerprint"]);
}

async function writeRestoreMarker(markerPath: string, marker: RestoreMarker): Promise<void> {
  const temporaryPath = `${markerPath}.${randomUUID()}.partial`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(marker)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, markerPath);
    await chmod(markerPath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}