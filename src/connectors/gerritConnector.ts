/**
 * Gerrit review connector — implements `ReviewConnector` via SSH API.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type {
  DiscoveredRepository,
  ReviewConnector,
  ReviewChangeRef,
  ReviewChangeStatus,
  ReviewComment,
  ExternalChangeId,
} from "../interfaces.js";
import { getLogger } from "../logger.js";
import { GerritSshClient } from "./gerritSshClient.js";

const log = getLogger("gerrit-connector");
const execFileAsync = promisify(execFile);

const SSH_TIMEOUT_MS = 30_000;

const GerritProjectInfoSchema = z.object({
  id: z.string().optional(),
  state: z.enum(["ACTIVE", "READ_ONLY", "HIDDEN"]).optional(),
  HEAD: z.string().optional(),
});

const GerritProjectsResponseSchema = z.record(GerritProjectInfoSchema);

export interface GerritSshDiscoveryConfig {
  host: string;
  user: string;
  port: number;
  keyPath: string;
  knownHostsPath?: string | undefined;
}

/**
 * List Gerrit repositories via `ssh gerrit ls-projects --format JSON`.
 */
export async function listRepositoriesViaSsh(
  ssh: GerritSshDiscoveryConfig
): Promise<DiscoveredRepository[]> {
  const { stdout } = await execFileAsync(
    "ssh",
    [
      "-p", String(ssh.port),
      "-i", ssh.keyPath,
      ...(ssh.knownHostsPath
        ? ["-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${ssh.knownHostsPath}`]
        : ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null"]),
      `${ssh.user}@${ssh.host}`,
      "gerrit", "ls-projects", "--format", "JSON",
    ],
    { timeout: SSH_TIMEOUT_MS }
  );

  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`gerrit ls-projects returned non-JSON output: ${stdout.slice(0, 200)}`);
  }

  const projects = GerritProjectsResponseSchema.parse(raw ?? {});
  const out: DiscoveredRepository[] = [];

  for (const [name, info] of Object.entries(projects)) {
    if (info.state === "READ_ONLY" || info.state === "HIDDEN") continue;

    const repo: DiscoveredRepository = {
      key: name,
      name,
      cloneUrlSsh: `ssh://${ssh.user}@${ssh.host}:${ssh.port}/${name}`,
    };

    if (info.HEAD) {
      const head = info.HEAD.startsWith("refs/heads/")
        ? info.HEAD.slice("refs/heads/".length)
        : info.HEAD;
      repo.defaultBranch = head;
    }

    out.push(repo);
  }

  log.debug({ count: out.length }, "discovered Gerrit projects via SSH");
  return out;
}

export interface GerritConnectorConfig {
  ssh: GerritSshDiscoveryConfig;
  /** Optional Gerrit web URL used only to build clickable change links. */
  baseUrl?: string;
}

export class GerritSshConnector implements ReviewConnector {
  private readonly sshClient: GerritSshClient;

  constructor(private readonly config: GerritConnectorConfig) {
    this.sshClient = new GerritSshClient({
      host: config.ssh.host,
      port: config.ssh.port,
      user: config.ssh.user,
      keyPath: config.ssh.keyPath,
      ...(config.ssh.knownHostsPath !== undefined ? { knownHostsPath: config.ssh.knownHostsPath } : {}),
    });
  }

  /** Fetch basic change ref info (number, patchset, URL) for a given Change-Id. */
  async getChange(changeId: ExternalChangeId): Promise<ReviewChangeRef> {
    const info = await this.sshClient.queryChange(changeId);
    const patchset = info.currentPatchSet?.number ?? 1;
    return {
      changeId,
      changeNumber: info.number,
      patchsetNumber: patchset,
      url: this.config.baseUrl
        ? `${this.config.baseUrl}/c/${info.number}`
        : info.url ?? `ssh://${this.config.ssh.user}@${this.config.ssh.host}:${this.config.ssh.port}/changes/${info.number}`,
    };
  }

  /** Return the current open/merged/abandoned status of a Gerrit change. */
  async getChangeStatus(changeId: ExternalChangeId): Promise<ReviewChangeStatus> {
    const info = await this.sshClient.queryChange(changeId);
    return info.status === "NEW" ? "OPEN" : info.status;
  }

  /** Fetch all unresolved (actionable) comments for the change via SSH. */
  async getUnresolvedComments(
    changeId: ExternalChangeId,
    sincePatchset?: number
  ): Promise<ReviewComment[]> {
    return this.sshClient.getUnresolvedComments(changeId, sincePatchset, this.config.ssh.user);
  }

  /** Post a top-level (patchset-level) comment on the given Gerrit change. */
  async addChangeComment(changeId: ExternalChangeId, message: string): Promise<void> {
    const info = await this.sshClient.queryChange(changeId);
    const patchset = info.currentPatchSet?.number ?? 1;
    await this.sshClient.query(["review", "--message", message, `${info.number},${patchset}`]);
    log.info({ changeId }, "added comment to Gerrit change via SSH");
  }

  /** Mark the given comment threads as resolved via SSH `gerrit review --json`. */
  async resolveComments(changeId: ExternalChangeId, comments: ReviewComment[]): Promise<void> {
    return this.sshClient.resolveComments(changeId, comments);
  }

  /** Discover all active Gerrit repositories via `gerrit ls-projects`. */
  async listRepositories(ssh?: {
    host?: string;
    user?: string;
    port?: number;
  }): Promise<DiscoveredRepository[]> {
    return listRepositoriesViaSsh({
      host: ssh?.host ?? this.config.ssh.host,
      user: ssh?.user ?? this.config.ssh.user,
      port: ssh?.port ?? this.config.ssh.port,
      keyPath: this.config.ssh.keyPath,
    });
  }
}
