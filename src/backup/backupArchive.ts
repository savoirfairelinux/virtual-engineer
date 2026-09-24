import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";

export const BACKUP_ARCHIVE_FORMAT = "virtual-engineer-backup";
export const BACKUP_FILENAME_PATTERN = /^ve-backup-(\d{8}T\d{9}Z)-([a-f\d]{8})\.tar\.gz$/;
export const MAX_BACKUP_PROMPT_FILES = 256;
export const MAX_BACKUP_PROMPT_OVERRIDE_BYTES = 2 * 1024 * 1024;
export const MAX_BACKUP_ARCHIVE_ENTRIES = MAX_BACKUP_PROMPT_FILES + 3;

export interface BackupPromptOverride {
  filename: string;
  sha256: string;
}

export interface BackupManifest {
  format: typeof BACKUP_ARCHIVE_FORMAT;
  formatVersion: 2;
  createdAt: string;
  databaseSha256: string;
  promptOverrides: BackupPromptOverride[];
  authenticationTag: string;
}

export interface BackupInfo {
  filename: string;
  createdAt: string;
  sizeBytes: number;
}

export function createBackupManifest(
  createdAt: string,
  databaseSha256: string,
  promptOverrides: readonly BackupPromptOverride[],
  adminAuthSecret: string
): BackupManifest {
  const authenticatedFields: Omit<BackupManifest, "authenticationTag"> = {
    format: BACKUP_ARCHIVE_FORMAT,
    formatVersion: 2,
    createdAt,
    databaseSha256,
    promptOverrides: normalizePromptOverrides(promptOverrides),
  };
  return {
    ...authenticatedFields,
    authenticationTag: authenticateManifestFields(authenticatedFields, adminAuthSecret),
  };
}

export function verifyBackupManifest(value: unknown, adminAuthSecret: string | undefined): BackupManifest {
  if (!adminAuthSecret || adminAuthSecret.length < 32) {
    throw new Error("ADMIN_AUTH_SECRET must be configured to restore this backup.");
  }
  if (!isRecord(value)
    || value["format"] !== BACKUP_ARCHIVE_FORMAT
    || value["formatVersion"] !== 2
    || typeof value["createdAt"] !== "string"
    || typeof value["databaseSha256"] !== "string"
    || !/^[a-f\d]{64}$/.test(value["databaseSha256"])
    || !isBackupPromptOverrideList(value["promptOverrides"])
    || typeof value["authenticationTag"] !== "string"
    || !/^[a-f\d]{64}$/.test(value["authenticationTag"])) {
    throw new Error("Backup manifest is invalid or unsupported.");
  }

  const createdAt = new Date(value["createdAt"]);
  if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== value["createdAt"]) {
    throw new Error("Backup manifest contains an invalid creation timestamp.");
  }

  const authenticatedFields: Omit<BackupManifest, "authenticationTag"> = {
    format: BACKUP_ARCHIVE_FORMAT,
    formatVersion: 2,
    createdAt: value["createdAt"],
    databaseSha256: value["databaseSha256"],
    promptOverrides: normalizePromptOverrides(value["promptOverrides"]),
  };
  const expectedTag = Buffer.from(authenticateManifestFields(authenticatedFields, adminAuthSecret), "hex");
  const actualTag = Buffer.from(value["authenticationTag"], "hex");
  if (!timingSafeEqual(expectedTag, actualTag)) {
    throw new Error("Backup manifest authentication failed; check ADMIN_AUTH_SECRET and archive integrity.");
  }

  return {
    ...authenticatedFields,
    authenticationTag: value["authenticationTag"],
  };
}

function isBackupPromptOverrideList(value: unknown): value is BackupPromptOverride[] {
  if (!Array.isArray(value) || value.length > MAX_BACKUP_PROMPT_FILES) return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    if (typeof record["filename"] !== "string"
      || !/^[A-Za-z0-9_-]+\.md$/.test(record["filename"])
      || seen.has(record["filename"])
      || typeof record["sha256"] !== "string"
      || !/^[a-f\d]{64}$/.test(record["sha256"])) {
      return false;
    }
    seen.add(record["filename"]);
  }
  return true;
}

function normalizePromptOverrides(promptOverrides: readonly BackupPromptOverride[]): BackupPromptOverride[] {
  return promptOverrides
    .map(({ filename, sha256 }) => ({ filename, sha256 }))
    .sort((left, right) => left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0);
}

function authenticateManifestFields(
  fields: Pick<BackupManifest, "format" | "formatVersion" | "createdAt" | "databaseSha256" | "promptOverrides">,
  adminAuthSecret: string
): string {
  const canonicalFields = {
    format: fields.format,
    formatVersion: fields.formatVersion,
    createdAt: fields.createdAt,
    databaseSha256: fields.databaseSha256,
    promptOverrides: normalizePromptOverrides(fields.promptOverrides),
  };
  return createHmac("sha256", adminAuthSecret)
    .update("virtual-engineer-backup-manifest-v2\0", "utf8")
    .update(JSON.stringify(canonicalFields), "utf8")
    .digest("hex");
}

export function isBackupFilename(value: string): boolean {
  return BACKUP_FILENAME_PATTERN.test(value);
}

export function parseBackupCreatedAt(filename: string): string | null {
  const match = BACKUP_FILENAME_PATTERN.exec(filename);
  const timestamp = match?.[1];
  if (!timestamp) return null;

  const parts = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(timestamp);
  if (!parts) return null;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6]);
  const millisecond = Number(parts[7]);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  if (date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
    || date.getUTCMilliseconds() !== millisecond) {
    return null;
  }
  return date.toISOString();
}

export function fingerprintAdminAuthSecret(adminAuthSecret: string): string {
  return createHmac("sha256", adminAuthSecret)
    .update("virtual-engineer-backup-auth-check-v1", "utf8")
    .digest("hex");
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    if (!Buffer.isBuffer(chunk)) throw new TypeError("Backup file stream yielded non-binary data");
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}