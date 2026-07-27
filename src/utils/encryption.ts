/**
 * AES-256-GCM token encryption/decryption.
 *
 * Derives a 256-bit key from `ADMIN_AUTH_SECRET` via HMAC-SHA256 and uses it
 * to encrypt/decrypt OAuth session tokens stored in `agents.modelConfigJson`.
 *
 * New credential writes require `ADMIN_AUTH_SECRET`. Legacy `plain:` values
 * remain readable so startup migration can encrypt them after a secret is set.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM standard
const AUTH_TAG_LENGTH = 16;
const KEY_DERIVATION_LABEL = "ve-copilot-token-encryption";
const PLAIN_PREFIX = "plain:";
const ENCRYPTED_PREFIX = "veenc:v1:";

/** Derive a 256-bit AES key from `secret` using HMAC-SHA256 keyed on a fixed label. */
function deriveKey(secret: string): Buffer {
  return createHmac("sha256", KEY_DERIVATION_LABEL).update(secret).digest();
}

/**
 * Encrypt a token string with AES-256-GCM.
 * Returns `veenc:v1:<base64>`, where the payload contains
 * `iv + authTag + ciphertext`.
 *
 * Throws when `adminAuthSecret` is not configured; plaintext credential writes
 * are never permitted.
 */
export function encryptToken(token: string, adminAuthSecret: string | undefined): string {
  if (!adminAuthSecret) {
    throw new Error("ADMIN_AUTH_SECRET is required to encrypt credentials.");
  }
  const key = deriveKey(adminAuthSecret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // iv (12) + authTag (16) + ciphertext
  return `${ENCRYPTED_PREFIX}${Buffer.concat([iv, authTag, encrypted]).toString("base64")}`;
}

/** Return whether a stored credential uses the deprecated plaintext encoding. */
export function isLegacyPlainToken(value: string): boolean {
  return value.startsWith(PLAIN_PREFIX);
}

/** Return whether a value has the current managed-encryption envelope. */
export function isVersionedEncryptedToken(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Identify an unprefixed value shaped like the legacy AES-GCM payload.
 * Canonical base64 and the minimum IV/tag length avoid classifying ordinary
 * provider tokens as legacy ciphertext.
 */
export function isProbableLegacyEncryptedToken(value: string): boolean {
  if (value.length === 0 || value.startsWith("veenc:") || isLegacyPlainToken(value)) {
    return false;
  }
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length >= IV_LENGTH + AUTH_TAG_LENGTH
      && decoded.toString("base64") === value;
  } catch {
    return false;
  }
}

/**
 * Decrypt a base64-encoded token previously encrypted with `encryptToken`.
 *
 * Handles `plain:`-prefixed tokens (created when no secret was configured)
 * transparently — no secret required for those.
 */
export function decryptToken(encrypted: string, adminAuthSecret: string | undefined): string {
  if (encrypted.startsWith(PLAIN_PREFIX)) {
    return Buffer.from(encrypted.slice(PLAIN_PREFIX.length), "base64").toString("utf8");
  }
  if (encrypted.startsWith("veenc:") && !isVersionedEncryptedToken(encrypted)) {
    throw new Error("Unsupported encrypted credential version.");
  }
  if (!adminAuthSecret) {
    throw new Error("ADMIN_AUTH_SECRET is required to decrypt the session token.");
  }
  const key = deriveKey(adminAuthSecret);
  const payload = isVersionedEncryptedToken(encrypted)
    ? encrypted.slice(ENCRYPTED_PREFIX.length)
    : encrypted;
  const data = Buffer.from(payload, "base64");

  if (data.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Invalid encrypted token: too short");
  }

  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  return decipher.update(ciphertext) + decipher.final("utf8");
}

/**
 * Returns true if `value` was produced by `encryptToken` — either a `plain:`-prefixed
 * token (no secret configured) or a valid AES-256-GCM ciphertext for the current secret.
 *
 * Use this guard to prevent double-encrypting a credential that is already stored
 * encrypted (e.g. when a `PUT` round-trips an unchanged password field).
 */
export function isEncryptedToken(value: string, adminAuthSecret: string | undefined): boolean {
  if (isLegacyPlainToken(value) || isVersionedEncryptedToken(value)) return true;
  if (!adminAuthSecret) return false;
  try {
    decryptToken(value, adminAuthSecret);
    return true;
  } catch {
    return false;
  }
}
