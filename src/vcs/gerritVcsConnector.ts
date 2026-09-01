/**
 * GerritVcsConnector — SSH-based clone and push for Gerrit.
 * Pushes to `refs/for/<branch>` with a Change-Id trailer; all git operations run host-side.
 */

import { getLogger } from "../logger.js";
import { trustedGitEnv } from "../utils/gitExec.js";
import type { VcsConnector, VcsPushResult, VolumeExecOptions } from "./vcsConnector.js";
import type { PatchsetCheckoutOptions, ReviewComment } from "../interfaces.js";
import { GerritSshClient, buildSshHostKeyOptions } from "../connectors/gerritSshClient.js";
import { buildGerritTopic } from "./branchNaming.js";
import type { GitRunner } from "./gitRunner.js";
import { NodeGitRunner } from "./nodeGitRunner.js";
import { validateSshCloneUrl } from "./cloneUrlValidation.js";
import { sanitizeErrorDetail } from "../utils/redactUrl.js";
import { execInVolume } from "../workspace/dockerVolume.js";

const log = getLogger("gerrit-vcs");

export interface GerritVcsConnectorConfig {
  /** Optional Gerrit web URL used only to build clickable review links. */
  baseUrl?: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  /** Path to an SSH private-key file. Omit to use the system SSH agent. */
  sshKeyPath?: string | undefined;
  /** Path to an agent identity `.pub` file for identity pinning. Only used when sshKeyPath is absent. */
  sshAgentPubKeyPath?: string | undefined;
  /** Path to a known_hosts file. When set, SSH uses strict host key verification. */
  sshKnownHostsPath?: string | undefined;
  gitAuthorName: string;
  gitAuthorEmail: string;
}

/** Build the GIT_SSH_COMMAND string for authenticating git over SSH with the given config. */
function buildSshCommand(config: GerritVcsConnectorConfig, overrideSshKeyPath?: string): string {
  const keyPath = overrideSshKeyPath ?? config.sshKeyPath;
  const agentPubKeyPath = config.sshAgentPubKeyPath;
  const hostKeyOpts = buildSshHostKeyOptions(config.sshKnownHostsPath).join(" ");
  const portPart = `-p ${config.sshPort}`;
  const identityPart = keyPath
    ? `-i "${keyPath.replace(/"/g, '\\"')}" -o IdentitiesOnly=yes`
    : agentPubKeyPath
      ? `-o IdentitiesOnly=yes -i "${agentPubKeyPath.replace(/"/g, '\\"')}"`
      : "";
  return ["ssh", portPart, identityPart, hostKeyOpts].filter(Boolean).join(" ");
}

/** Build the process env object that injects GIT_SSH_COMMAND for Gerrit operations. */
function buildGitEnv(config: GerritVcsConnectorConfig, overrideSshKeyPath?: string): NodeJS.ProcessEnv {
  return trustedGitEnv({
    GIT_SSH_COMMAND: buildSshCommand(config, overrideSshKeyPath),
  });
}

/** Append Gerrit push options to a ref, preserving any options already present. */
function appendGerritPushOptions(ref: string, topic?: string, reviewerEmails?: string[]): string {
  const opts: string[] = [];
  if (topic) opts.push(`topic=${topic}`);
  for (const email of reviewerEmails ?? []) opts.push(`r=${email}`);
  if (opts.length === 0) return ref;
  return `${ref}${ref.includes("%") ? "," : "%"}${opts.join(",")}`;
}

export class GerritVcsConnector implements VcsConnector {
  readonly useChangeIdContinuity = true;
  readonly reviewSystemLabel = "gerrit";
  private readonly sshClient: GerritSshClient;

  /** Returns the path to the known_hosts file used by this connector's SSH transport, if configured. */
  get sshKnownHostsPath(): string | undefined {
    return this.config.sshKnownHostsPath;
  }

  /** Returns the SSH private key path used by this connector, if configured. */
  get sshKeyPath(): string | undefined {
    return this.config.sshKeyPath;
  }

  /** Returns the SSH agent public key path used for identity pinning, if configured. */
  get sshAgentPubKeyPath(): string | undefined {
    return this.config.sshAgentPubKeyPath;
  }

