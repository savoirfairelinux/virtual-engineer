import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKUP_DOWNLOAD_TOKEN_TTL_MS,
  clearBackupDownloadTokensForTests,
  consumeBackupDownloadToken,
  mintBackupDownloadToken,
} from "../../src/admin/backupDownloadTokenStore.js";

const FILENAME = "ve-backup-20260924T030000000Z-a1b2c3d4.tar.gz";

describe("backupDownloadTokenStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearBackupDownloadTokensForTests();
    vi.useRealTimers();
  });

  it("mints an opaque, expiring token bound to one archive and consumes it once", () => {
    const { token, expiresAt } = mintBackupDownloadToken(FILENAME);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt).toBe(Date.now() + BACKUP_DOWNLOAD_TOKEN_TTL_MS);
    expect(consumeBackupDownloadToken(token, FILENAME)).toBe(true);
    expect(consumeBackupDownloadToken(token, FILENAME)).toBe(false);
  });

  it("rejects and consumes a token presented for a different archive", () => {
    const { token } = mintBackupDownloadToken(FILENAME);

    expect(consumeBackupDownloadToken(token, "ve-backup-20260924T030000000Z-c3d4e5f6.tar.gz")).toBe(false);
    expect(consumeBackupDownloadToken(token, FILENAME)).toBe(false);
  });

  it("rejects expired, malformed, and unknown tokens", () => {
    const { token } = mintBackupDownloadToken(FILENAME);
    vi.advanceTimersByTime(BACKUP_DOWNLOAD_TOKEN_TTL_MS + 1);

    expect(consumeBackupDownloadToken(token, FILENAME)).toBe(false);
    expect(consumeBackupDownloadToken("not-a-token", FILENAME)).toBe(false);
    expect(consumeBackupDownloadToken("a".repeat(64), FILENAME)).toBe(false);
  });

  it("prunes expired entries when minting a new token", () => {
    mintBackupDownloadToken(FILENAME);
    vi.advanceTimersByTime(BACKUP_DOWNLOAD_TOKEN_TTL_MS + 1);

    const { token } = mintBackupDownloadToken(FILENAME);
    expect(consumeBackupDownloadToken(token, FILENAME)).toBe(true);
  });
});