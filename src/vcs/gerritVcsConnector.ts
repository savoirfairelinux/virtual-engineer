/**
 * GerritVcsConnector — SSH-based or HTTPS-based clone and push for Gerrit.
 * Pushes to `refs/for/<branch>` with a Change-Id trailer; all operations run inside Docker volumes.
 */

import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { getLogger } from "../logger.js";
import type { VcsConnector, VcsPushResult, VolumeExecOptions } from "./vcsConnector.js";
import type { PatchsetCheckoutOptions, ReviewComment } from "../interfaces.js";
import { execInVolume } from "../workspace/dockerVolume.js";
import { GerritSshClient, buildSshHostKeyOptions } from "../connectors/gerritSshClient.js";
import { GerritHttpClient } from "../connectors/gerritHttpClient.js";
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
  /** Authentication mode — determines which fields are used for transport. */
  authMode: "ssh" | "http";
  /** Optional Gerrit web URL used only to build clickable review links. */
  baseUrl?: string | undefined;
  // ─── SSH fields (used when authMode = "ssh") ──────────────────────────────
  sshHost?: string | undefined;
  sshPort?: number | undefined;
  sshUser?: string | undefined;
  sshKeyPath?: string | undefined;
  /** Path to a known_hosts file. When set, SSH uses strict host key verification. */
  sshKnownHostsPath?: string | undefined;
  // ─── HTTP fields (used when authMode = "http") ────────────────────────────
  /** Gerrit HTTP base URL, e.g. https://gerrit.example.com */
  httpBaseUrl?: string | undefined;
  /** Gerrit HTTP username */
  httpUsername?: string | undefined;
  /** Gerrit HTTP token / password */
  httpToken?: string | undefined;
  // ─── Shared ───────────────────────────────────────────────────────────────
  gitAuthorName: string;
  gitAuthorEmail: string;
}

/** Build the GIT_SSH_COMMAND string for authenticating git over SSH with the given config. */
function buildSshCommand(config: GerritVcsConnectorConfig, overrideSshKeyPath?: string): string {
  const keyPath = overrideSshKeyPath ?? config.sshKeyPath ?? "";
  const quotedKeyPath = keyPath.replace(/"/g, '\\"');
  const hostKeyOpts = buildSshHostKeyOptions(config.sshKnownHostsPath).join(" ");
  return [
    "ssh",
    `-i "${quotedKeyPath}"`,
    "-o IdentitiesOnly=yes",
    hostKeyOpts,
  ].join(" ");
}

/** Build the process env object that injects GIT_SSH_COMMAND for Gerrit SSH operations. */
function buildGitEnv(config: GerritVcsConnectorConfig, overrideSshKeyPath?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_SSH_COMMAND: buildSshCommand(config, overrideSshKeyPath),
  };
}

/** Build process env for Gerrit HTTP git operations. */
function buildHttpGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
  };
}

/**
 * Extract the repository path segment from the current git remote "origin" URL.
 * Works for both SSH (ssh://user@host:port/path or user@host:path) and HTTPS URLs.
 * Returns the path without a leading slash (e.g. "some/repo").
 */
function getRepoPathFromRemote(repoDir: string): string {
  try {
    const rawUrl = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

    // Try standard URL parsing first (works for https:// and ssh:// URLs)
    try {
      const parsed = new URL(rawUrl);
      return parsed.pathname.replace(/^\//, "");
    } catch {
      // SCP-style SSH URL: user@host:path/to/repo
      const scpMatch = rawUrl.match(/^[^@]+@[^:]+:(.+)$/);
      if (scpMatch?.[1]) {
        return scpMatch[1];
      }
    }
    return rawUrl;
  } catch {
    return "";
  }
}

/**
 * Helper to execute git commands in a specific directory.
 * Throws on non-zero exit.
 */
function execGit(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    const message = error.message || "git command failed";
    throw new Error(`git ${args[0]}: ${message.slice(0, 500)}`);
  }
}

export class GerritVcsConnector implements VcsConnector {
  readonly useChangeIdContinuity = true;
  readonly reviewSystemLabel = "gerrit";
  private readonly sshClient: GerritSshClient | null;
  private readonly httpClient: GerritHttpClient | null;

  /** Returns the path to the known_hosts file used by this connector's SSH transport, if configured. */
  get sshKnownHostsPath(): string | undefined {
    return this.config.sshKnownHostsPath;
  }