  constructor(
    private readonly config: GerritVcsConnectorConfig,
    private readonly gitRunner: GitRunner = new NodeGitRunner()
  ) {
    this.sshClient = new GerritSshClient({
      host: config.sshHost,
      port: config.sshPort,
      user: config.sshUser,
      ...(config.sshKeyPath !== undefined ? { keyPath: config.sshKeyPath } : {}),
      ...(config.sshAgentPubKeyPath !== undefined ? { agentPubKeyPath: config.sshAgentPubKeyPath } : {}),
      ...(config.sshKnownHostsPath !== undefined ? { knownHostsPath: config.sshKnownHostsPath } : {}),
    });
  }

  /** Returns the Gerrit push ref (`refs/for/<branch>`) and topic for the given task. */
  buildPushSpec(baseBranch: string, taskId: string, ticketTitle?: string | null): { ref: string; topic?: string } {
    return { ref: `refs/for/${baseBranch}`, topic: buildGerritTopic(taskId, ticketTitle) };
  }

  /**
   * Look up the real name/email registered on the Gerrit account this
   * connector's SSH credentials authenticate as (see
   * `GerritSshClient.queryOwnAccountIdentity`). Used to derive commit
   * author/committer identity automatically instead of a placeholder.
   */
  async queryAuthorIdentity(): Promise<{ name: string; email: string } | undefined> {
    return this.sshClient.queryOwnAccountIdentity();
  }

  /** Resolve a Change-Id to PatchsetCheckoutOptions by querying Gerrit via SSH. */
  async resolvePatchsetOptions(changeId: string): Promise<PatchsetCheckoutOptions> {
    const info = await this.sshClient.queryChange(changeId);
    // Build the SSH fetch URL from connection params — config.baseUrl is the Gerrit
    // web UI URL (optional, used only for review links) and must NOT be used here.
    const sshBaseUrl = `ssh://${this.config.sshUser}@${this.config.sshHost}:${this.config.sshPort}`;
    return {
      vcsBaseUrl: sshBaseUrl,
      revisionNumber: info.number,
      patchset: info.currentPatchSet?.number ?? 1,
      ...(this.config.sshKeyPath !== undefined ? { sshKeyPath: this.config.sshKeyPath } : {}),
      ...(this.config.sshAgentPubKeyPath !== undefined ? { sshAgentPubKeyPath: this.config.sshAgentPubKeyPath } : {}),
      ...(this.config.sshKnownHostsPath !== undefined ? { sshKnownHostsPath: this.config.sshKnownHostsPath } : {}),
      sshHost: this.config.sshHost,
      sshPort: this.config.sshPort,
      sshUser: this.config.sshUser,
    };
  }

  /**
   * Clone a repository via SSH.
   * Expects GIT_SSH_COMMAND environment variable to be pre-configured
   * with the SSH key path and options.
   * 
   * @param sshKeyPath Optional SSH key path override for this specific clone
   */
  async clone(repoUrl: string, branch: string, targetDir: string, sshKeyPath?: string): Promise<void> {
    validateSshCloneUrl(repoUrl, this.config.sshHost, this.config.sshPort, this.config.sshUser, "Gerrit");
    log.info(
      { repoUrl: sanitizeErrorDetail(repoUrl, 1000), branch, targetDir, usingCustomSshKey: Boolean(sshKeyPath) },
      "cloning repository from Gerrit via SSH"
    );

    try {
      await this.gitRunner.run(
        ["clone", "--branch", branch, "--depth", "1", "--", repoUrl, targetDir],
        {
          cwd: process.cwd(),
          env: buildGitEnv(this.config, sshKeyPath),
          timeoutMs: 300_000,
        }
      );

      log.info({ targetDir }, "repository cloned successfully");
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(`Failed to clone Gerrit repository: ${sanitizeErrorDetail(error.message, 1000)}`);
    }
  }

