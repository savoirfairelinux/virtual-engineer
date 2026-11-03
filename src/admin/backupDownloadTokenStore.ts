import { createHash, randomBytes } from "node:crypto";

export const BACKUP_DOWNLOAD_TOKEN_TTL_MS = 60_000;

interface TokenEntry {
  filename: string;
  expiresAt: number;
}

const tokens = new Map<string, TokenEntry>();

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function pruneExpired(now: number): void {
  for (const [hash, entry] of tokens) {
    if (entry.expiresAt <= now) tokens.delete(hash);
  }
}

export function mintBackupDownloadToken(filename: string): { token: string; expiresAt: number } {
  const now = Date.now();
  pruneExpired(now);
  const token = randomBytes(32).toString("hex");
  const expiresAt = now + BACKUP_DOWNLOAD_TOKEN_TTL_MS;
  tokens.set(hashToken(token), { filename, expiresAt });
  return { token, expiresAt };
}

export function consumeBackupDownloadToken(rawToken: string, filename: string): boolean {
  if (!rawToken || !/^[0-9a-f]{64}$/.test(rawToken)) return false;
  const hash = hashToken(rawToken);
  const entry = tokens.get(hash);
  tokens.delete(hash);
  return entry !== undefined && entry.filename === filename && entry.expiresAt > Date.now();
}

export function clearBackupDownloadTokensForTests(): void {
  tokens.clear();
}