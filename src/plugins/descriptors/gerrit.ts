import { z } from "zod";
import { promises as fs, constants as fsConstants } from "node:fs";
import type { PluginDescriptor } from "../registry.js";
import type { Integration } from "../../interfaces.js";
import {
  GerritSshConnector,
  GerritHttpConnector,
  listRepositoriesViaSsh,
} from "../../connectors/gerritConnector.js";
import { GerritStreamEventsManager, GERRIT_SSH_KEY_DEFAULT, GERRIT_SSH_PORT_DEFAULT } from "../../connectors/gerritStreamEvents.js";

export { GERRIT_SSH_KEY_DEFAULT, GERRIT_SSH_PORT_DEFAULT } from "../../connectors/gerritStreamEvents.js";
import { GerritSshReviewProvider } from "../../connectors/gerritSshReviewProvider.js";
import { GerritHttpReviewProvider } from "../../connectors/gerritHttpReviewProvider.js";
import { GerritHttpClient } from "../../connectors/gerritHttpClient.js";
import { GerritVcsConnector } from "../../vcs/gerritVcsConnector.js";
import { getLogger } from "../../logger.js";

const log = getLogger("gerrit-descriptor");

export const gerritConfigSchema = z.object({
  /**
   * Authentication mode.  Defaults to "ssh" for backward compatibility.
   * Set to "http" to use Gerrit HTTP credentials instead of SSH keys.
   */
  authMode: z.enum(["ssh", "http"]).default("ssh"),
  // ─── SSH fields (only required when authMode = "ssh") ───────────────────────
  sshHost: z.string().min(1).optional(),
  sshPort: z.coerce.number().int().positive().default(GERRIT_SSH_PORT_DEFAULT),
  sshUser: z.string().min(1).optional(),
  sshKeyPath: z.string().trim().min(1).default(GERRIT_SSH_KEY_DEFAULT),
  /** Path to a known_hosts file on the orchestrator filesystem. When set, SSH operations use strict host key verification instead of accepting any fingerprint. */
  sshKnownHostsPath: z.string().trim().min(1).optional(),
  // ─── HTTP fields (only required when authMode = "http") ─────────────────────
  /** Gerrit HTTP base URL, e.g. https://gerrit.example.com */
  httpBaseUrl: z.string().url().optional(),
  /** Gerrit HTTP username (same as SSH user by convention) */
  httpUsername: z.string().min(1).optional(),
  /** Gerrit HTTP password or generated token */
  httpToken: z.string().min(1).optional(),
  // ─── Shared optional fields ──────────────────────────────────────────────────
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
}).superRefine((val, ctx) => {
  if (val.authMode === "ssh") {
    if (!val.sshHost) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sshHost"], message: "sshHost is required when authMode is ssh" });
    }
    if (!val.sshUser) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sshUser"], message: "sshUser is required when authMode is ssh" });
    }
  } else {
    if (!val.httpBaseUrl) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["httpBaseUrl"], message: "httpBaseUrl is required when authMode is http" });
    }
    if (!val.httpUsername) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["httpUsername"], message: "httpUsername is required when authMode is http" });
    }
    if (!val.httpToken) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["httpToken"], message: "httpToken is required when authMode is http" });
    }
  }
});

export type GerritPluginConfig = z.infer<typeof gerritConfigSchema>;

