import { execFile } from "child_process";
import { promisify } from "util";
import { getLogger } from "../logger.js";

const execFileAsync = promisify(execFile);
const log = getLogger("github-vcs-connector");

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GitHubVcsConnectorConfig {
  apiBaseUrl: string;
  host: string;
  owner: string;
  repo: string;
  token: string;
}

export interface VcsConnector {
  pushBranch(localRepoPath: string, branchName: string): Promise<void>;
  createPullRequest(params: {
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<{ url: string; number: number }>;
  requestReview(prNumber: number, reviewers: string[]): Promise<void>;
  closePullRequest(prNumber: number): Promise<void>;
}

// ─── Connector implementation ─────────────────────────────────────────────────

export class GitHubVcsConnector implements VcsConnector {
  constructor(private readonly config: GitHubVcsConnectorConfig) {}

  async pushBranch(localRepoPath: string, branchName: string): Promise<void> {
    const remoteUrl = `https://x-access-token:${this.config.token}@${this.config.host}/${this.config.owner}/${this.config.repo}.git`;

    await execFileAsync("git", ["push", remoteUrl, branchName], {
      cwd: localRepoPath,
    });

    log.info({ branchName }, "pushed branch to GitHub");
  }

  async createPullRequest(params: {
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<{ url: string; number: number }> {
    const url = `${this.config.apiBaseUrl}/repos/${this.config.owner}/${this.config.repo}/pulls`;

    const response = await globalThis.fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        title: params.title,
        body: params.body,
        head: params.head,
        base: params.base,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new GitHubVcsError(response.status, url, body);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const prUrl = data["html_url"] as string;
    const prNumber = data["number"] as number;

    log.info({ prNumber, prUrl }, "created pull request on GitHub");
    return { url: prUrl, number: prNumber };
  }

  async requestReview(prNumber: number, reviewers: string[]): Promise<void> {
    const url = `${this.config.apiBaseUrl}/repos/${this.config.owner}/${this.config.repo}/pulls/${prNumber}/requested_reviewers`;

    const response = await globalThis.fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ reviewers }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new GitHubVcsError(response.status, url, body);
    }

    await response.text();
    log.info({ prNumber, reviewers }, "requested reviewers on PR");
  }

  async closePullRequest(prNumber: number): Promise<void> {
    const url = `${this.config.apiBaseUrl}/repos/${this.config.owner}/${this.config.repo}/pulls/${prNumber}`;

    const response = await globalThis.fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ state: "closed" }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new GitHubVcsError(response.status, url, body);
    }

    await response.text();
    log.info({ prNumber }, "closed pull request");
  }
}

// ─── Factory helper ───────────────────────────────────────────────────────────

export function createGitHubVcsConnector(config: GitHubVcsConnectorConfig): GitHubVcsConnector {
  return new GitHubVcsConnector(config);
}

// ─── Error ────────────────────────────────────────────────────────────────────

export class GitHubVcsError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly url: string,
    public readonly body: string
  ) {
    super(`GitHub VCS error ${statusCode} on ${url}: ${body}`);
    this.name = "GitHubVcsError";
  }
}
