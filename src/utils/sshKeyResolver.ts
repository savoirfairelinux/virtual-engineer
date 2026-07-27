/**
 * sshKeyResolver — runtime SSH key material → temp-file resolution.
 *
 * Used by the Gerrit descriptor's `preprocessConfig` hook so that private
 * keys stored encrypted in the database and agent public keys used for
 * identity pinning are written to temp files exactly once and cleaned up
 * on process exit.
 *
 * Two SSH authentication modes:
 *   1. Generated key — `sshPrivateKeyEnc` is set; resolver decrypts + writes to temp file
 *   2. SSH agent     — `sshPrivateKeyEnc` is absent; SSH_AUTH_SOCK is forwarded
 *      2a. With identity pinning — `sshAgentPublicKey` stored in config; resolver writes .pub temp file
 *      2b. No pinning           — all agent keys tried
 */

import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decryptToken } from "./encryption.js";

/**
 * Config key written by `preprocessConfig` to carry the resolved private-key
 * temp-file path. All SSH-capable connectors read this key instead of
 * duplicating the resolution logic.
 */
export const SSH_RESOLVED_KEY_PATH = "_resolvedSshKeyPath" as const;

/**
 * Config key written by `preprocessConfig` to carry the SSH agent identity
 * public-key temp-file path (used for `-o IdentitiesOnly=yes` pinning).
 */
export const SSH_AGENT_PUBKEY_PATH = "_agentPubKeyPath" as const;

const generatedPaths = new Set<string>();
let tempDirectory: string | undefined;
let exitHandlerRegistered = false;

function stableId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function registerExitHandlerOnce(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  process.on("exit", () => {
    if (tempDirectory !== undefined) {
      try { rmSync(tempDirectory, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
}

function generatedDirectory(): string {
  if (tempDirectory === undefined) {
    tempDirectory = mkdtempSync(join(tmpdir(), "ve-ssh-"));
    chmodSync(tempDirectory, 0o700);
    registerExitHandlerOnce();
  }
  return tempDirectory;
}

function assertGeneratedFile(fd: number, path: string): void {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error(`Generated SSH path is not a regular file: ${path}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`Generated SSH path is not owned by this process user: ${path}`);
  }
}

function writeGeneratedFile(path: string, content: Buffer, mode: number): string {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, mode);
    assertGeneratedFile(fd, temporaryPath);
    writeFileSync(fd, content);
    fchmodSync(fd, mode);
    closeSync(fd);
    fd = undefined;
    renameSync(temporaryPath, path);
  } catch (err) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporaryPath, { force: true });
    throw err;
  }
  generatedPaths.add(path);
  return path;
}

/** Return whether a path names SSH material generated and registered by this process. */
export function isGeneratedSshFilePath(filePath: string): boolean {
  return generatedPaths.has(resolve(filePath));
}

/**
 * Write PEM private key material to a deterministic temp file and return its path.
 * Replaces the generated file atomically on every call.
 *
 * @param pem         Decrypted PEM private key string.
 * @param integrationId  Used to derive a stable temp path unique to this integration.
 */
export function resolveKeyFromPem(pem: string, integrationId: string): string {
  const path = join(generatedDirectory(), `key-${stableId(integrationId)}.pem`);
  return writeGeneratedFile(path, Buffer.from(pem, "utf8"), 0o600);
}

/**
 * Write an OpenSSH public key to a deterministic temp file and return its path.
 * Used for SSH agent identity pinning (`-o IdentitiesOnly=yes -i <pub-key-file>`).
 * Replaces the generated file atomically on every call.
 *
 * @param publicKey   OpenSSH-format public key string (from `ssh-add -L` or generated).
 * @param integrationId  Used to derive a stable temp path unique to this integration.
 */
export function resolveAgentPubKeyPath(publicKey: string, integrationId: string): string {
  const path = join(generatedDirectory(), `agent-${stableId(integrationId)}.pub`);
  return writeGeneratedFile(path, Buffer.from(publicKey.trim() + "\n", "utf8"), 0o644);
}

/**
 * Resolve the effective SSH key path from a parsed Gerrit config object.
 *
 * Priority:
 *   1. `_resolvedSshKeyPath` — already resolved by a prior `preprocessConfig` call
 *   2. `sshPrivateKeyEnc`    — decrypt and write to temp file
 *   3. `undefined`           — SSH agent mode (no file key)
 *
 * Throws if `sshPrivateKeyEnc` is set but cannot be decrypted (e.g. wrong or
 * missing `ADMIN_AUTH_SECRET`), rather than silently falling back to agent
 * mode — a misconfigured "generated key" integration should fail with a
 * clear config error, not attempt SSH-agent auth and fail confusingly later
 * with an unrelated "permission denied".
 *
 * @param cfg            Parsed config object (may contain encrypted key material).
 * @param adminAuthSecret  Used to decrypt `sshPrivateKeyEnc` when present.
 * @param integrationId   Used to derive a stable temp-file path.
 */
export function resolveEffectiveSshKeyPath(
  cfg: Record<string, unknown>,
  adminAuthSecret: string | undefined,
  integrationId: string | undefined
): string | undefined {
  if (typeof cfg[SSH_RESOLVED_KEY_PATH] === "string") return cfg[SSH_RESOLVED_KEY_PATH] as string;
  const enc = cfg["sshPrivateKeyEnc"];
  if (typeof enc === "string" && enc.length > 0) {
    // When called from buildCapabilityInstance, decryptPasswordFields has already
    // decrypted the value to a raw PEM string. Detect that case and skip the extra
    // decryptToken call, which would otherwise fail unnecessarily.
    if (enc.includes("-----BEGIN")) {
      return resolveKeyFromPem(enc, integrationId ?? stableId(enc));
    }
    try {
      const pem = decryptToken(enc, adminAuthSecret);
      // Use a content-derived id when there is no real integrationId (e.g.
      // unsaved connection tests) so concurrent callers with different keys
      // get distinct temp files and cannot overwrite each other.
      return resolveKeyFromPem(pem, integrationId ?? stableId(pem));
    } catch (err) {
      throw new Error(
        "Failed to decrypt the stored SSH private key (sshPrivateKeyEnc). " +
        "Check that ADMIN_AUTH_SECRET matches the value used when the key was generated.",
        { cause: err }
      );
    }
  }
  return undefined;
}

/**
 * Resolve the SSH agent identity public key path from a parsed Gerrit config.
 * Returns the path to a temp .pub file if `sshAgentPublicKey` is configured,
 * or `undefined` if no identity pinning is wanted.
 */
export function resolveAgentIdentityPath(
  cfg: Record<string, unknown>,
  integrationId: string | undefined
): string | undefined {
  if (typeof cfg[SSH_AGENT_PUBKEY_PATH] === "string") return cfg[SSH_AGENT_PUBKEY_PATH] as string;
  const pubKey = cfg["sshAgentPublicKey"];
  if (typeof pubKey === "string" && pubKey.trim().length > 0) {
    // Use a content-derived id when there is no real integrationId (e.g.
    // unsaved connection tests) so concurrent callers with different public
    // keys get distinct temp files and cannot overwrite each other.
    return resolveAgentPubKeyPath(pubKey as string, integrationId ?? stableId(pubKey));
  }
  return undefined;
}
