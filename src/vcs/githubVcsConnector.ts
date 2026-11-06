/**
 * GitHubVcsConnector — HTTP-based clone and push for GitHub.
 *
 * Clone uses token in the remote URL; push creates or updates a pull request
 * via the GitHub REST API. Mirrors the design of GitLabVcsConnector — VE pushes
 * a feature branch, the orchestrator looks up the URL via the PR REST endpoint.
 */

import { getLogger } from "../logger.js";
import type { ExistingReview, VcsConnector, VcsPushResult } from "./vcsConnector.js";
import { buildFeatureBranchRef } from "./branchNaming.js";
import { ReviewApiError } from "../interfaces.js";
import { redactUrls, sanitizeErrorDetail } from "../utils/redactUrl.js";
import type { GitRunner } from "./gitRunner.js";
import { NodeGitRunner } from "./nodeGitRunner.js";
import { validateHttpsCloneUrl } from "./cloneUrlValidation.js";
import { isSameRepository } from "../domain/identifiers.js";
import { z } from "zod";

const log = getLogger("github-vcs");
const branchPullRequestsSchema = z.array(z.object({
  number: z.number().int().positive(),
  html_url: z.url(),
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullable(),
  head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
}));

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

  constructor(
    private readonly config: GitHubVcsConnectorConfig,
    private readonly gitRunner: GitRunner = new NodeGitRunner()
  ) {}

  buildPushSpec(_baseBranch: string, taskId: string, ticketTitle?: string | null): { ref: string; topic?: string } {
    return { ref: buildFeatureBranchRef(taskId, ticketTitle ?? null) };
  }

  /** Clone a GitHub repository via HTTPS into the target directory. */
  async clone(repoUrl: string, branch: string, targetDir: string): Promise<void> {
    validateHttpsCloneUrl(repoUrl, this.config.host, "GitHub");
    log.info(
      { repoUrl: redactUrls(repoUrl), branch, targetDir },
      "cloning repository from GitHub via HTTPS"
    );

    try {
      await this.gitRunner.run(
        ["clone", "--branch", branch, "--depth", "1", "--", repoUrl, targetDir],
        { cwd: process.cwd(), timeoutMs: 300_000 }
      );
      log.info({ targetDir }, "repository cloned successfully");
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(
        `Failed to clone ${sanitizeErrorDetail(repoUrl, 1000)}: ${sanitizeErrorDetail(error.message)}`
      );
    }
  }

  /**
   * Push HEAD directly without creating a new commit on the host.
   * Used when the agent has already committed inside the container.
   */
  async pushDirect(
    repoDir: string,
    ref: string,
    _topic?: string
  ): Promise<VcsPushResult> {
    const remoteUrl = (
      await this.gitRunner.run(["remote", "get-url", "origin"], { cwd: repoDir })
    ).stdout.trim();
    const authenticatedUrl = new URL(remoteUrl);
    authenticatedUrl.username = "x-access-token";
    authenticatedUrl.password = this.config.token;
    await this.gitRunner.run(
      ["remote", "set-url", "origin", authenticatedUrl.toString()],
      { cwd: repoDir }
    );

    try {
      await this.gitRunner.run(
        ["push", "-u", "--force-with-lease", "origin", `HEAD:refs/heads/${ref}`],
        { cwd: repoDir, timeoutMs: 300_000 }
      );
    } finally {
      await this.gitRunner.run(["remote", "set-url", "origin", remoteUrl], { cwd: repoDir });
    }

    const subject = (
      await this.gitRunner.run(["log", "-1", "--pretty=%s"], { cwd: repoDir })
    ).stdout.trim();
    const body = (
      await this.gitRunner.run(["log", "-1", "--pretty=%b"], { cwd: repoDir })
    ).stdout.trim();
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

  async findExistingReview(sourceBranch: string): Promise<ExistingReview | null> {
    const repoSlug = `${this.config.owner}/${this.config.repo}`;
    const url = `${this.repoApiUrl()}/pulls?state=all&head=${encodeURIComponent(
      `${this.config.owner}:${sourceBranch}`,
    )}&per_page=2`;
    const response = await globalThis.fetch(url, { headers: this.authHeaders() });
    if (!response.ok) {
      throw new ReviewApiError(response.status, url, await response.text().catch(() => ""));
    }
    const prs = branchPullRequestsSchema.parse(await response.json());
    if (prs.length > 1) throw new Error("Ambiguous pull requests from the pushed branch across target branches");
    const pr = prs[0];
    if (!pr) return null;
    // Owner/repository names are case-insensitive on GitHub; Git branch names are not.
    if (pr.head.ref !== sourceBranch || pr.head.repo === null
      || !isSameRepository(pr.head.repo.full_name, repoSlug) || !isSameRepository(pr.base.repo.full_name, repoSlug)) {
      throw new Error("Pull request does not match the bound repository and source branch");
    }
    return {
      changeId: String(pr.number),
      url: pr.html_url,
      status: pr.state === "open" ? "OPEN" : pr.merged_at !== null ? "MERGED" : "ABANDONED",
      targetBranch: pr.base.ref,
    };
  }

  // PR review comments and their resolution are read through the
  // repository-bound GitHubPullRequestReviewConnector, so this connector does
  // not implement the optional comment methods.

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
