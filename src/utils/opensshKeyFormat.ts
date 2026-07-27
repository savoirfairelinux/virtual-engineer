/**
 * opensshKeyFormat — encodes raw ed25519 key material into the native
 * "OpenSSH private key" PEM format (`-----BEGIN OPENSSH PRIVATE KEY-----`).
 *
 * Node's `crypto.generateKeyPairSync("ed25519")` can only export private
 * keys as PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`). OpenSSH's `ssh`/`scp`
 * clients do NOT support that format for ed25519 keys — only RSA/EC keys
 * can be loaded from PKCS#8/PKCS#1 PEM. Attempting to use a PKCS#8 ed25519
 * key with `ssh -i` fails with "Load key ...: invalid format".
 *
 * OpenSSH has always required its own key container format for ed25519
 * (there is no legacy OpenSSL PEM representation for this key type), so we
 * build that format by hand from the raw 32-byte seed + public key.
 *
 * Format reference: https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.key
 */

import { randomBytes } from "node:crypto";

function sshString(buf: Buffer): Buffer {
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

function sshStringFromStr(s: string): Buffer {
  return sshString(Buffer.from(s, "utf8"));
}

/**
 * Build an unencrypted "OpenSSH private key" PEM for a single ed25519 key.
 *
 * @param rawPublicKey   32-byte raw ed25519 public key.
 * @param rawPrivateSeed 32-byte raw ed25519 private key seed.
 * @param comment        Comment stored alongside the key (cosmetic only).
 */
export function buildOpenSshEd25519PrivateKey(
  rawPublicKey: Buffer,
  rawPrivateSeed: Buffer,
  comment: string
): string {
  const MAGIC = Buffer.from("openssh-key-v1\0", "binary");
  const cipherName = sshStringFromStr("none");
  const kdfName = sshStringFromStr("none");
  const kdfOptions = sshString(Buffer.alloc(0));
  const numKeys = Buffer.allocUnsafe(4);
  numKeys.writeUInt32BE(1, 0);

  const publicKeyBlob = Buffer.concat([sshStringFromStr("ssh-ed25519"), sshString(rawPublicKey)]);
  const publicKeySection = sshString(publicKeyBlob);

  // OpenSSH's on-disk ed25519 private key blob is seed(32) + pubkey(32).
  const ed25519PrivBlob = Buffer.concat([rawPrivateSeed, rawPublicKey]);

  // Two identical random uint32 "checkints" let ssh verify the (absent)
  // cipher decrypted correctly; required even when cipher is "none".
  const checkInt = randomBytes(4);
  const privSection = Buffer.concat([
    sshStringFromStr("ssh-ed25519"),
    sshString(rawPublicKey),
    sshString(ed25519PrivBlob),
    sshStringFromStr(comment),
  ]);

  let privBlock = Buffer.concat([checkInt, checkInt, privSection]);
  // Pad to the "none" cipher's block size (8) with bytes 1,2,3,...
  const blockSize = 8;
  const padLen = (blockSize - (privBlock.length % blockSize)) % blockSize;
  const padding = Buffer.from(Array.from({ length: padLen }, (_, i) => i + 1));
  privBlock = Buffer.concat([privBlock, padding]);

  const privateKeySection = sshString(privBlock);

  const full = Buffer.concat([MAGIC, cipherName, kdfName, kdfOptions, numKeys, publicKeySection, privateKeySection]);
  const b64 = full.toString("base64");
  const wrapped = b64.match(/.{1,70}/g)?.join("\n") ?? b64;
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`;
}
