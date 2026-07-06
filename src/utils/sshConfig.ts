/**
 * Shared Zod schema for providers that authenticate over SSH.
 *
 * Any provider descriptor that needs SSH connectivity should extend this
 * schema with `.extend({})` rather than re-declaring the common fields.
 * This guarantees consistent field names across providers and lets generic
 * helpers (`sshKeyResolver`, `dockerVolume`, etc.) rely on a single source
 * of truth for SSH config field names.
 *
 * Three authentication modes are supported (mutually exclusive by priority):
 *   1. Custom path   — `sshKeyPath` is set; key file must exist on the host FS.
 *   2. Generated key — `sshPrivateKeyEnc` is set (AES-256-GCM encrypted PEM).
 *   3. SSH agent     — neither key field is set; `SSH_AUTH_SOCK` is forwarded.
 *      Optional identity pinning via `sshAgentPublicKey`.
 *
 * Providers set provider-specific defaults (e.g. `sshPort`) by overriding the
 * relevant field inside their own `.extend({})` call.
 */
import { z } from "zod";

export const sshConnectionConfigSchema = z.object({
  sshHost: z.string().min(1),
  /** SSH port. Providers should override this with their own default (e.g. 29418 for Gerrit). */
  sshPort: z.coerce.number().int().positive(),
  sshUser: z.string().min(1),
  /** Explicit SSH private-key file path (legacy / custom path mode). Leave blank to use generated key or SSH agent. */
  sshKeyPath: z.string().trim().optional(),
  /** Path to a known_hosts file. When set, SSH operations use strict host-key verification. */
  sshKnownHostsPath: z.string().trim().optional(),
  /** AES-256-GCM–encrypted ed25519 private key PEM (generated via the UI). Used when sshKeyPath is absent. */
  sshPrivateKeyEnc: z.string().optional(),
  /** OpenSSH public key corresponding to sshPrivateKeyEnc. Stored plaintext so the UI can display it. */
  sshPublicKey: z.string().optional(),
  /**
   * OpenSSH public key of the SSH agent identity to use for this integration.
   * When set (and sshKeyPath / sshPrivateKeyEnc are absent), SSH agent mode is
   * used with `-o IdentitiesOnly=yes` so only this specific key is offered.
   * Leave blank to try all keys loaded in the agent.
   */
  sshAgentPublicKey: z.string().optional(),
});

export type SshConnectionConfig = z.infer<typeof sshConnectionConfigSchema>;