  /** Returns the SSH private key path used by this connector (SSH mode only). */
  get sshKeyPath(): string {
    return this.config.sshKeyPath ?? "";
  }

  constructor(private readonly config: GerritVcsConnectorConfig) {
    if (config.authMode === "http") {
      this.sshClient = null;
      this.httpClient = new GerritHttpClient({
        baseUrl: config.httpBaseUrl!,
        username: config.httpUsername!,
        token: config.httpToken!,
      });
    } else {
      this.sshClient = new GerritSshClient({
        host: config.sshHost!,
        port: config.sshPort!,
        user: config.sshUser!,
        keyPath: config.sshKeyPath!,
        ...(config.sshKnownHostsPath !== undefined ? { knownHostsPath: config.sshKnownHostsPath } : {}),
      });
      this.httpClient = null;
    }
  }

  /** Returns the Gerrit push ref (`refs/for/<branch>`) and topic for the given task. */
  buildPushSpec(baseBranch: string, taskId: string, ticketTitle?: string | null): { ref: string; topic?: string } {
    return { ref: `refs/for/${baseBranch}`, topic: buildGerritTopic(taskId, ticketTitle) };
  }

  /** Resolve a Change-Id to PatchsetCheckoutOptions. Queries Gerrit via SSH or HTTP REST. */
  async resolvePatchsetOptions(changeId: string): Promise<PatchsetCheckoutOptions> {
    if (this.config.authMode === "http") {
      const http = this.httpClient!;
      const encoded = encodeURIComponent(changeId);
      const data = await http.fetchJson<Record<string, unknown>>(
        `changes/${encoded}?o=CURRENT_REVISION`
      );
      const changeNumber = typeof data["_number"] === "number" ? data["_number"] : 0;
      const currentRevSha = typeof data["current_revision"] === "string" ? data["current_revision"] : undefined;
      const revisions = typeof data["revisions"] === "object" && data["revisions"] !== null
        ? data["revisions"] as Record<string, { _number: number }>
        : {};
      const patchset = (currentRevSha && revisions[currentRevSha]?._number) || 1;
      return {
        vcsBaseUrl: this.config.httpBaseUrl!,
        revisionNumber: changeNumber,
        patchset,
        httpBaseUrl: this.config.httpBaseUrl,
        httpUsername: this.config.httpUsername,
        httpToken: this.config.httpToken,
      };
    }
    const info = await this.sshClient!.queryChange(changeId);
    return {
      vcsBaseUrl: this.config.baseUrl ?? "",
      revisionNumber: info.number,
      patchset: info.currentPatchSet?.number ?? 1,
      sshKeyPath: this.config.sshKeyPath,
      ...(this.config.sshKnownHostsPath !== undefined ? { sshKnownHostsPath: this.config.sshKnownHostsPath } : {}),
      sshHost: this.config.sshHost,
      sshPort: this.config.sshPort,
      sshUser: this.config.sshUser,
    };
  }

