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
import { resolveEffectiveSshKeyPath, resolveAgentIdentityPath, SSH_RESOLVED_KEY_PATH, SSH_AGENT_PUBKEY_PATH } from "../../utils/sshKeyResolver.js";
import { generateSshKeyPair, type GeneratedSshKeyPair } from "../../utils/sshKeyGen.js";
import { sshConnectionConfigSchema } from "../../utils/sshConfig.js";

const log = getLogger("gerrit-descriptor");

export const gerritConfigSchema = sshConnectionConfigSchema.extend({
  sshPort: z.coerce.number().int().positive().default(GERRIT_SSH_PORT_DEFAULT),
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
  for (const k of ["sshKnownHostsPath", "sshPrivateKeyEnc", "sshPublicKey", "sshAgentPublicKey"] as const) {
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
  // Prefer the pre-resolved path set by preprocessConfig.
  const resolvedKeyPath = cfg[SSH_RESOLVED_KEY_PATH] as string | undefined;
  const keyPath = resolvedKeyPath;
  return {
    host: cfg["sshHost"] as string,
    user: cfg["sshUser"] as string,
    port: (cfg["sshPort"] as number | undefined) ?? GERRIT_SSH_PORT_DEFAULT,
    keyPath,
    agentPubKeyPath: cfg[SSH_AGENT_PUBKEY_PATH] as string | undefined,
    knownHostsPath: (cfg["sshKnownHostsPath"] as string | undefined) ?? undefined,
  };
}

/**
 * Generate a Gerrit SSH key pair for the UI-generated-key auth mode.
 * Thin wrapper around the shared `generateSshKeyPair` util (see
 * src/utils/sshKeyGen.ts) — kept here so the descriptor's `generateSshKeyPair`
 * hook can pass a Gerrit-specific comment. The comment is tied to the actual
 * configured SSH user (`<sshUser>-gerrit`) rather than a hardcoded name, so
 * the generated public key is identifiable when registered under any Gerrit
 * account, not just "virtual-engineer". Falls back to "virtual-engineer-gerrit"
 * when no SSH user has been entered yet (e.g. new integration form).
 * Throws if `adminAuthSecret` is unset, since generated keys must always be
 * stored encrypted.
 */
export function generateGerritSshKeyPair(
  adminAuthSecret: string | undefined,
  sshUser?: string
): GeneratedSshKeyPair {
  const trimmedUser = sshUser?.trim();
  const comment = trimmedUser ? `${trimmedUser}-gerrit` : "virtual-engineer-gerrit";
  return generateSshKeyPair(adminAuthSecret, comment);
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
    { key: "gitAuthorName", label: "Commit Author Name", type: "text", required: false, placeholder: "Virtual Engineer", advanced: true },
    { key: "gitAuthorEmail", label: "Commit Author Email", type: "text", required: false, placeholder: "ve@virtual-engineer.local", advanced: true },
    // SSH key fields are managed via the dedicated SSH key UI section, not generic dynamic fields.
    // sshPrivateKeyEnc and sshPublicKey are hidden so the generic masking logic does not expose them.
    { key: "sshPrivateKeyEnc", label: "SSH Private Key (encrypted)", type: "password", required: false, hidden: true },
    { key: "sshPublicKey", label: "SSH Public Key", type: "text", required: false, hidden: true },
    { key: "sshAgentPublicKey", label: "SSH Agent Public Key", type: "text", required: false, hidden: true },
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
      extra[SSH_RESOLVED_KEY_PATH] = keyPath;
    } else {
      const agentPubKeyPath = resolveAgentIdentityPath(config, integrationId);
      if (agentPubKeyPath !== undefined) {
        extra[SSH_AGENT_PUBKEY_PATH] = agentPubKeyPath;
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

