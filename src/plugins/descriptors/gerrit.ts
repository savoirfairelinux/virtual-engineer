import { z } from "zod";
import { promises as fs, constants as fsConstants } from "node:fs";
import type { ProviderDescriptor } from "../registry.js";
import type { Integration } from "../../interfaces.js";
import {
  GerritSshConnector,
  listRepositoriesViaSsh,
} from "../../connectors/gerritConnector.js";
import { GerritStreamEventsManager, GERRIT_SSH_PORT_DEFAULT } from "../../connectors/gerritStreamEvents.js";

export { GERRIT_SSH_PORT_DEFAULT } from "../../connectors/gerritStreamEvents.js";
import { GerritSshReviewProvider } from "../../connectors/gerritSshReviewProvider.js";
import { GerritVcsConnector } from "../../vcs/gerritVcsConnector.js";
import { getLogger } from "../../logger.js";
import { resolveEffectiveSshKeyPath, resolveAgentIdentityPath } from "../../utils/sshKeyResolver.js";
import { encryptToken } from "../../utils/encryption.js";
import { buildOpenSshEd25519PrivateKey } from "../../utils/opensshKeyFormat.js";
import { generateKeyPairSync } from "node:crypto";

const log = getLogger("gerrit-descriptor");

export const gerritConfigSchema = z.object({
  sshHost: z.string().min(1),
  sshPort: z.coerce.number().int().positive().default(GERRIT_SSH_PORT_DEFAULT),
  sshUser: z.string().min(1),
  /** Explicit SSH private-key file path. Leave blank to use a generated key or SSH agent. */
  sshKeyPath: z.string().trim().optional(),
  /** Path to a known_hosts file on the orchestrator filesystem. When set, SSH operations use strict host key verification instead of accepting any fingerprint. */
  sshKnownHostsPath: z.string().trim().optional(),
  /** AES-256-GCM–encrypted ed25519 private key PEM (generated via the UI). Takes effect when sshKeyPath is absent. */
  sshPrivateKeyEnc: z.string().optional(),
  /** OpenSSH public key corresponding to sshPrivateKeyEnc. Stored plaintext so the UI can display it. */
  sshPublicKey: z.string().optional(),
  /**
   * OpenSSH public key of the agent identity to use for this integration.
   * When set (and sshKeyPath / sshPrivateKeyEnc are absent), SSH agent mode is
   * used with `-o IdentitiesOnly=yes` so only this specific key is offered.
   * Leave blank to try all keys loaded in the agent.
   */
  sshAgentPublicKey: z.string().optional(),
  /** Optional Gerrit web URL used only to build clickable review links. */
  baseUrl: z.string().url().optional(),
  /**
   * Legacy single-repo clone URL. No longer required — clone URLs are derived
   * from discovered repositories and stored on project push targets.
   * Kept as optional so existing DB rows with this field remain valid.
   */
  repoCloneUrl: z.string().optional(),
  /**
   * Numeric Gerrit account id of the VE reviewer identity.
   * When set, this Gerrit integration also serves as a code-review provider:
   * - the reviewer-side polling loop uses it to filter changes assigned to VE
   *   (see ReviewOrchestrator / webhook-driven review discovery).
   * - the self-review guard skips changes owned by this account.
   * Leave empty to use the integration only for VCS push (legacy behaviour).
   */
  reviewerAccountId: z.string().optional(),
  /** Git author name used when the agent creates commits. */
  gitAuthorName: z.string().min(1).default("Virtual Engineer"),
  /** Git author email used when the agent creates commits. */
  gitAuthorEmail: z.string().min(1).default("ve@virtual-engineer.local"),
});

export type GerritPluginConfig = z.infer<typeof gerritConfigSchema>;

/**
 * Parse a Gerrit integration's stored JSON config through the Zod schema so
 * that defaults (sshPort, …) are applied and required fields
 * (sshHost, sshUser) are validated in one step.  Empty strings are removed
 * before parsing so that Zod `.default()` values take effect even when DB
 * rows store `""`.
 */