  /**
   * Clone a repository.
   * SSH mode: uses GIT_SSH_COMMAND with the configured key.
   * HTTP mode: uses HTTPS URL with embedded credentials.
   * 
   * @param sshKeyPath Optional SSH key path override (SSH mode only)
   */
  async clone(repoUrl: string, branch: string, targetDir: string, sshKeyPath?: string): Promise<void> {
    log.info(
      { repoUrl, branch, targetDir, authMode: this.config.authMode },
      "cloning repository from Gerrit"
    );

    try {
      if (this.config.authMode === "http") {
        // Rewrite the repo URL with embedded credentials if it looks like a plain HTTPS URL
        const cloneUrl = this.httpClient!.buildCloneUrl(new URL(repoUrl).pathname.replace(/^\//, ""));
        execFileSync("git", ["clone", "--branch", branch, "--depth", "1", cloneUrl, targetDir], {
          env: buildHttpGitEnv(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 300_000,
        });
      } else {
        execFileSync("git", ["clone", "--branch", branch, "--depth", "1", repoUrl, targetDir], {
          env: buildGitEnv(this.config, sshKeyPath),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 300_000,
        });
      }
      log.info({ targetDir }, "repository cloned successfully");
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(`Failed to clone Gerrit repository: ${error.message.slice(0, 1000)}`);
    }
  }

  /**
   * Push changes to Gerrit.
   * SSH mode: push via SSH using GIT_SSH_COMMAND.
   * HTTP mode: push via HTTPS using embedded credentials.
   */
  async push(
    repoDir: string,
    ref: string,
    message: string,
    changeId?: string,
    volumeOpts?: VolumeExecOptions
  ): Promise<VcsPushResult> {
    const commitMessage = ensureChangeIdInFooter(message, changeId);

    if (volumeOpts) {
      return this.pushInVolume(volumeOpts, ref, commitMessage);
    }

    log.info(
      { repoDir, ref, changeId, authMode: this.config.authMode },
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
      const pushEnv = this.config.authMode === "http" ? buildHttpGitEnv() : buildGitEnv(this.config);
      if (this.config.authMode === "http") {
        // Set origin remote URL to include credentials
        const originUrl = this.httpClient!.buildCloneUrl(getRepoPathFromRemote(repoDir));
        execGit(["remote", "set-url", "origin", originUrl], repoDir);
      }
      execFileSync("git", ["push", "origin", `HEAD:${ref}`], {
        cwd: repoDir,
        env: pushEnv,
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
   */
  async pushDirect(
    repoDir: string,
    ref: string,
    topic?: string,
    volumeOpts?: VolumeExecOptions
  ): Promise<VcsPushResult> {
    if (volumeOpts) {
      return this.pushDirectInVolume(volumeOpts, ref, topic);
    }

    log.info({ repoDir, ref, topic, authMode: this.config.authMode }, "pushing HEAD directly to Gerrit (agent-created commits)");

    try {
      let pushRef = `HEAD:${ref}`;
      if (topic) {
        pushRef = `HEAD:${ref}%topic=${topic}`;
      }

      const pushEnv = this.config.authMode === "http" ? buildHttpGitEnv() : buildGitEnv(this.config);
      if (this.config.authMode === "http") {
        const originUrl = this.httpClient!.buildCloneUrl(getRepoPathFromRemote(repoDir));
        execGit(["remote", "set-url", "origin", originUrl], repoDir);
      }
      execFileSync("git", ["push", "origin", pushRef], {
        cwd: repoDir,
        env: pushEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 300_000,
      });

      log.info({ ref, topic }, "direct push to Gerrit completed");

      // Extract Change-Id from HEAD commit for backward-compat result
      const headMsg = execGit(["log", "-1", "--format=%b"], repoDir);
      const changeIdMatch = headMsg.match(/^Change-Id:\s*(\S+)/m);
      const extractedChangeId = changeIdMatch?.[1] ?? "unknown";

      return {
        changeId: extractedChangeId,
        url: this.config.baseUrl ? `${this.config.baseUrl}/c/${extractedChangeId}` : "",
        status: "OPEN",
      };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(`Failed to push directly to Gerrit: ${error.message.slice(0, 500)}`);
    }
  }

  // ─── Volume-based push helpers ──────────────────────────────────────────────

  /** Stage, commit and push via a helper container that mounts the named Docker volume. */
  private async pushInVolume(
    volumeOpts: VolumeExecOptions,
    ref: string,
    commitMessage: string
  ): Promise<VcsPushResult> {
    log.info({ volumeName: volumeOpts.volumeName, ref, authMode: this.config.authMode }, "pushing to Gerrit via volume container");

    const encodedMsg = Buffer.from(commitMessage).toString("base64");
    const cwd = volumeOpts.subPath && volumeOpts.subPath !== "."
      ? `/workspace/${volumeOpts.subPath}`
      : "/workspace";

    let result;
    if (this.config.authMode === "http") {
      // HTTP mode: set origin URL with embedded credentials, then push
      result = await execInVolume({
        volumeName: volumeOpts.volumeName,
        image: volumeOpts.image,
        command: ["bash", "-c", [
          `cd "${cwd}"`,
          `git config user.name "$VE_GIT_NAME"`,
          `git config user.email "$VE_GIT_EMAIL"`,
          `git add -A`,
          `echo "$VE_COMMIT_MSG_B64" | base64 -d > /tmp/ve-commit-msg.txt`,
          `git commit -F /tmp/ve-commit-msg.txt`,
          `_REPO_PATH=$(git remote get-url origin | sed 's|.*://[^/]*/||; s|[?#].*||')`,
          `git remote set-url origin "https://$VE_HTTP_USER:$VE_HTTP_TOKEN@$VE_HTTP_HOST/$_REPO_PATH"`,
          `git push origin "HEAD:$VE_PUSH_REF"`,
        ].join(" && ")],
        env: {
          VE_GIT_NAME: this.config.gitAuthorName,
          VE_GIT_EMAIL: this.config.gitAuthorEmail,
          VE_COMMIT_MSG_B64: encodedMsg,
          VE_PUSH_REF: ref,
          VE_HTTP_USER: this.config.httpUsername ?? "",
          VE_HTTP_TOKEN: this.config.httpToken ?? "",
          VE_HTTP_HOST: new URL(this.config.httpBaseUrl!).host,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "/bin/false",
        },
      });
    } else {
      result = await execInVolume({
        volumeName: volumeOpts.volumeName,
        image: volumeOpts.image,
        command: ["bash", "-c", [
          `cd "${cwd}"`,
          `git config user.name "$VE_GIT_NAME"`,
          `git config user.email "$VE_GIT_EMAIL"`,
          `git add -A`,
          `echo "$VE_COMMIT_MSG_B64" | base64 -d > /tmp/ve-commit-msg.txt`,
          `git commit -F /tmp/ve-commit-msg.txt`,
          `git push origin "HEAD:$VE_PUSH_REF"`,
        ].join(" && ")],
        sshKeyPath: this.config.sshKeyPath,
        ...(this.config.sshKnownHostsPath !== undefined ? { sshKnownHostsPath: this.config.sshKnownHostsPath } : {}),
        env: {
          VE_GIT_NAME: this.config.gitAuthorName,
          VE_GIT_EMAIL: this.config.gitAuthorEmail,
          VE_COMMIT_MSG_B64: encodedMsg,
          VE_PUSH_REF: ref,
        },
      });
    }

    if (result.exitCode !== 0) {
      throw new Error(`Failed to push to Gerrit (volume): ${result.stderr.slice(0, 500)}`);
    }

    const changeIdMatch = commitMessage.match(/Change-Id:\s*(\S+)/);
    const extractedChangeId = changeIdMatch?.[1] ?? "unknown";
    const url = this.config.baseUrl ? `${this.config.baseUrl}/c/${extractedChangeId}` : "";

    return { changeId: extractedChangeId, url, status: "OPEN" };
  }

  /** Push HEAD directly to Gerrit from inside the named Docker volume (no new commit created). */
  private async pushDirectInVolume(
    volumeOpts: VolumeExecOptions,
    ref: string,
    topic?: string
  ): Promise<VcsPushResult> {
    log.info({ volumeName: volumeOpts.volumeName, ref, topic, authMode: this.config.authMode }, "pushing HEAD directly to Gerrit via volume container");

    let pushRef = `HEAD:${ref}`;
    if (topic) {
      pushRef = `HEAD:${ref}%topic=${topic}`;
    }

    const cwd = volumeOpts.subPath && volumeOpts.subPath !== "."
      ? `/workspace/${volumeOpts.subPath}`
      : "/workspace";

    let pushResult;
    if (this.config.authMode === "http") {
      pushResult = await execInVolume({
        volumeName: volumeOpts.volumeName,
        image: volumeOpts.image,
        command: ["bash", "-c", [
          `cd "${cwd}"`,
          `_REPO_PATH=$(git remote get-url origin | sed 's|.*://[^/]*/||; s|[?#].*||')`,
          `git remote set-url origin "https://$VE_HTTP_USER:$VE_HTTP_TOKEN@$VE_HTTP_HOST/$_REPO_PATH"`,
          `git push origin "${pushRef}"`,
        ].join(" && ")],
        env: {
          VE_HTTP_USER: this.config.httpUsername ?? "",
          VE_HTTP_TOKEN: this.config.httpToken ?? "",
          VE_HTTP_HOST: new URL(this.config.httpBaseUrl!).host,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "/bin/false",
        },
      });
    } else {
      pushResult = await execInVolume({
        volumeName: volumeOpts.volumeName,
        image: volumeOpts.image,
        command: ["bash", "-c", `cd "${cwd}" && git push origin "${pushRef}"`],
        sshKeyPath: this.config.sshKeyPath,
        ...(this.config.sshKnownHostsPath !== undefined ? { sshKnownHostsPath: this.config.sshKnownHostsPath } : {}),
        env: {},
      });
    }

    if (pushResult.exitCode !== 0) {
      throw new Error(`Failed to push directly to Gerrit (volume): ${pushResult.stderr.slice(0, 500)}`);
    }

    // Extract Change-Id from HEAD commit
    const logResult = await execInVolume({
      volumeName: volumeOpts.volumeName,
      image: volumeOpts.image,
      command: ["bash", "-c", `cd "${cwd}" && git log -1 --format=%b`],
    });

    const changeIdMatch = logResult.stdout.match(/^Change-Id:\s*(\S+)/m);
    const changeId = changeIdMatch?.[1] ?? "unknown";

    return {
      changeId,
      url: this.config.baseUrl ? `${this.config.baseUrl}/c/${changeId}` : "",
      status: "OPEN",
    };
  }

  /**
   * Get the current status of a Gerrit change.
   * Returns "OPEN", "MERGED", or "ABANDONED".
   */
  async getChangeStatus(changeId: string): Promise<string> {
    log.info({ changeId, authMode: this.config.authMode }, "fetching Gerrit change status");
    try {
      if (this.config.authMode === "http") {
        const encoded = encodeURIComponent(changeId);
        const data = await this.httpClient!.fetchJson<Record<string, unknown>>(`changes/${encoded}`);
        const status = data["status"];
        return status === "NEW" ? "OPEN" : typeof status === "string" ? status : "OPEN";
      }
      const info = await this.sshClient!.queryChange(changeId);
      return info.status === "NEW" ? "OPEN" : info.status;
    } catch (err) {
      log.warn({ changeId, err }, "failed to fetch Gerrit change status, defaulting to OPEN");
      return "OPEN";
    }
  }

  /**
   * Fetch review comments for a Gerrit change.
   */
  async getUnresolvedComments(changeId: string): Promise<ReviewComment[]> {
    if (this.config.authMode === "http") {
      // Use HTTP REST to fetch comments
      const encoded = encodeURIComponent(changeId);
      const veUsername = this.config.httpUsername ?? "";
      try {
        const fileComments = await this.httpClient!.fetchJson<Record<string, unknown[]>>(
          `changes/${encoded}/comments`
        );
        const results: ReviewComment[] = [];
        for (const [filePath, commentList] of Object.entries(fileComments)) {
          for (const raw of commentList) {
            if (typeof raw !== "object" || raw === null) continue;
            const c = raw as Record<string, unknown>;
            if (c["unresolved"] === false) continue;
            const author = c["author"] as Record<string, unknown> | undefined;
            const authorUsername = author?.["username"];
            if (veUsername && authorUsername === veUsername) continue;
            const updatedAt = typeof c["updated"] === "string" ? new Date(c["updated"]) : new Date();
            results.push({
              id: typeof c["id"] === "string" ? c["id"] : `rest-${Date.now()}`,
              author: (author?.["email"] ?? author?.["username"] ?? "unknown") as string,
              message: typeof c["message"] === "string" ? c["message"] : "",
              filePath: filePath === "/COMMIT_MSG" ? undefined : filePath,
              line: typeof c["line"] === "number" ? c["line"] : undefined,
              unresolved: c["unresolved"] !== false,
              patchset: typeof c["patch_set"] === "number" ? c["patch_set"] : 0,
              updatedAt,
            });
          }
        }
        return results;
      } catch (err) {
        log.warn({ changeId, err }, "failed to fetch Gerrit comments via HTTP REST");
        return [];
      }
    }
    return this.sshClient!.getUnresolvedComments(changeId, undefined, this.config.sshUser ?? "");
  }

  /**
   * Mark Gerrit review comment threads as resolved.
   */
  async resolveComments(changeId: string, comments: ReviewComment[]): Promise<void> {
    if (this.config.authMode === "http") {
      if (comments.length === 0) return;
      const encoded = encodeURIComponent(changeId);
      const commentUpdates: Record<string, Array<{ id: string; unresolved: boolean }>> = {};
      for (const c of comments) {
        const key = c.filePath ?? "/COMMIT_MSG";
        const arr = commentUpdates[key] ?? (commentUpdates[key] = []);
        arr.push({ id: c.id, unresolved: false });
      }
      await this.httpClient!.fetchVoid(
        `changes/${encoded}/review`,
        { method: "POST", body: JSON.stringify({ comments: commentUpdates }) }
      );
      return;
    }
    return this.sshClient!.resolveComments(changeId, comments);
  }
}
