/**
 * sshKeyGen — generic ed25519 SSH key pair generation shared by any provider
 * descriptor that supports UI-generated SSH keys (`ProviderDescriptor.generateSshKeyPair`).
 *
 * Generates a key in the native OpenSSH private-key format (see
 * opensshKeyFormat.ts for why PKCS#8 doesn't work with `ssh -i` for ed25519),
 * encrypts the private key with AES-256-GCM, and returns both the encrypted
 * private key and the plaintext OpenSSH-format public key.
 *
 * Encryption is mandatory: unlike OAuth tokens (where `encryptToken` falls
 * back to reversible `plain:` storage when no admin secret is configured),
 * SSH private keys generated through the UI must always be encrypted at
 * rest, so this function throws when `adminAuthSecret` is missing rather
 * than silently storing the key in plaintext.
 */

import { generateKeyPairSync } from "node:crypto";
import { encryptToken } from "./encryption.js";
import { buildOpenSshEd25519PrivateKey } from "./opensshKeyFormat.js";

export interface GeneratedSshKeyPair {
  sshPrivateKeyEnc: string;
  sshPublicKey: string;
}

/**
 * Generate an ed25519 key pair for SSH authentication.
 *
 * @param adminAuthSecret  Required — used to AES-256-GCM encrypt the private
 *                         key before it is returned for storage. Throws if
 *                         unset, since generated keys must always be encrypted.
 * @param comment          Comment embedded in the private key and appended to
 *                         the public key line (defaults to "virtual-engineer").
 */
export function generateSshKeyPair(
  adminAuthSecret: string | undefined,
  comment = "virtual-engineer"
): GeneratedSshKeyPair {
  if (!adminAuthSecret) {
    throw new Error(
      "ADMIN_AUTH_SECRET must be configured to generate SSH keys — generated private keys are always stored encrypted, never in plaintext."
    );
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  // JWK export exposes the raw 32-byte seed ("d") and raw 32-byte public key
  // ("x") directly, base64url-encoded — simpler and more robust than parsing
  // DER structures by hand.
  const jwkPriv = privateKey.export({ format: "jwk" }) as { d: string };
  const jwkPub = publicKey.export({ format: "jwk" }) as { x: string };
  const rawSeed = Buffer.from(jwkPriv.d, "base64url");
  const rawPub = Buffer.from(jwkPub.x, "base64url");

  const opensshPrivatePem = buildOpenSshEd25519PrivateKey(rawPub, rawSeed, comment);
  const opensshPub = rawEd25519ToOpenSshPublic(rawPub, comment);

  return {
    sshPrivateKeyEnc: encryptToken(opensshPrivatePem, adminAuthSecret),
    sshPublicKey: opensshPub,
  };
}

/** Convert a raw 32-byte ed25519 public key to OpenSSH authorized_keys format. */
function rawEd25519ToOpenSshPublic(rawKey: Buffer, comment: string): string {
  const typeStr = "ssh-ed25519";
  const typeBytes = Buffer.from(typeStr, "utf8");
  const typeLenBuf = Buffer.allocUnsafe(4);
  typeLenBuf.writeUInt32BE(typeBytes.length, 0);
  const keyLenBuf = Buffer.allocUnsafe(4);
  keyLenBuf.writeUInt32BE(rawKey.length, 0);
  const wire = Buffer.concat([typeLenBuf, typeBytes, keyLenBuf, rawKey]);
  return `${typeStr} ${wire.toString("base64")} ${comment}`;
}