export function parseGerritConfig(integration: Integration): GerritPluginConfig | null {
  let raw: unknown;
  try {
    raw = JSON.parse(integration.configJson);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const n = raw as Record<string, unknown>;
  for (const k of ["sshKeyPath", "sshKnownHostsPath", "sshPrivateKeyEnc", "sshPublicKey", "sshAgentPublicKey"] as const) {
    if ((n[k] as string | undefined)?.trim() === "") delete n[k];
  }
  if ((n["sshPort"] as string | undefined) === "") delete n["sshPort"];
  const result = gerritConfigSchema.safeParse(n);
  return result.success ? result.data : null;
}

/**
 * Build the SSH connection args from a (possibly pre-processed) config object.
 *
 * Returns `keyPath` and `agentPubKeyPath` as optional strings:
 *   - `keyPath` set       → use private-key file (legacy path or resolved temp file)
 *   - `agentPubKeyPath` set → agent mode with identity pinning (only that key offered)
 *   - neither set         → SSH agent mode, all loaded keys tried
 */
function buildSshArgs(cfg: Record<string, unknown>): {
  host: string;
  user: string;
  port: number;
  keyPath: string | undefined;
  agentPubKeyPath: string | undefined;
  knownHostsPath: string | undefined;
} {
  // Prefer the pre-resolved path set by preprocessConfig; fall back to the raw
  // sshKeyPath field for callers that bypass preprocessConfig (e.g. unit tests).
  const resolvedKeyPath = cfg["_resolvedSshKeyPath"] as string | undefined;
  const rawKeyPath = cfg["sshKeyPath"] as string | undefined;
  const keyPath = resolvedKeyPath ?? (rawKeyPath && rawKeyPath.trim().length > 0 ? rawKeyPath.trim() : undefined);
  return {
    host: cfg["sshHost"] as string,
    user: cfg["sshUser"] as string,
    port: (cfg["sshPort"] as number | undefined) ?? GERRIT_SSH_PORT_DEFAULT,
    keyPath,
    agentPubKeyPath: cfg["_agentPubKeyPath"] as string | undefined,
    knownHostsPath: (cfg["sshKnownHostsPath"] as string | undefined) ?? undefined,
  };
}

/**
 * Generate a helper object for SSH key generation used by the API endpoint.
 * Returns the encrypted private key and OpenSSH public key.
 *
 * The private key is encoded in the native "OpenSSH private key" format
 * (`-----BEGIN OPENSSH PRIVATE KEY-----`), NOT PKCS#8 — OpenSSH's `ssh`
 * client cannot load ed25519 keys from PKCS#8 PEM ("invalid format").
 */
export function generateGerritSshKeyPair(adminAuthSecret: string | undefined): {
  sshPrivateKeyEnc: string;
  sshPublicKey: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  // JWK export exposes the raw 32-byte seed ("d") and raw 32-byte public key
  // ("x") directly, base64url-encoded — simpler and more robust than parsing
  // DER structures by hand.
  const jwkPriv = privateKey.export({ format: "jwk" }) as { d: string };
  const jwkPub = publicKey.export({ format: "jwk" }) as { x: string };
  const rawSeed = Buffer.from(jwkPriv.d, "base64url");
  const rawPub = Buffer.from(jwkPub.x, "base64url");

  const opensshPrivatePem = buildOpenSshEd25519PrivateKey(rawPub, rawSeed, "virtual-engineer");
  const opensshPub = rawEd25519ToOpenSshPublic(rawPub);

  return {
    sshPrivateKeyEnc: encryptToken(opensshPrivatePem, adminAuthSecret),
    sshPublicKey: opensshPub,
  };
}

/** Convert a raw 32-byte ed25519 public key to OpenSSH authorized_keys format. */
function rawEd25519ToOpenSshPublic(rawKey: Buffer): string {
  const typeStr = "ssh-ed25519";
  const typeBytes = Buffer.from(typeStr, "utf8");
  const typeLenBuf = Buffer.allocUnsafe(4);
  typeLenBuf.writeUInt32BE(typeBytes.length, 0);
  const keyLenBuf = Buffer.allocUnsafe(4);
  keyLenBuf.writeUInt32BE(rawKey.length, 0);
  const wire = Buffer.concat([typeLenBuf, typeBytes, keyLenBuf, rawKey]);
  return `${typeStr} ${wire.toString("base64")} virtual-engineer`;
}

export const gerritDescriptor: ProviderDescriptor = {
  provider: "gerrit",
  name: "Gerrit",
  icon: { slug: "gerrit", hex: "EE0000" },
  configSchema: gerritConfigSchema,
  requiredFields: [
    { key: "sshHost", label: "SSH Host", type: "text", required: true, placeholder: "gerrit" },
    { key: "sshPort", label: "SSH Port", type: "number", required: false, placeholder: "29418" },
    { key: "sshUser", label: "SSH User", type: "text", required: true, placeholder: "admin" },
    { key: "sshKnownHostsPath", label: "SSH Known Hosts Path", type: "text", required: false, placeholder: "/home/<user>/.ssh/known_hosts", advanced: true },
    // SSH key fields are managed via the dedicated SSH key UI section, not generic dynamic fields.
    // sshPrivateKeyEnc and sshPublicKey are hidden so the generic masking logic does not expose them.
    { key: "sshPrivateKeyEnc", label: "SSH Private Key (encrypted)", type: "password", required: false, hidden: true },
    { key: "sshPublicKey", label: "SSH Public Key", type: "text", required: false, hidden: true },
    { key: "sshAgentPublicKey", label: "SSH Agent Public Key", type: "text", required: false, hidden: true },
    { key: "sshKeyPath", label: "SSH Key Path", type: "text", required: false, hidden: true },
  ],

  /**
   * Resolve SSH key material to temp-file paths before passing config to
   * connector factories. Sets `_resolvedSshKeyPath` (for private-key and
   * generated-key modes) and `_agentPubKeyPath` (for agent identity pinning).
   */
  preprocessConfig(config, adminAuthSecret, integrationId) {
    const extra: Record<string, unknown> = {};
    const keyPath = resolveEffectiveSshKeyPath(config, adminAuthSecret, integrationId);
    if (keyPath !== undefined) {
      extra["_resolvedSshKeyPath"] = keyPath;
    } else {
      const agentPubKeyPath = resolveAgentIdentityPath(config, integrationId);
      if (agentPubKeyPath !== undefined) {
        extra["_agentPubKeyPath"] = agentPubKeyPath;
      }
    }
    return extra;
  },

  discoverResources: async (config) => {
    const cfg = config as Record<string, unknown>;
    const parsed = gerritConfigSchema.parse(cfg);
    // Merge Zod-applied defaults with the original config so runtime fields
    // (_resolvedSshKeyPath, _agentPubKeyPath) from preprocessConfig are preserved.
    const ssh = buildSshArgs({ ...(parsed as unknown as Record<string, unknown>), ...cfg });
    const connector = new GerritSshConnector({
      ssh,
      ...(parsed.baseUrl !== undefined ? { baseUrl: parsed.baseUrl } : {}),
    });
    const repositories = await connector.listRepositories();
    return {
      repositories,
      discoveredAt: new Date().toISOString(),
    };
  },
  discoverBranches: async (config, repoKey) => {
    const cfg = config as Record<string, unknown>;
    const parsed = gerritConfigSchema.parse(cfg);
    const ssh = buildSshArgs({ ...(parsed as unknown as Record<string, unknown>), ...cfg });
    const connector = new GerritSshConnector({
      ssh,
      ...(parsed.baseUrl !== undefined ? { baseUrl: parsed.baseUrl } : {}),
    });
    return connector.listBranches(repoKey);
  },
  testConnection: async (config) => {
    const cfg = config as Record<string, unknown>;
    const ssh = buildSshArgs(cfg);
    const ensureReadable = async (path: string, label: string): Promise<{ success: false; error: string } | null> => {
      try {
        await fs.access(path, fsConstants.R_OK);
        return null;
      } catch {
        return {
          success: false,
          error: `Gerrit connection test failed: ${label} not found or unreadable at '${path}'.`,
        };
      }
    };

    if (ssh.keyPath !== undefined) {
      const keyError = await ensureReadable(ssh.keyPath, "SSH private key");
      if (keyError) return keyError;
    }

    if (ssh.knownHostsPath !== undefined) {
      const knownHostsError = await ensureReadable(ssh.knownHostsPath, "SSH known_hosts file");
      if (knownHostsError) return knownHostsError;
    }
    try {
      const repositories = await listRepositoriesViaSsh(ssh);
      log.info({ sshHost: ssh.host, sshUser: ssh.user, sshPort: ssh.port, repositoryCount: repositories.length }, "Gerrit connection test passed");
      return { success: true, error: null };
    } catch (err: unknown) {
      return { success: false, error: `Gerrit connection test failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
  getSummaryDetails(config) {
    const baseUrl = typeof config["baseUrl"] === "string" && config["baseUrl"].length > 0
      ? config["baseUrl"]
      : "Gerrit URL missing";
    const sshHost = typeof config["sshHost"] === "string" && config["sshHost"].length > 0
      ? config["sshHost"]
      : "unset";
    const sshPort = typeof config["sshPort"] === "number" ? config["sshPort"] : GERRIT_SSH_PORT_DEFAULT;
    return [baseUrl, `SSH ${sshHost}:${sshPort}`];
  },
  normalizeConfigForRead(masked) {
    // Gerrit review events arrive via a host-side SSH stream listener, so the
    // webhook transport fields are never surfaced to the admin UI.
    const next = { ...masked };
    delete next["webhookSecret"];
    delete next["webhookAllowedIps"];
    return next;
  },
  capabilities: {
    code_review: {
      systemPromptId: "system_gerrit_review",
      userPromptId: "user_gerrit_review",
      intake: ["stream"],
      streamEvents: {
        createManager: (deps) => new GerritStreamEventsManager(deps),
      },
      createConnector: (config) => {
        const cfg = config as Record<string, unknown>;
        const ssh = buildSshArgs(cfg);
        return new GerritSshConnector({
          ssh: {
            host: ssh.host,
            port: ssh.port,
            user: ssh.user,
            ...(ssh.keyPath !== undefined ? { keyPath: ssh.keyPath } : {}),
            ...(ssh.agentPubKeyPath !== undefined ? { agentPubKeyPath: ssh.agentPubKeyPath } : {}),
            ...(ssh.knownHostsPath !== undefined ? { knownHostsPath: ssh.knownHostsPath } : {}),
          },
          ...(typeof cfg["baseUrl"] === "string" ? { baseUrl: cfg["baseUrl"] } : {}),
        });
      },
      createReviewer: (cfg, _integration, workspaceRunner) => {
        const ssh = buildSshArgs(cfg);
        const baseUrl = `ssh://${ssh.user}@${ssh.host}:${ssh.port}`;
        return {
          systemPromptId: "system_gerrit_review",
          userPromptId: "user_gerrit_review",
          provider: new GerritSshReviewProvider({
            sshHost: ssh.host,
            sshPort: ssh.port,
            sshUser: ssh.user,
            ...(ssh.keyPath !== undefined ? { sshKeyPath: ssh.keyPath } : {}),
            ...(ssh.agentPubKeyPath !== undefined ? { sshAgentPubKeyPath: ssh.agentPubKeyPath } : {}),
            ...(ssh.knownHostsPath !== undefined ? { sshKnownHostsPath: ssh.knownHostsPath } : {}),
            ...(typeof cfg["reviewerAccountId"] === "string" && cfg["reviewerAccountId"] !== ""
              ? { reviewerAccountId: cfg["reviewerAccountId"] }
              : {}),
          }),
          buildCloneTarget: (details) => ({
            cloneUrl: `${baseUrl}/${details.project}`,
            sshKeyPath: ssh.keyPath ?? null,
            sshAgentPubKeyPath: ssh.agentPubKeyPath ?? null,
            sshKnownHostsPath: ssh.knownHostsPath ?? null,
          }),
          applyPatchset: async (handle, details): Promise<void> => {
            if (workspaceRunner.applyPriorPatchset !== undefined) {
              await workspaceRunner.applyPriorPatchset(handle, {
                vcsBaseUrl: baseUrl,
                sshHost: ssh.host,
                sshPort: ssh.port,
                sshUser: ssh.user,
                ...(ssh.keyPath !== undefined ? { sshKeyPath: ssh.keyPath } : {}),
                ...(ssh.agentPubKeyPath !== undefined ? { sshAgentPubKeyPath: ssh.agentPubKeyPath } : {}),
                ...(ssh.knownHostsPath !== undefined ? { sshKnownHostsPath: ssh.knownHostsPath } : {}),
                revisionNumber: details.changeNumber,
                patchset: details.currentPatchset,
              });
            }
          },
        };
      },
    },
    source_control: {
      createVcsConnector: (cfg, _integration) => {
        const ssh = buildSshArgs(cfg);
        return new GerritVcsConnector({
          sshHost: ssh.host,
          sshPort: ssh.port,
          sshUser: ssh.user,
          ...(ssh.keyPath !== undefined ? { sshKeyPath: ssh.keyPath } : {}),
          ...(ssh.agentPubKeyPath !== undefined ? { sshAgentPubKeyPath: ssh.agentPubKeyPath } : {}),
          ...(ssh.knownHostsPath !== undefined ? { sshKnownHostsPath: ssh.knownHostsPath } : {}),
          gitAuthorName: (cfg["gitAuthorName"] as string | undefined) ?? "Virtual Engineer",
          gitAuthorEmail: (cfg["gitAuthorEmail"] as string | undefined) ?? "ve@virtual-engineer.local",
          ...(typeof cfg["baseUrl"] === "string" ? { baseUrl: cfg["baseUrl"] } : {}),
        });
      },
    },
  },
  /** SSH key pair generation — called by the admin API endpoint. */
  generateSshKeyPair: generateGerritSshKeyPair,
};

// Re-export for compatibility — the default key path constant is no longer used
// as a schema default but kept so callers that import it don't break.
export const GERRIT_SSH_KEY_DEFAULT = "/app/secrets/gerrit_id_ed25519";

