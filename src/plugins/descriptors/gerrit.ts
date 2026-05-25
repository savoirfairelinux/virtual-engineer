import { z } from "zod";
import { promises as fs, constants as fsConstants } from "node:fs";
import type { PluginDescriptor } from "../registry.js";
import type { Integration } from "../../interfaces.js";
import {
  GerritSshConnector,
  listRepositoriesViaSsh,
} from "../../connectors/gerritConnector.js";
import { GerritStreamEventsManager, GERRIT_SSH_KEY_DEFAULT, GERRIT_SSH_PORT_DEFAULT } from "../../connectors/gerritStreamEvents.js";

export { GERRIT_SSH_KEY_DEFAULT, GERRIT_SSH_PORT_DEFAULT } from "../../connectors/gerritStreamEvents.js";
import { GerritSshReviewProvider } from "../../connectors/gerritSshReviewProvider.js";
import { GerritVcsConnector } from "../../vcs/gerritVcsConnector.js";
import { getLogger } from "../../logger.js";

const log = getLogger("gerrit-descriptor");

export const gerritConfigSchema = z.object({
  sshHost: z.string().min(1),
  sshPort: z.coerce.number().int().positive().default(GERRIT_SSH_PORT_DEFAULT),
  sshUser: z.string().min(1),
  sshKeyPath: z.string().trim().min(1).default(GERRIT_SSH_KEY_DEFAULT),
  /** Path to a known_hosts file on the orchestrator filesystem. When set, SSH operations use strict host key verification instead of accepting any fingerprint. */
  sshKnownHostsPath: z.string().trim().min(1).optional(),
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
 * that defaults (sshKeyPath, sshPort, …) are applied and required fields
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
  if ((n["sshKeyPath"] as string | undefined)?.trim() === "") delete n["sshKeyPath"];
  if ((n["sshKnownHostsPath"] as string | undefined)?.trim() === "") delete n["sshKnownHostsPath"];
  if ((n["sshPort"] as string | undefined) === "") delete n["sshPort"];
  const result = gerritConfigSchema.safeParse(n);
  return result.success ? result.data : null;
}

/**
 * Build the SSH connection args from a (possibly stripped) config object.
 *
 * `sshKeyPath` and `sshPort` carry Zod defaults, so they may be absent after
 * `stripSchemaDefaults` is applied.  Apply the defaults here so both
 * `createInstance` and `createVcsConnector` stay in sync — adding a new SSH
 * field only requires changing this helper.
 */
function buildSshArgs(cfg: Record<string, unknown>): {
  host: string;
  user: string;
  port: number;
  keyPath: string;
  knownHostsPath: string | undefined;
} {
  return {
    host: cfg["sshHost"] as string,
    user: cfg["sshUser"] as string,
    port: (cfg["sshPort"] as number | undefined) ?? GERRIT_SSH_PORT_DEFAULT,
    keyPath: (cfg["sshKeyPath"] as string | undefined) ?? GERRIT_SSH_KEY_DEFAULT,
    knownHostsPath: (cfg["sshKnownHostsPath"] as string | undefined) ?? undefined,
  };
}

export const gerritDescriptor: PluginDescriptor = {
  type: "gerrit",
  name: "Gerrit",
  category: "review",
  configSchema: gerritConfigSchema,
  requiredFields: [
    { key: "sshHost", label: "SSH Host", type: "text", required: true, placeholder: "gerrit" },
    { key: "sshPort", label: "SSH Port", type: "number", required: false, placeholder: "29418" },
    { key: "sshUser", label: "SSH User", type: "text", required: true, placeholder: "admin" },
    { key: "sshKeyPath", label: "SSH Key Path", type: "text", required: false, placeholder: "/home/<user>/.ssh/id_ed25519_gerrit" },
    { key: "sshKnownHostsPath", label: "SSH Known Hosts Path", type: "text", required: false, placeholder: "/home/<user>/.ssh/known_hosts" },
  ],
  discoverResources: async (config) => {
    const parsed = gerritConfigSchema.parse(config);
    const ssh = buildSshArgs(parsed);
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
  streamEvents: {
    createManager: (deps) => new GerritStreamEventsManager(deps),
  },
  createInstance: (config) => {
    const cfg = config as Record<string, unknown>;
    const ssh = buildSshArgs(cfg);
    return new GerritSshConnector({
      ssh: {
        host: ssh.host,
        port: ssh.port,
        user: ssh.user,
        keyPath: ssh.keyPath,
        ...(ssh.knownHostsPath !== undefined ? { knownHostsPath: ssh.knownHostsPath } : {}),
      },
      ...(typeof cfg["baseUrl"] === "string" ? { baseUrl: cfg["baseUrl"] } : {}),
    });
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

    const keyError = await ensureReadable(ssh.keyPath, "SSH private key");
    if (keyError) return keyError;

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
  createVcsConnector: (cfg, _integration) => {
    const ssh = buildSshArgs(cfg);
    return new GerritVcsConnector({
      sshHost: ssh.host,
      sshPort: ssh.port,
      sshUser: ssh.user,
      sshKeyPath: ssh.keyPath,
      ...(ssh.knownHostsPath !== undefined ? { sshKnownHostsPath: ssh.knownHostsPath } : {}),
      gitAuthorName: (cfg["gitAuthorName"] as string | undefined) ?? "Virtual Engineer",
      gitAuthorEmail: (cfg["gitAuthorEmail"] as string | undefined) ?? "ve@virtual-engineer.local",
      ...(typeof cfg["baseUrl"] === "string" ? { baseUrl: cfg["baseUrl"] } : {}),
    });
  },
  reviewSystemPromptId: "system_gerrit_review",
  reviewUserPromptId: "user_gerrit_review",
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
        sshKeyPath: ssh.keyPath,
        ...(ssh.knownHostsPath !== undefined ? { sshKnownHostsPath: ssh.knownHostsPath } : {}),
        ...(typeof cfg["reviewerAccountId"] === "string" && cfg["reviewerAccountId"] !== ""
          ? { reviewerAccountId: cfg["reviewerAccountId"] }
          : {}),
      }),
      buildCloneTarget: (details) => ({
        cloneUrl: `${baseUrl}/${details.project}`,
        sshKeyPath: ssh.keyPath,
        sshKnownHostsPath: ssh.knownHostsPath ?? null,
      }),
      applyPatchset: async (handle, details): Promise<void> => {
        if (workspaceRunner.applyGerritPatchset !== undefined) {
          await workspaceRunner.applyGerritPatchset(handle, {
            gerritBaseUrl: baseUrl,
            sshHost: ssh.host,
            sshPort: ssh.port,
            sshUser: ssh.user,
            sshKeyPath: ssh.keyPath,
            ...(ssh.knownHostsPath !== undefined ? { sshKnownHostsPath: ssh.knownHostsPath } : {}),
            changeNumber: details.changeNumber,
            patchset: details.currentPatchset,
          });
        }
      },
    };
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
};
