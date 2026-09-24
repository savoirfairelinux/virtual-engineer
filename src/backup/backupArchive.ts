import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";

export const BACKUP_ARCHIVE_FORMAT = "virtual-engineer-backup";
export const BACKUP_FILENAME_PATTERN = /^ve-backup-(\d{8}T\d{9}Z)-([a-f\d]{8})\.tar\.gz$/;

export interface BackupManifest {
  format: typeof BACKUP_ARCHIVE_FORMAT;
  formatVersion: 1;
  createdAt: string;
  databaseSha256: string;
  adminAuthSecretFingerprint: string;
}

export interface BackupInfo {
  filename: string;
  createdAt: string;
  sizeBytes: number;
}

export function createBackupManifest(
  createdAt: string,
  databaseSha256: string,
  adminAuthSecret: string
): BackupManifest {
  return {
    format: BACKUP_ARCHIVE_FORMAT,
    formatVersion: 1,
    createdAt,
    databaseSha256,
    adminAuthSecretFingerprint: fingerprintAdminAuthSecret(adminAuthSecret),
  };
}

export function verifyBackupManifest(value: unknown, adminAuthSecret: string | undefined): BackupManifest {
  if (!adminAuthSecret || adminAuthSecret.length < 32) {
    throw new Error("ADMIN_AUTH_SECRET must be configured to restore this backup.");
  }
  if (!isRecord(value)
    || value["format"] !== BACKUP_ARCHIVE_FORMAT
    || value["formatVersion"] !== 1
    || typeof value["createdAt"] !== "string"
    || typeof value["databaseSha256"] !== "string"
    || !/^[a-f\d]{64}$/.test(value["databaseSha256"])
    || typeof value["adminAuthSecretFingerprint"] !== "string"
    || !/^[a-f\d]{64}$/.test(value["adminAuthSecretFingerprint"])) {
    throw new Error("Backup manifest is invalid or unsupported.");
  }

  const createdAt = new Date(value["createdAt"]);
  if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== value["createdAt"]) {
    throw new Error("Backup manifest contains an invalid creation timestamp.");
  }

  const expectedFingerprint = Buffer.from(fingerprintAdminAuthSecret(adminAuthSecret), "hex");
  const actualFingerprint = Buffer.from(value["adminAuthSecretFingerprint"], "hex");
  if (!timingSafeEqual(expectedFingerprint, actualFingerprint)) {
    throw new Error("Backup requires the original ADMIN_AUTH_SECRET.");
  }

  return {
    format: BACKUP_ARCHIVE_FORMAT,
    formatVersion: 1,
    createdAt: value["createdAt"],
    databaseSha256: value["databaseSha256"],
    adminAuthSecretFingerprint: value["adminAuthSecretFingerprint"],
  };
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