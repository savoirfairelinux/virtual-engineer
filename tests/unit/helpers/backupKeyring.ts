import { writeFile } from "node:fs/promises";

export const TEST_BACKUP_KEY_ID = "test-backup-key";
export const TEST_BACKUP_KEY_HEX = "a".repeat(64);

export async function writeTestBackupKeyring(path: string): Promise<void> {
  await writeFile(path, `${JSON.stringify({
    format: "virtual-engineer-backup-keyring",
    version: 1,
    activeKeyId: TEST_BACKUP_KEY_ID,
    keys: { [TEST_BACKUP_KEY_ID]: TEST_BACKUP_KEY_HEX },
  })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}