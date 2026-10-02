import { createCipheriv, createDecipheriv, randomBytes, type DecipherGCM } from "node:crypto";
import { constants } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

const BACKUP_ENCRYPTION_MAGIC = Buffer.from("VEBACKUP", "ascii");
const BACKUP_ENCRYPTION_VERSION = 1;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_KEY_ID_BYTES = 64;
const MAX_KEYRING_BYTES = 64 * 1024;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface BackupKeyring {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

export interface BackupKeyringFileContent {
  format: "virtual-engineer-backup-keyring";
  version: 1;
  activeKeyId: string;
  keys: Record<string, string>;
}

export interface BackupEncryptionHeader {
  version: number;
  keyId: string;
  headerBytes: Buffer;
  payloadOffset: number;
  nonce: Buffer;
}

export async function loadBackupKeyring(keyringFile: string | undefined): Promise<BackupKeyring> {
  if (!keyringFile) {
    throw new Error("BACKUP_KEYRING_FILE must be configured to create or restore encrypted backups.");
  }

  const handle = await open(keyringFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let content: string;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_KEYRING_BYTES) {
      throw new Error("BACKUP_KEYRING_FILE must be a regular file no larger than 64 KiB.");
    }
    const permissions = info.mode & 0o777;
    if ((permissions & 0o022) !== 0 || (permissions & 0o004) !== 0 || (permissions & 0o444) === 0) {
      throw new Error("BACKUP_KEYRING_FILE permissions must be private (for example 0600 or Kubernetes 0440).");
    }
    content = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }

  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw new Error("BACKUP_KEYRING_FILE must contain valid JSON.");
  }
  if (!isRecord(value)
    || value["format"] !== "virtual-engineer-backup-keyring"
    || value["version"] !== 1
    || typeof value["activeKeyId"] !== "string"
    || !KEY_ID_PATTERN.test(value["activeKeyId"])
    || !isRecord(value["keys"])) {
    throw new Error("BACKUP_KEYRING_FILE has an invalid or unsupported schema.");
  }

  const entries = Object.entries(value["keys"]);
  if (entries.length === 0 || entries.length > 64) {
    throw new Error("BACKUP_KEYRING_FILE must contain between 1 and 64 keys.");
  }
  const keys = new Map<string, Buffer>();
  for (const [keyId, encodedKey] of entries) {
    if (!KEY_ID_PATTERN.test(keyId) || typeof encodedKey !== "string" || !/^[a-fA-F\d]{64}$/.test(encodedKey)) {
      throw new Error("BACKUP_KEYRING_FILE keys must use safe ids and 64-character hexadecimal values.");
    }
    keys.set(keyId, Buffer.from(encodedKey, "hex"));
  }
  if (!keys.has(value["activeKeyId"])) {
    throw new Error("BACKUP_KEYRING_FILE activeKeyId must identify a key in keys.");
  }

  return { activeKeyId: value["activeKeyId"], keys };
}

export async function encryptBackupFile(
  sourcePath: string,
  encryptedPath: string,
  keyring: BackupKeyring,
): Promise<void> {
  const key = keyring.keys.get(keyring.activeKeyId);
  if (!key) throw new Error("The active backup encryption key is unavailable.");

  const keyId = Buffer.from(keyring.activeKeyId, "utf8");
  if (!KEY_ID_PATTERN.test(keyring.activeKeyId) || keyId.length > MAX_KEY_ID_BYTES) {
    throw new Error("The active backup encryption key id is invalid.");
  }
  const nonce = randomBytes(NONCE_BYTES);
  const headerBytes = Buffer.alloc(BACKUP_ENCRYPTION_MAGIC.length + 2 + keyId.length + NONCE_BYTES);
  let offset = 0;
  BACKUP_ENCRYPTION_MAGIC.copy(headerBytes, offset);
  offset += BACKUP_ENCRYPTION_MAGIC.length;
  headerBytes.writeUInt8(BACKUP_ENCRYPTION_VERSION, offset);
  offset += 1;
  headerBytes.writeUInt8(keyId.length, offset);
  offset += 1;
  keyId.copy(headerBytes, offset);
  offset += keyId.length;
  nonce.copy(headerBytes, offset);

  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(headerBytes);
  const appendAuthenticationTag = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
      callback(null, chunk);
    },
    flush(callback: TransformCallback): void {
      try {
        this.push(cipher.getAuthTag());
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });

  const output = createWriteStream(encryptedPath, { flags: "wx", mode: 0o600 });
  let outputCreated = false;
  output.once("open", () => { outputCreated = true; });
  output.write(headerBytes);
  try {
    await pipeline(createReadStream(sourcePath), cipher, appendAuthenticationTag, output);
  } catch (error) {
    output.destroy();
    if (outputCreated) await rm(encryptedPath, { force: true });
    throw error;
  }
}

