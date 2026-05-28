import { z } from "zod";
import type {
  ReviewProvider,
  ReviewChangeDetails,
  ReviewChangeDiff,
  ReviewDiffFile,
  ReviewFileStatus,
  InlineReviewComment,
  ExternalChangeId,
} from "../interfaces.js";
import { getLogger } from "../logger.js";

const log = getLogger("github-pr-review-provider");

const GitHubPrSchema = z.object({
  number: z.number(),
  state: z.string(),
  title: z.string(),
  body: z.string().nullable().optional(),
  html_url: z.string(),
  merged: z.boolean().optional().default(false),
  user: z.object({ login: z.string(), id: z.number() }).nullable().optional(),
  base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
  head: z.object({ ref: z.string(), sha: z.string() }),
});

const GitHubPrFileSchema = z.object({
  filename: z.string(),
  status: z.string(),
  patch: z.string().optional().default(""),
});
const GitHubPrFileListSchema = z.array(GitHubPrFileSchema);

export interface GitHubReviewProviderConfig {
  apiBaseUrl: string;
  owner: string;
  /** Optional default repo, used when changeId has no `repo#` prefix (legacy single-repo integration). */
  repo?: string;
  token: string;
}

export class GitHubReviewProvider implements ReviewProvider {
  public readonly kind = "github";

  constructor(private readonly config: GitHubReviewProviderConfig) {}

  /**
   * Parse a GitHub changeId. Supported formats:
   *  - `"repo#42"`  multi-repo per owner (preferred; emitted by webhook handler)
   *  - `"42"`       legacy single-repo (falls back to constructor `repo`)
   */
  private parseChangeId(changeId: ExternalChangeId): { repo: string; prNumber: number } {
    const raw = String(changeId);
    const hashIdx = raw.indexOf("#");
    if (hashIdx > 0) {
      const repo = raw.slice(0, hashIdx);
      const n = parseInt(raw.slice(hashIdx + 1), 10);
      if (!repo || isNaN(n) || n <= 0) {
        throw new Error(`Invalid GitHub changeId: "${raw}" — expected "repo#number"`);
      }
      return { repo, prNumber: n };
    }
    const n = parseInt(raw, 10);
    if (isNaN(n) || n <= 0) {
      throw new Error(`Invalid GitHub PR number: "${raw}"`);
    }
    if (!this.config.repo) {
      throw new Error(
        `GitHub changeId "${raw}" has no repo prefix and no default repo is configured on the provider`,
      );
    }
    return { repo: this.config.repo, prNumber: n };
  }

  async getChangeDetails(changeId: ExternalChangeId): Promise<ReviewChangeDetails> {
    const { repo, prNumber } = this.parseChangeId(changeId);
    const pr = GitHubPrSchema.parse(await this.fetchJson(this.prUrl(repo, prNumber)));

    const status: ReviewChangeDetails["status"] = pr.merged
      ? "MERGED"
      : pr.state === "closed"
        ? "ABANDONED"
        : "OPEN";

    return {
      changeId,
      changeNumber: pr.number,
      subject: pr.title,
      description: (pr.body ?? "").trim(),
      ownerAccountId: pr.user ? String(pr.user.id) : "",
      currentPatchset: 1,
      status,
      project: pr.base.repo.full_name,
      targetBranch: pr.base.ref,
      url: pr.html_url,
    };
  }

  async getChangeDiff(changeId: ExternalChangeId, _patchset?: number): Promise<ReviewChangeDiff> {
    const { repo, prNumber } = this.parseChangeId(changeId);
    const files = GitHubPrFileListSchema.parse(
      await this.fetchJson(`${this.prUrl(repo, prNumber)}/files?per_page=300`)
    );

    return {
      changeId,
      patchset: 1,
      files: files.map((f): ReviewDiffFile => ({
        path: f.filename,
        status: mapFileStatus(f.status),
        patch: f.patch,
      })),
    };
  }

  async postReviewComments(
    changeId: ExternalChangeId,
    _revision: number,
    comments: InlineReviewComment[],
    summary: string
  ): Promise<void> {
    await this.submitReview(changeId, comments, summary, "COMMENT");
  }

  async postReviewWithComments(
    changeId: ExternalChangeId,
    _revision: number,
    comments: InlineReviewComment[],
    summary: string,
    score: -1 | 1
  ): Promise<void> {
    await this.submitReview(changeId, comments, summary, score === -1 ? "REQUEST_CHANGES" : "APPROVE");
  }

  async vote(
    changeId: ExternalChangeId,
    _revision: number,
    score: number,
    message?: string
  ): Promise<void> {
    const event = score < 0 ? "REQUEST_CHANGES" : score > 0 ? "APPROVE" : "COMMENT";
    await this.submitReview(changeId, [], message ?? "", event);
  }

  private async submitReview(
    changeId: ExternalChangeId,
    comments: InlineReviewComment[],
    summary: string,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
  ): Promise<void> {
    const { repo, prNumber } = this.parseChangeId(changeId);

    const apiComments = comments
      .filter((c) => c.line > 0)
      .map((c) => ({ path: c.file, line: c.line, body: c.message, side: "RIGHT" as const }));

    const body = {
      event,
      body: summary,
      ...(apiComments.length > 0 ? { comments: apiComments } : {}),
    };

    await this.fetchJson(`${this.prUrl(repo, prNumber)}/reviews`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    log.info({ repo, prNumber, event, inlineCount: apiComments.length }, "posted GitHub PR review");
  }

  private prUrl(repo: string, prNumber: number): string {
    return `${this.config.apiBaseUrl}/repos/${this.config.owner}/${repo}/pulls/${prNumber}`;
  }

  private async fetchJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
    const response = await globalThis.fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`GitHub API ${response.status} ${url}: ${text.slice(0, 500)}`);
    }
    return response.json() as Promise<T>;
  }
}

function mapFileStatus(status: string): ReviewFileStatus {
  switch (status) {
    case "added": return "added";
    case "removed": return "deleted";
    case "renamed": return "renamed";
    default: return "modified";
  }
}