/**
 * Parse a Gerrit integration's stored JSON config through the Zod schema so
 * that defaults (sshKeyPath, sshPort, …) are applied and required fields
 * are validated in one step.  Empty strings are removed before parsing so
 * that Zod `.default()` values take effect even when DB rows store `""`.
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
  // Strip empty strings so Zod defaults apply
  if ((n["sshKeyPath"] as string | undefined)?.trim() === "") delete n["sshKeyPath"];
  if ((n["sshKnownHostsPath"] as string | undefined)?.trim() === "") delete n["sshKnownHostsPath"];
  if ((n["sshPort"] as string | undefined) === "") delete n["sshPort"];
  if ((n["httpBaseUrl"] as string | undefined)?.trim() === "") delete n["httpBaseUrl"];
  if ((n["httpUsername"] as string | undefined)?.trim() === "") delete n["httpUsername"];
  if ((n["httpToken"] as string | undefined)?.trim() === "") delete n["httpToken"];
  const result = gerritConfigSchema.safeParse(n);
  return result.success ? result.data : null;
}

/**
 * Build the SSH connection args from a (possibly stripped) config object.
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

function getAuthMode(cfg: Record<string, unknown>): "ssh" | "http" {
  return cfg["authMode"] === "http" ? "http" : "ssh";
}

export const gerritDescriptor: PluginDescriptor = {
  type: "gerrit",
  name: "Gerrit",
  category: "review",
  configSchema: gerritConfigSchema,
  requiredFields: [
    // Auth mode selector (visible always)
    {
      key: "authMode",
      label: "Auth Mode",
      type: "select",
      required: true,
      options: [
        { value: "ssh", label: "SSH" },
        { value: "http", label: "HTTP Token" },
      ],
    },
    // SSH fields — shown only when authMode = "ssh"
    { key: "sshHost", label: "SSH Host", type: "text", required: false, placeholder: "gerrit", dependsOn: { field: "authMode", value: "ssh" } },
    { key: "sshPort", label: "SSH Port", type: "number", required: false, placeholder: "29418", dependsOn: { field: "authMode", value: "ssh" } },
    { key: "sshUser", label: "SSH User", type: "text", required: false, placeholder: "admin", dependsOn: { field: "authMode", value: "ssh" } },
    { key: "sshKeyPath", label: "SSH Key Path", type: "text", required: false, placeholder: "/home/<user>/.ssh/id_ed25519_gerrit", advanced: true, dependsOn: { field: "authMode", value: "ssh" } },
    { key: "sshKnownHostsPath", label: "SSH Known Hosts Path", type: "text", required: false, placeholder: "/home/<user>/.ssh/known_hosts", advanced: true, dependsOn: { field: "authMode", value: "ssh" } },
    // HTTP fields — shown only when authMode = "http"
    { key: "httpBaseUrl", label: "Gerrit URL", type: "url", required: false, placeholder: "https://gerrit.example.com", dependsOn: { field: "authMode", value: "http" } },
    { key: "httpUsername", label: "HTTP Username", type: "text", required: false, placeholder: "admin", dependsOn: { field: "authMode", value: "http" } },
    { key: "httpToken", label: "HTTP Token", type: "password", required: false, placeholder: "Gerrit HTTP password or token", dependsOn: { field: "authMode", value: "http" } },
  ],
  discoverResources: async (config) => {
    const parsed = gerritConfigSchema.parse(config);
    const cfg = config as Record<string, unknown>;
    const mode = getAuthMode(cfg);
    let repositories;
    if (mode === "http") {
      const http = new GerritHttpClient({
        baseUrl: parsed.httpBaseUrl!,
        username: parsed.httpUsername!,
        token: parsed.httpToken!,
      });
      const connector = new GerritHttpConnector({ http });
      repositories = await connector.listRepositories();
    } else {
      const ssh = buildSshArgs(cfg);
      const connector = new GerritSshConnector({
        ssh,
        ...(parsed.baseUrl !== undefined ? { baseUrl: parsed.baseUrl } : {}),
      });
      repositories = await connector.listRepositories();
    }
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
    const mode = getAuthMode(cfg);
    if (mode === "http") {
      const http = new GerritHttpClient({
        baseUrl: cfg["httpBaseUrl"] as string,
        username: cfg["httpUsername"] as string,
        token: cfg["httpToken"] as string,
      });
      return new GerritHttpConnector({
        http,
        ...(typeof cfg["baseUrl"] === "string" ? { baseUrl: cfg["baseUrl"] } : {}),
      });
    }
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
    const mode = getAuthMode(cfg);

    if (mode === "http") {
      const httpBaseUrl = typeof cfg["httpBaseUrl"] === "string" ? cfg["httpBaseUrl"].trim() : "";
      const httpUsername = typeof cfg["httpUsername"] === "string" ? cfg["httpUsername"].trim() : "";
      const httpToken = typeof cfg["httpToken"] === "string" ? cfg["httpToken"].trim() : "";
      if (!httpBaseUrl || !httpUsername || !httpToken) {
        return { success: false, error: "HTTP mode requires Gerrit URL, HTTP Username, and HTTP Token." };
      }
      try {
        const http = new GerritHttpClient({ baseUrl: httpBaseUrl, username: httpUsername, token: httpToken });
        await http.fetchJson("accounts/self");
        log.info({ httpBaseUrl, httpUsername }, "Gerrit HTTP connection test passed");
        return { success: true, error: null };
      } catch (err: unknown) {
        return { success: false, error: `Gerrit HTTP connection test failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    // SSH mode
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
    const mode = getAuthMode(cfg);
    if (mode === "http") {
      return new GerritVcsConnector({
        authMode: "http",
        httpBaseUrl: cfg["httpBaseUrl"] as string,
        httpUsername: cfg["httpUsername"] as string,
        httpToken: cfg["httpToken"] as string,
        gitAuthorName: (cfg["gitAuthorName"] as string | undefined) ?? "Virtual Engineer",
        gitAuthorEmail: (cfg["gitAuthorEmail"] as string | undefined) ?? "ve@virtual-engineer.local",
        ...(typeof cfg["baseUrl"] === "string" ? { baseUrl: cfg["baseUrl"] } : {}),
      });
    }
    const ssh = buildSshArgs(cfg);
    return new GerritVcsConnector({
      authMode: "ssh",
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
    const mode = getAuthMode(cfg);

    if (mode === "http") {
      const httpBaseUrl = cfg["httpBaseUrl"] as string;
      const httpUsername = cfg["httpUsername"] as string;
      const httpToken = cfg["httpToken"] as string;
      const httpClient = new GerritHttpClient({ baseUrl: httpBaseUrl, username: httpUsername, token: httpToken });
      return {
        systemPromptId: "system_gerrit_review",
        userPromptId: "user_gerrit_review",
        provider: new GerritHttpReviewProvider({
          httpBaseUrl,
          httpUsername,
          httpToken,
          ...(typeof cfg["reviewerAccountId"] === "string" && cfg["reviewerAccountId"] !== ""
            ? { reviewerAccountId: cfg["reviewerAccountId"] }
            : {}),
        }),
        buildCloneTarget: (details) => ({
          cloneUrl: httpClient.buildCloneUrl(details.project),
          sshKeyPath: null,
          sshKnownHostsPath: null,
        }),
        applyPatchset: async (handle, details): Promise<void> => {
          if (workspaceRunner.applyPriorPatchset !== undefined) {
            await workspaceRunner.applyPriorPatchset(handle, {
              vcsBaseUrl: httpBaseUrl,
              httpBaseUrl,
              httpUsername,
              httpToken,
              revisionNumber: details.changeNumber,
              patchset: details.currentPatchset,
            });
          }
        },
      };
    }

    // SSH mode
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
        if (workspaceRunner.applyPriorPatchset !== undefined) {
          await workspaceRunner.applyPriorPatchset(handle, {
            vcsBaseUrl: baseUrl,
            sshHost: ssh.host,
            sshPort: ssh.port,
            sshUser: ssh.user,
            sshKeyPath: ssh.keyPath,
            ...(ssh.knownHostsPath !== undefined ? { sshKnownHostsPath: ssh.knownHostsPath } : {}),
            revisionNumber: details.changeNumber,
            patchset: details.currentPatchset,
          });
        }
      },
    };
  },
  getSummaryDetails(config) {
    const mode = getAuthMode(config);
    if (mode === "http") {
      const httpBaseUrl = typeof config["httpBaseUrl"] === "string" && config["httpBaseUrl"].length > 0
        ? config["httpBaseUrl"]
        : "Gerrit URL missing";
      const httpUsername = typeof config["httpUsername"] === "string" && config["httpUsername"].length > 0
        ? config["httpUsername"]
        : "unset";
      return [httpBaseUrl, `HTTP user: ${httpUsername}`];
    }
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