  /**
   * Push HEAD directly to Gerrit without creating a new commit on the host.
   * Used when the agent has already created N commits inside the container.
   * Each commit becomes a separate Gerrit change, grouped by topic.
   */
  async pushDirect(
    repoDir: string,
    ref: string,
    topic?: string,
    reviewerEmails?: string[],
    volumeOpts?: VolumeExecOptions
  ): Promise<VcsPushResult> {
    if (volumeOpts) {
      return this.pushDirectInVolume(volumeOpts, ref, topic, reviewerEmails);
    }

    log.info({ repoDir, ref, topic }, "pushing HEAD directly to Gerrit (agent-created commits)");

    try {
      const pushRef = `HEAD:${appendGerritPushOptions(ref, topic, reviewerEmails)}`;

      await this.gitRunner.run(["push", "origin", pushRef], {
        cwd: repoDir,
        env: buildGitEnv(this.config),
        timeoutMs: 300_000,
      });

      log.info({ ref, topic }, "direct push to Gerrit completed");

      // Extract Change-Id from HEAD commit for backward-compat result
      const { stdout: headMsg } = await this.gitRunner.run(
        ["log", "-1", "--format=%b"],
        { cwd: repoDir }
      );
      const changeIdMatch = headMsg.match(/^Change-Id:\s*(\S+)/m);
      const changeId = changeIdMatch?.[1] ?? "unknown";

      return {
        changeId,
        url: this.config.baseUrl ? `${this.config.baseUrl}/c/${changeId}` : "",
        status: "OPEN",
      };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(`Failed to push directly to Gerrit: ${sanitizeErrorDetail(error.message)}`);
    }

  }

  /** Push agent-created commits from a legacy Docker workspace volume. */
  private async pushDirectInVolume(
    volumeOpts: VolumeExecOptions,
    ref: string,
    topic?: string,
    reviewerEmails?: string[],
  ): Promise<VcsPushResult> {
    log.info({ volumeName: volumeOpts.volumeName, ref, topic }, "pushing HEAD directly to Gerrit via volume container");

    const cwd = volumeOpts.subPath && volumeOpts.subPath !== "."
      ? `/workspace/${volumeOpts.subPath}`
      : "/workspace";
    const pushRef = `HEAD:${appendGerritPushOptions(ref, topic, reviewerEmails)}`;
    const pushResult = await execInVolume({
      volumeName: volumeOpts.volumeName,
      image: volumeOpts.image,
      command: ["bash", "-c", `cd "${cwd}" && git push origin "${pushRef}"`],
      ...(this.config.sshKeyPath !== undefined ? { sshKeyPath: this.config.sshKeyPath } : {}),
      ...(this.config.sshAgentPubKeyPath !== undefined ? { sshAgentPubKeyPath: this.config.sshAgentPubKeyPath } : {}),
      ...(this.config.sshKnownHostsPath !== undefined ? { sshKnownHostsPath: this.config.sshKnownHostsPath } : {}),
      sshPort: this.config.sshPort,
      env: {},
    });
    if (pushResult.exitCode !== 0) {
      throw new Error(`Failed to push directly to Gerrit (volume): ${sanitizeErrorDetail(pushResult.stderr.slice(0, 500))}`);
    }

    const headResult = await execInVolume({
      volumeName: volumeOpts.volumeName,
      image: volumeOpts.image,
      command: ["bash", "-c", `cd "${cwd}" && git log -1 --format=%b`],
    });
    if (headResult.exitCode !== 0) {
      throw new Error(`Failed to read pushed Gerrit commit (volume): ${sanitizeErrorDetail(headResult.stderr.slice(0, 500))}`);
    }
    const changeId = headResult.stdout.match(/^Change-Id:\s*(\S+)/m)?.[1] ?? "unknown";
    return {
      changeId,
      url: this.config.baseUrl ? `${this.config.baseUrl}/c/${changeId}` : "",
      status: "OPEN",
    };
  }

  /**
   * Get the current status of a Gerrit change via SSH.
   * Returns "OPEN", "MERGED", or "ABANDONED".
   */
  async getChangeStatus(changeId: string): Promise<string> {
    log.info({ changeId }, "fetching Gerrit change status via SSH");
    try {
      const info = await this.sshClient.queryChange(changeId);
      return info.status === "NEW" ? "OPEN" : info.status;
    } catch (err) {
      log.warn({ changeId, err }, "failed to fetch Gerrit change status via SSH, defaulting to OPEN");
      return "OPEN";
    }
  }

  /**
   * Fetch review comments for a Gerrit change via SSH.
   * Delegates to GerritSshClient which uses Zod validation and supports
   * sincePatchset filtering.
   */
  async getUnresolvedComments(changeId: string): Promise<ReviewComment[]> {
    return this.sshClient.getUnresolvedComments(changeId, undefined, this.config.sshUser);
  }

  /**
   * Mark Gerrit review comment threads as resolved via SSH `gerrit review --json`.
   */
  async resolveComments(changeId: string, comments: ReviewComment[]): Promise<void> {
    return this.sshClient.resolveComments(changeId, comments);
  }
}
