/**
 * GitHubVcsConnector — HTTP-based clone and push for GitHub.
 *
 * Clone uses token in the remote URL; push creates or updates a pull request
 * via the GitHub REST API. Mirrors the design of GitLabVcsConnector — VE pushes
 * a feature branch, the orchestrator looks up the URL via the PR REST endpoint.
 */

import { execFileSync } from "child_process";
import { getLogger } from "../logger.js";
import { execGit } from "../utils/gitExec.js";
import type { VcsConnector, VcsPushResult, VolumeExecOptions } from "./vcsConnector.js";
import { buildFeatureBranchRef } from "./branchNaming.js";
import type { ReviewComment } from "../interfaces.js";
import { ReviewApiError } from "../interfaces.js";
import { execInVolume } from "../workspace/dockerVolume.js";
import { redactUrls } from "../utils/redactUrl.js";

const log = getLogger("github-vcs");

export interface GitHubVcsConnectorConfig {
  /** API base URL: "https://api.github.com" or "https://ghe.example.com/api/v3" */
  apiBaseUrl: string;
  /** Web host used for git push (e.g. "github.com" or "ghe.example.com") */
  host: string;
  /** Repository owner (user or organization) */
  owner: string;
  /** Repository name */
  repo: string;
  /** OAuth or PAT token used for git push and REST API calls */
  token: string;
  /** Git author name used when the agent creates commits */
  gitAuthorName: string;
  /** Git author email used when the agent creates commits */
  gitAuthorEmail: string;
  /** Target branch for PR creation. Defaults to "main". */
  targetBranch?: string;
}

export class GitHubVcsConnector implements VcsConnector {
  readonly useChangeIdContinuity = false;
  readonly reviewSystemLabel = "github" as const;

  constructor(private readonly config: GitHubVcsConnectorConfig) {}

  buildPushSpec(_baseBranch: string, taskId: string, ticketTitle?: string | null): { ref: string; topic?: string } {
    return { ref: buildFeatureBranchRef(taskId, ticketTitle ?? null) };
  }

