/**
 * AES-256-GCM token encryption/decryption.
 *
 * Derives a 256-bit key from `ADMIN_AUTH_SECRET` via HMAC-SHA256 and uses it
 * to encrypt/decrypt OAuth session tokens stored in `agents.modelConfigJson`.
 *
 * When `adminAuthSecret` is not set the token is stored with a `plain:` prefix
 * (base64-encoded plaintext). This allows the OAuth flow to work without a
 * secret, but is insecure — users should set ADMIN_AUTH_SECRET in production.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM standard
const AUTH_TAG_LENGTH = 16;
const KEY_DERIVATION_LABEL = "ve-copilot-token-encryption";
const PLAIN_PREFIX = "plain:";

/** Derive a 256-bit AES key from `secret` using HMAC-SHA256 keyed on a fixed label. */
function deriveKey(secret: string): Buffer {
  return createHmac("sha256", KEY_DERIVATION_LABEL).update(secret).digest();
}

/**
 * Encrypt a token string with AES-256-GCM.
 * Returns a base64 string containing `iv + authTag + ciphertext`.
 *
 * If `adminAuthSecret` is not set, returns a `plain:`-prefixed base64 string
 * (unencrypted). Callers should warn the user when this path is taken.
 */
export function encryptToken(token: string, adminAuthSecret: string | undefined): string {
  if (!adminAuthSecret) {
    return PLAIN_PREFIX + Buffer.from(token, "utf8").toString("base64");
  }
  const key = deriveKey(adminAuthSecret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // iv (12) + authTag (16) + ciphertext
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
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
  if (!adminAuthSecret) {
    throw new Error("ADMIN_AUTH_SECRET is required to decrypt the session token.");
  }
  const key = deriveKey(adminAuthSecret);
  const data = Buffer.from(encrypted, "base64");

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
