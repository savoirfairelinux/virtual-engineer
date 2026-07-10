/**
 * GerritVcsConnector — SSH-based clone and push for Gerrit.
 * Pushes to `refs/for/<branch>` with a Change-Id trailer; all git operations run host-side.
 */

import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { getLogger } from "../logger.js";
import { execGit } from "../utils/gitExec.js";
import type { VcsConnector, VcsPushResult } from "./vcsConnector.js";
import type { PatchsetCheckoutOptions, ReviewComment } from "../interfaces.js";
import { GerritSshClient, buildSshHostKeyOptions } from "../connectors/gerritSshClient.js";
import { buildGerritTopic } from "./branchNaming.js";

const log = getLogger("gerrit-vcs");

/**
 * Generate a Gerrit-style Change-Id ("I" followed by 40 hex chars).
 */
function generateChangeId(seed: string): string {
  const hash = createHash("sha1")
    .update(`change-id-seed:${seed}\n${Date.now()}\n${Math.random()}`)
    .digest("hex");
  return `I${hash}`;
}

/**
 * Ensures the Change-Id trailer is in the last paragraph (footer) of the commit message.
 * Gerrit rejects pushes where Change-Id appears outside the footer; this function moves it there.
 */
function ensureChangeIdInFooter(message: string, changeId?: string): string {
  const existingMatch = message.match(/^Change-Id:\s*(\S+)/m);
  const existingId = existingMatch?.[1];

  const stripped = message
    .replace(/^Change-Id:[^\n]*\n?/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();

  const finalId = changeId ?? existingId ?? generateChangeId(stripped);

  const lastParaMatch = stripped.match(/\n\n([^\n][\s\S]*)$/);
  const lastPara = lastParaMatch?.[1] ?? "";
  const isTrailerBlock =
    lastPara.length > 0 &&
    lastPara.split("\n").every((line) => /^[A-Za-z][A-Za-z0-9-]*:/.test(line));

  return isTrailerBlock
    ? `${stripped}\nChange-Id: ${finalId}`
    : `${stripped}\n\nChange-Id: ${finalId}`;
}

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
  const identityPart = keyPath
    ? `-i "${keyPath.replace(/"/g, '\\"')}" -o IdentitiesOnly=yes`
    : agentPubKeyPath
      ? `-o IdentitiesOnly=yes -i "${agentPubKeyPath.replace(/"/g, '\\"')}"`
      : "";
  return ["ssh", identityPart, hostKeyOpts].filter(Boolean).join(" ");
}

/** Build the process env object that injects GIT_SSH_COMMAND for Gerrit operations. */
function buildGitEnv(config: GerritVcsConnectorConfig, overrideSshKeyPath?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_SSH_COMMAND: buildSshCommand(config, overrideSshKeyPath),
  };
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

  constructor(private readonly config: GerritVcsConnectorConfig) {
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
    log.info(
      { repoUrl, branch, targetDir, usingCustomSshKey: Boolean(sshKeyPath) },
      "cloning repository from Gerrit via SSH"
    );

    try {
      // Execute git clone
      execFileSync("git", ["clone", "--branch", branch, "--depth", "1", repoUrl, targetDir], {
        env: buildGitEnv(this.config, sshKeyPath),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 300_000, // 5 minutes
      });

      log.info({ targetDir }, "repository cloned successfully");
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(`Failed to clone Gerrit repository: ${error.message.slice(0, 1000)}`);
    }
  }

  /**
   * Push changes to Gerrit via SSH.
   * Configures git identity, commits changes, and pushes to refs/for/<branch>.
   */
  async push(
    repoDir: string,
    ref: string,
    message: string,
    changeId?: string
  ): Promise<VcsPushResult> {
    const commitMessage = ensureChangeIdInFooter(message, changeId);

    log.info(
      { repoDir, ref, changeId },
      "preparing to push to Gerrit"
    );

    try {
      // Configure git identity
      execGit(["config", "user.name", this.config.gitAuthorName], repoDir);
      execGit(["config", "user.email", this.config.gitAuthorEmail], repoDir);

      // Stage all changes
      execGit(["add", "-A"], repoDir);

      // Commit
      execGit(["commit", "-m", commitMessage], repoDir);
      log.info({ repoDir }, "changes committed");

      // Push to Gerrit
      execFileSync("git", ["push", "origin", `HEAD:${ref}`], {
        cwd: repoDir,
        env: buildGitEnv(this.config),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 300_000,
      });
      log.info({ ref }, "pushed to Gerrit");

      // Extract Change-Id from the message
      const changeIdMatch = commitMessage.match(/Change-Id:\s*(\S+)/);
      const extractedChangeId = changeIdMatch?.[1] ?? changeId ?? "unknown";

      const url = this.config.baseUrl ? `${this.config.baseUrl}/c/${extractedChangeId}` : "";

      return {
        changeId: extractedChangeId,
        url,
        status: "OPEN",
      };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(`Failed to push to Gerrit: ${error.message.slice(0, 500)}`);
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
    topic?: string
  ): Promise<VcsPushResult> {
    log.info({ repoDir, ref, topic }, "pushing HEAD directly to Gerrit (agent-created commits)");

    try {
      let pushRef = `HEAD:${ref}`;
      if (topic) {
        pushRef = `HEAD:${ref}%topic=${topic}`;
      }

      execFileSync("git", ["push", "origin", pushRef], {
        cwd: repoDir,
        env: buildGitEnv(this.config),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 300_000,
      });

      log.info({ ref, topic }, "direct push to Gerrit completed");

      // Extract Change-Id from HEAD commit for backward-compat result
      const headMsg = execGit(["log", "-1", "--format=%b"], repoDir);
      const changeIdMatch = headMsg.match(/^Change-Id:\s*(\S+)/m);
      const changeId = changeIdMatch?.[1] ?? "unknown";

      return {
        changeId,
        url: this.config.baseUrl ? `${this.config.baseUrl}/c/${changeId}` : "",
        status: "OPEN",
      };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(`Failed to push directly to Gerrit: ${error.message.slice(0, 500)}`);
    }
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