  /** Clone a GitHub repository via HTTPS into the target directory. */
  async clone(repoUrl: string, branch: string, targetDir: string): Promise<void> {
    log.info({ repoUrl, branch, targetDir }, "cloning repository from GitHub via HTTPS");

    try {
      execFileSync("git", ["clone", "--branch", branch, "--depth", "1", repoUrl, targetDir], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 300_000,
      });
      log.info({ targetDir }, "repository cloned successfully");
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(`Failed to clone ${repoUrl}: ${error.message.slice(0, 500)}`);
    }
  }

  async push(
    repoDir: string,
    ref: string,
    message: string,
    _changeId?: string,
    _volumeOpts?: VolumeExecOptions
  ): Promise<VcsPushResult> {
    try {
      execGit(["config", "user.name", this.config.gitAuthorName], repoDir);
      execGit(["config", "user.email", this.config.gitAuthorEmail], repoDir);

      const featureBranch = ref;

      // Inject token-in-URL credentials for push (x-access-token works for both PAT and OAuth user tokens)
      const remoteUrl = execGit(["remote", "get-url", "origin"], repoDir).trim();
      const authenticatedUrl = new URL(remoteUrl);
      authenticatedUrl.username = "x-access-token";
      authenticatedUrl.password = this.config.token;

      execGit(["remote", "set-url", "origin", authenticatedUrl.toString()], repoDir);

      execGit(["add", "-A"], repoDir);
      execGit(["commit", "-m", message], repoDir);
      log.info({ repoDir }, "changes committed");

      try {
        execGit(["push", "-u", "origin", featureBranch], repoDir);
        log.info({ featureBranch }, "pushed to GitHub");
      } finally {
        execGit(["remote", "set-url", "origin", remoteUrl], repoDir);
      }

      const pr = await this.createOrFindPullRequest(
        featureBranch,
        this.config.targetBranch ?? "main",
        message.split("\n")[0] || `[VE] Feature branch ${featureBranch}`,
        message
      );

      return {
        changeId: String(pr.number),
        url: pr.html_url,
        status: pr.state === "closed" ? (pr.merged ? "MERGED" : "ABANDONED") : "OPEN",
      };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(`Failed to push to GitHub: ${redactUrls(error.message.slice(0, 500))}`);
    }
  }

  /**
   * Push HEAD directly without creating a new commit on the host.
   * Used when the agent has already committed inside the container.
   */
  async pushDirect(
    repoDir: string,
    ref: string,
    _topic?: string,
    volumeOpts?: VolumeExecOptions
  ): Promise<VcsPushResult> {
    if (volumeOpts) {
      return this.pushDirectInVolume(volumeOpts, ref);
    }

    const remoteUrl = execGit(["remote", "get-url", "origin"], repoDir).trim();
    const authenticatedUrl = new URL(remoteUrl);
    authenticatedUrl.username = "x-access-token";
    authenticatedUrl.password = this.config.token;
    execGit(["remote", "set-url", "origin", authenticatedUrl.toString()], repoDir);

    try {
      execGit(["push", "-u", "--force-with-lease", "origin", `HEAD:refs/heads/${ref}`], repoDir);
    } finally {
      execGit(["remote", "set-url", "origin", remoteUrl], repoDir);
    }

    const subject = execGit(["log", "-1", "--pretty=%s"], repoDir).trim();
    const body = execGit(["log", "-1", "--pretty=%b"], repoDir).trim();
    const pr = await this.createOrFindPullRequest(
      ref,
      this.config.targetBranch ?? "main",
      subject || `[VE] Push ${ref}`,
      body
    );

    return {
      changeId: String(pr.number),
      url: pr.html_url,
      status: pr.state === "closed" ? (pr.merged ? "MERGED" : "ABANDONED") : "OPEN",
    };
  }

  private async pushDirectInVolume(volumeOpts: VolumeExecOptions, ref: string): Promise<VcsPushResult> {
    log.info({ volumeName: volumeOpts.volumeName, ref }, "pushing HEAD directly to GitHub via volume container");

    const cwd = volumeOpts.subPath && volumeOpts.subPath !== "."
      ? `/workspace/${volumeOpts.subPath}`
      : "/workspace";

    const httpsRemote = `https://x-access-token:${this.config.token}@${this.config.host}/${this.config.owner}/${this.config.repo}.git`;

    // The agent's coding session (Copilot CLI / gh) may leave a stale `http.<url>.extraheader` in /workspace/.git/config
    // and/or configure a `credential.helper` (often in the global ~/.gitconfig) for this host,
    // using a *different* token (e.g. the Copilot integration's own GitHub OAuth token for LLM calls).
    // Git sends `http.extraheader` regardless of URL-embedded credentials, so a leftover header here
    // shadows the push credentials below and GitHub rejects the request with a generic auth error.
    // Clear it and disable any configured credential helper for this push so only the explicit
    // token embedded in $VE_PUSH_URL is used (mirrors the documented actions/checkout workaround).
    const pushHost = `https://${this.config.host}/`;
    const pushResult = await execInVolume({
      volumeName: volumeOpts.volumeName,
      image: volumeOpts.image,
      command: ["bash", "-c", [
        `cd "${cwd}"`,
        `git config --unset-all "http.${pushHost}.extraheader" 2>/dev/null || true`,
        `git checkout -B "$VE_PUSH_REF"`,
        `git -c credential.helper= push --force -u "$VE_PUSH_URL" "$VE_PUSH_REF"`,
      ].join(" && ")],
      env: {
        VE_PUSH_REF: ref,
        VE_PUSH_URL: httpsRemote,
      },
    });

    if (pushResult.exitCode !== 0) {
      throw new Error(`Failed to push directly to GitHub (volume): ${redactUrls(pushResult.stderr.slice(0, 500))}`);
    }

    const logResult = await execInVolume({
      volumeName: volumeOpts.volumeName,
      image: volumeOpts.image,
      command: ["bash", "-c", `cd "${cwd}" && git log -1 --format=%s%n%b`],
    });

    const lines = logResult.stdout.split("\n");
    const subject = (lines[0] ?? "").trim();
    const body = lines.slice(1).join("\n").trim();

    const pr = await this.createOrFindPullRequest(
      ref,
      this.config.targetBranch ?? "main",
      subject || `[VE] Push ${ref}`,
      body
    );

    return {
      changeId: String(pr.number),
      url: pr.html_url,
      status: pr.state === "closed" ? (pr.merged ? "MERGED" : "ABANDONED") : "OPEN",
    };
  }

  async getChangeStatus(changeId: string): Promise<string> {
    const pr = await this.fetchPullRequest(parseInt(changeId, 10));
    if (pr.state === "closed") return pr.merged ? "MERGED" : "ABANDONED";
    return "OPEN";
  }

  async getUnresolvedComments(_changeId: string): Promise<ReviewComment[]> {
    // VE reads PR review comments via the dedicated ReviewConnector
    // (GitHubPullRequestReviewConnector). The VCS connector intentionally
    // returns no comments to avoid duplicate fetching.
    return [];
  }

  async resolveComments(_changeId: string, _comments: ReviewComment[]): Promise<void> {
    // No-op: resolution lives in GitHubPullRequestReviewConnector (GraphQL).
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private repoApiUrl(): string {
    return `${this.config.apiBaseUrl}/repos/${this.config.owner}/${this.config.repo}`;
  }

  private async fetchPullRequest(prNumber: number): Promise<GitHubPrShape> {
    const url = `${this.repoApiUrl()}/pulls/${prNumber}`;
    const response = await globalThis.fetch(url, {
      headers: this.authHeaders(),
    });
    if (!response.ok) {
      throw new ReviewApiError(response.status, url, await response.text().catch(() => ""));
    }
    return (await response.json()) as GitHubPrShape;
  }

  private async createOrFindPullRequest(
    head: string,
    base: string,
    title: string,
    body: string
  ): Promise<GitHubPrShape> {
    // Try to find existing PR for this head branch first
    const listUrl = `${this.repoApiUrl()}/pulls?state=open&head=${encodeURIComponent(
      `${this.config.owner}:${head}`
    )}`;
    const listResponse = await globalThis.fetch(listUrl, { headers: this.authHeaders() });
    if (listResponse.ok) {
      const existing = (await listResponse.json()) as GitHubPrShape[];
      if (Array.isArray(existing) && existing.length > 0) {
        log.info({ prNumber: existing[0]!.number }, "reusing existing PR");
        return existing[0]!;
      }
    } else if (listResponse.status !== 404) {
      const errorBody = await listResponse.text().catch(() => "");
      throw new ReviewApiError(listResponse.status, listUrl, errorBody);
    }

    // Create new PR
    const createUrl = `${this.repoApiUrl()}/pulls`;
    const createResponse = await globalThis.fetch(createUrl, {
      method: "POST",
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title, body, head, base }),
    });

    if (!createResponse.ok) {
      const errorBody = await createResponse.text().catch(() => "");
      throw new ReviewApiError(createResponse.status, createUrl, errorBody);
    }

    const pr = (await createResponse.json()) as GitHubPrShape;
    log.info({ prNumber: pr.number, prUrl: pr.html_url }, "created pull request on GitHub");
    return pr;
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }
}

interface GitHubPrShape {
  number: number;
  html_url: string;
  state: string;
  merged?: boolean;
}

/** Convenience factory matching the GitLab/Gerrit naming convention. */
export function createGitHubVcsConnector(config: GitHubVcsConnectorConfig): GitHubVcsConnector {
  return new GitHubVcsConnector(config);
}
