import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  decryptBackupFile,
  encryptBackupFile,
  loadBackupKeyring,
  readBackupEncryptionHeader,
} from "../../src/backup/backupCrypto.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("backup archive encryption", () => {
  it("round-trips a stream and encrypts with the active key", async () => {
    const directory = await makeDirectory();
    const keyringPath = await writeKeyring(directory, {
      activeKeyId: "key-2026-09",
      keys: {
        "key-2026-09": "11".repeat(32),
      },
    });
    const sourcePath = join(directory, "source.tar.gz");
    const encryptedPath = join(directory, "archive.tar.gz.enc");
    const decryptedPath = join(directory, "decrypted.tar.gz");
    const contents = Buffer.alloc(512 * 1024, 0x5a);
    await writeFile(sourcePath, contents, { mode: 0o600 });
    const keyring = await loadBackupKeyring(keyringPath);

    await encryptBackupFile(sourcePath, encryptedPath, keyring);
    await expect(readBackupEncryptionHeader(encryptedPath)).resolves.toMatchObject({
      version: 1,
      keyId: "key-2026-09",
    });
    await decryptBackupFile(encryptedPath, decryptedPath, keyring);

    await expect(readFile(decryptedPath)).resolves.toEqual(contents);
    await expect(readFile(encryptedPath)).resolves.not.toEqual(contents);
  });

  it("retains old keys for decryption after rotation", async () => {
    const directory = await makeDirectory();
    const oldKeyringPath = await writeKeyring(directory, {
      activeKeyId: "old-key",
      keys: { "old-key": "22".repeat(32) },
    });
    const rotatedKeyringPath = await writeKeyring(directory, {
      activeKeyId: "new-key",
      keys: {
        "old-key": "22".repeat(32),
        "new-key": "33".repeat(32),
      },
    });
    const sourcePath = join(directory, "source.tar.gz");
    const encryptedPath = join(directory, "archive.tar.gz.enc");
    const decryptedPath = join(directory, "decrypted.tar.gz");
    await writeFile(sourcePath, "backup payload", { mode: 0o600 });

    await encryptBackupFile(sourcePath, encryptedPath, await loadBackupKeyring(oldKeyringPath));
    await decryptBackupFile(encryptedPath, decryptedPath, await loadBackupKeyring(rotatedKeyringPath));

    await expect(readFile(decryptedPath, "utf8")).resolves.toBe("backup payload");
  });

  it("authenticates the key id in the envelope header", async () => {
    const directory = await makeDirectory();
    const originalKeyringPath = await writeKeyring(directory, {
      activeKeyId: "old-key",
      keys: { "old-key": "88".repeat(32) },
    });
    const rotatedKeyringPath = await writeKeyring(directory, {
      activeKeyId: "new-key",
      keys: {
        "old-key": "88".repeat(32),
        "new-key": "88".repeat(32),
      },
    });
    const sourcePath = join(directory, "source.tar.gz");
    const encryptedPath = join(directory, "archive.tar.gz.enc");
    const decryptedPath = join(directory, "decrypted.tar.gz");
    await writeFile(sourcePath, "header-bound payload", { mode: 0o600 });
    await encryptBackupFile(sourcePath, encryptedPath, await loadBackupKeyring(originalKeyringPath));

    const encrypted = await readFile(encryptedPath);
    Buffer.from("new-key", "ascii").copy(encrypted, Buffer.byteLength("VEBACKUP") + 2);
    await writeFile(encryptedPath, encrypted, { mode: 0o600 });

    await expect(decryptBackupFile(
      encryptedPath,
      decryptedPath,
      await loadBackupKeyring(rotatedKeyringPath),
    )).rejects.toThrow(/authentication/i);
    await expect(readFile(decryptedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects tampering without leaving unauthenticated plaintext", async () => {
    const directory = await makeDirectory();
    const keyringPath = await writeKeyring(directory, {
      activeKeyId: "active",
      keys: { active: "44".repeat(32) },
    });
    const sourcePath = join(directory, "source.tar.gz");
    const encryptedPath = join(directory, "archive.tar.gz.enc");
    const decryptedPath = join(directory, "decrypted.tar.gz");
    await writeFile(sourcePath, Buffer.alloc(128 * 1024, 0x61), { mode: 0o600 });
    await encryptBackupFile(sourcePath, encryptedPath, await loadBackupKeyring(keyringPath));

    const encrypted = await readFile(encryptedPath);
    encrypted[encrypted.length - 17] = (encrypted[encrypted.length - 17] ?? 0) ^ 1;
    await writeFile(encryptedPath, encrypted, { mode: 0o600 });

    await expect(decryptBackupFile(
      encryptedPath,
      decryptedPath,
      await loadBackupKeyring(keyringPath),
    )).rejects.toThrow(/authentication/i);
    await expect(readFile(decryptedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a mismatched encryption key without leaving plaintext", async () => {
    const directory = await makeDirectory();
    const correctKeyringPath = await writeKeyring(directory, {
      activeKeyId: "active",
      keys: { active: "66".repeat(32) },
    });
    const wrongKeyringPath = await writeKeyring(directory, {
      activeKeyId: "active",
      keys: { active: "77".repeat(32) },
    });
    const sourcePath = join(directory, "source.tar.gz");
    const encryptedPath = join(directory, "archive.tar.gz.enc");
    const decryptedPath = join(directory, "decrypted.tar.gz");
    await writeFile(sourcePath, "confidential backup", { mode: 0o600 });
    await encryptBackupFile(sourcePath, encryptedPath, await loadBackupKeyring(correctKeyringPath));

    await expect(decryptBackupFile(
      encryptedPath,
      decryptedPath,
      await loadBackupKeyring(wrongKeyringPath),
    )).rejects.toThrow(/authentication/i);
    await expect(readFile(decryptedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a keyring that is readable by other users", async () => {
    const directory = await makeDirectory();
    const keyringPath = await writeKeyring(directory, {
      activeKeyId: "active",
      keys: { active: "55".repeat(32) },
    });
    await chmod(keyringPath, 0o644);

    await expect(loadBackupKeyring(keyringPath)).rejects.toThrow("permissions");
  });
});

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `ve-backup-crypto-${randomUUID()}-`));
  directories.push(directory);
  return directory;
}

async function writeKeyring(
  directory: string,
  keyring: { activeKeyId: string; keys: Record<string, string> },
): Promise<string> {
  const keyringPath = join(directory, `keyring-${randomUUID()}.json`);
  await writeFile(keyringPath, `${JSON.stringify({ format: "virtual-engineer-backup-keyring", version: 1, ...keyring })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return keyringPath;
}