export async function decryptBackupFile(
  encryptedPath: string,
  plaintextPath: string,
  keyring: BackupKeyring,
): Promise<void> {
  const header = await readBackupEncryptionHeader(encryptedPath);
  const key = keyring.keys.get(header.keyId);
  if (!key) {
    throw new Error(`Backup encryption key '${header.keyId}' is not available in BACKUP_KEYRING_FILE.`);
  }

  const decipher = createDecipheriv("aes-256-gcm", key, header.nonce);
  decipher.setAAD(header.headerBytes);
  const stripAuthenticationTag = createAuthenticationTagStripper(decipher);
  const output = createWriteStream(plaintextPath, { flags: "wx", mode: 0o600 });
  let outputCreated = false;
  output.once("open", () => { outputCreated = true; });

  try {
    await pipeline(
      createReadStream(encryptedPath, { start: header.payloadOffset }),
      stripAuthenticationTag,
      decipher,
      output,
    );
  } catch (error) {
    output.destroy();
    if (outputCreated) await rm(plaintextPath, { force: true });
    if (isAuthenticationError(error)) {
      throw new Error("Backup archive authentication failed; check its encryption key and integrity.", { cause: error });
    }
    throw error;
  }
}

export async function readBackupEncryptionHeader(encryptedPath: string): Promise<BackupEncryptionHeader> {
  const handle = await open(encryptedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    const minimumSize = BACKUP_ENCRYPTION_MAGIC.length + 2 + 1 + NONCE_BYTES + AUTH_TAG_BYTES;
    if (!info.isFile() || info.size < minimumSize) {
      throw new Error("Encrypted backup archive header is invalid or truncated.");
    }

    const fixedHeader = await readExactly(handle, BACKUP_ENCRYPTION_MAGIC.length + 2, 0);
    if (!fixedHeader.subarray(0, BACKUP_ENCRYPTION_MAGIC.length).equals(BACKUP_ENCRYPTION_MAGIC)) {
      throw new Error("Encrypted backup archive header is invalid.");
    }
    const version = fixedHeader.readUInt8(BACKUP_ENCRYPTION_MAGIC.length);
    if (version !== BACKUP_ENCRYPTION_VERSION) {
      throw new Error(`Encrypted backup archive version ${version} is not supported.`);
    }
    const keyIdLength = fixedHeader.readUInt8(BACKUP_ENCRYPTION_MAGIC.length + 1);
    if (keyIdLength < 1 || keyIdLength > MAX_KEY_ID_BYTES) {
      throw new Error("Encrypted backup archive key id is invalid.");
    }

    const payloadOffset = fixedHeader.length + keyIdLength + NONCE_BYTES;
    if (info.size < payloadOffset + AUTH_TAG_BYTES) {
      throw new Error("Encrypted backup archive header is invalid or truncated.");
    }
    const headerBytes = await readExactly(handle, payloadOffset, 0);
    const keyIdStart = fixedHeader.length;
    const keyIdEnd = keyIdStart + keyIdLength;
    const keyId = headerBytes.subarray(keyIdStart, keyIdEnd).toString("utf8");
    if (!KEY_ID_PATTERN.test(keyId) || !Buffer.from(keyId, "utf8").equals(headerBytes.subarray(keyIdStart, keyIdEnd))) {
      throw new Error("Encrypted backup archive key id is invalid.");
    }
    return {
      version,
      keyId,
      headerBytes,
      payloadOffset,
      nonce: headerBytes.subarray(keyIdEnd),
    };
  } finally {
    await handle.close();
  }
}

export async function hasBackupEncryptionMagic(filePath: string): Promise<boolean> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < BACKUP_ENCRYPTION_MAGIC.length) return false;
    const prefix = await readExactly(handle, BACKUP_ENCRYPTION_MAGIC.length, 0);
    return prefix.equals(BACKUP_ENCRYPTION_MAGIC);
  } finally {
    await handle.close();
  }
}

export async function hasBackupGzipMagic(filePath: string): Promise<boolean> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 2) return false;
    const prefix = await readExactly(handle, 2, 0);
    return prefix[0] === 0x1f && prefix[1] === 0x8b;
  } finally {
    await handle.close();
  }
}

function createAuthenticationTagStripper(decipher: DecipherGCM): Transform {
  let trailingBytes = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
      const combined = Buffer.concat([trailingBytes, chunk]);
      const emitLength = Math.max(0, combined.length - AUTH_TAG_BYTES);
      if (emitLength > 0) this.push(combined.subarray(0, emitLength));
      trailingBytes = Buffer.from(combined.subarray(emitLength));
      callback();
    },
    flush(callback: TransformCallback): void {
      if (trailingBytes.length !== AUTH_TAG_BYTES) {
        callback(new Error("Encrypted backup archive is truncated before its authentication tag."));
        return;
      }
      try {
        decipher.setAuthTag(trailingBytes);
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error("Encrypted backup archive header is truncated.");
    offset += bytesRead;
  }
  return buffer;
}

function isAuthenticationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? error.code : undefined;
  return code === "ERR_OSSL_EVP_BAD_DECRYPT"
    || error.message.toLowerCase().includes("authenticate");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}