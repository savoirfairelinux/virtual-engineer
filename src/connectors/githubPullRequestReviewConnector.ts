import { z } from "zod";
import type {
  GerritConnector,
  GerritChangeRef,
  GerritChangeStatus,
  GerritComment,
  GerritChangeId,
} from "../interfaces.js";
import { getLogger } from "../logger.js";

const log = getLogger("github-pr-review-connector");

// ─── Zod schemas for GitHub PR / Review API responses ─────────────────────────

const GitHubPrSchema = z.object({
  number: z.number(),
  state: z.string(),
  html_url: z.string(),
  title: z.string(),
  head: z.object({ ref: z.string() }),
  merged: z.boolean().optional().default(false),
});

const GitHubReviewCommentSchema = z.object({
  id: z.number(),
  user: z.object({ login: z.string() }),
  body: z.string(),
  path: z.string().optional(),
  line: z.number().nullable().optional(),
  updated_at: z.string(),
  node_id: z.string(),
  in_reply_to_id: z.number().optional(),
});

const GitHubIssueCommentSchema = z.object({
  id: z.number(),
  user: z.object({ login: z.string() }),
  body: z.string(),
  updated_at: z.string(),
  node_id: z.string(),
});

const GitHubReviewCommentListSchema = z.array(GitHubReviewCommentSchema);
const GitHubIssueCommentListSchema = z.array(GitHubIssueCommentSchema);

// ─── Config ───────────────────────────────────────────────────────────────────

export interface GitHubPullRequestReviewConnectorConfig {
  apiBaseUrl: string;
  owner: string;
  repo: string;
  token: string;
  virtualEngineerUserLogin?: string | undefined;
}

// ─── Connector implementation ─────────────────────────────────────────────────

/**
 * GitHubPullRequestReviewConnector — implements GerritConnector interface
 * against GitHub Pull Requests.
 *
 * changeId convention: the PR number stored as a string, e.g. "42".
 */
export class GitHubPullRequestReviewConnector implements GerritConnector {
  private readonly threadIdCache = new Map<number, string>();

  constructor(private readonly config: GitHubPullRequestReviewConnectorConfig) {}

  async getChange(changeId: GerritChangeId): Promise<GerritChangeRef> {
    const prNumber = this.parsePrNumber(String(changeId));
    const pr = GitHubPrSchema.parse(await this.fetchJson(this.prUrl(prNumber)));

    return {
      changeId,
      changeNumber: pr.number,
      patchsetNumber: 1,
      url: pr.html_url,
    };
  }

  async getChangeStatus(changeId: GerritChangeId): Promise<GerritChangeStatus> {
    const prNumber = this.parsePrNumber(String(changeId));
    const pr = GitHubPrSchema.parse(await this.fetchJson(this.prUrl(prNumber)));

    if (pr.merged) return "MERGED";
    if (pr.state === "closed") return "ABANDONED";
    return "OPEN";
  }

  async getUnresolvedComments(
    changeId: GerritChangeId,
    _sincePatchset?: number
  ): Promise<GerritComment[]> {
    const prNumber = this.parsePrNumber(String(changeId));
    const baseUrl = `${this.config.apiBaseUrl}/repos/${this.config.owner}/${this.config.repo}`;

    // Fetch review comments (inline) and issue comments (general)
    const [reviewComments, issueComments] = await Promise.all([
      this.fetchJson<z.infer<typeof GitHubReviewCommentListSchema>>(
        `${baseUrl}/pulls/${prNumber}/comments?per_page=100`
      ).then((data) => GitHubReviewCommentListSchema.parse(data)),
      this.fetchJson<z.infer<typeof GitHubIssueCommentListSchema>>(
        `${baseUrl}/issues/${prNumber}/comments?per_page=100`
      ).then((data) => GitHubIssueCommentListSchema.parse(data)),
    ]);

    const comments: GerritComment[] = [];

    // Filter inline review comments: skip those authored by VE
    for (const rc of reviewComments) {
      if (rc.user.login === this.config.virtualEngineerUserLogin) continue;
      // Only include top-level comments (not replies) as "unresolved"
      if (rc.in_reply_to_id) continue;

      comments.push({
        id: String(rc.id),
        author: rc.user.login,
        message: rc.body,
        filePath: rc.path,
        line: rc.line ?? undefined,
        unresolved: true,
        patchset: 0,
        updatedAt: new Date(rc.updated_at),
      });
    }

    // General issue comments — skip VE's own
    for (const ic of issueComments) {
      if (ic.user.login === this.config.virtualEngineerUserLogin) continue;

      comments.push({
        id: `issue-${ic.id}`,
        author: ic.user.login,
        message: ic.body,
        filePath: undefined,
        line: undefined,
        unresolved: true,
        patchset: 0,
        updatedAt: new Date(ic.updated_at),
      });
    }

    log.debug({ changeId, count: comments.length }, "fetched GitHub PR comments");
    return comments;
  }

  async addChangeComment(changeId: GerritChangeId, message: string): Promise<void> {
    const prNumber = this.parsePrNumber(String(changeId));
    await this.fetchJsonVoid(
      `${this.config.apiBaseUrl}/repos/${this.config.owner}/${this.config.repo}/issues/${prNumber}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: message }),
      }
    );
    log.info({ changeId }, "added comment to GitHub PR");
  }

  async resolveComments(changeId: GerritChangeId, comments: GerritComment[]): Promise<void> {
    if (comments.length === 0) return;

    const prNumber = this.parsePrNumber(String(changeId));

    for (const comment of comments) {
      const commentId = parseInt(comment.id, 10);
      if (isNaN(commentId)) continue;

      const threadId = await this.getReviewThreadIdForComment(prNumber, commentId);
      if (threadId) {
        await this.markReviewThreadResolved(threadId);
      }
    }

    log.info({ changeId, count: comments.length }, "resolved GitHub PR review threads");
  }

  // ─── Public review-specific methods ─────────────────────────────────────────

  async postReviewReply(prNumber: number, parentCommentId: number, body: string): Promise<void> {
    await this.fetchJsonVoid(
      `${this.config.apiBaseUrl}/repos/${this.config.owner}/${this.config.repo}/pulls/${prNumber}/comments/${parentCommentId}/replies`,
      {
        method: "POST",
        body: JSON.stringify({ body }),
      }
    );
    log.info({ prNumber, parentCommentId }, "posted review reply");
  }

  async getReviewThreadIdForComment(prNumber: number, commentId: number): Promise<string | undefined> {
    if (this.threadIdCache.has(commentId)) {
      return this.threadIdCache.get(commentId);
    }

    // Use GraphQL to map REST comment ID to thread node ID
    const query = `
      query($owner: String!, $repo: String!, $prNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $prNumber) {
            reviewThreads(first: 100) {
              nodes {
                id
                comments(first: 100) {
                  nodes {
                    databaseId
                  }
                }
              }
            }
          }
        }
      }
    `;

    const graphqlUrl = this.config.apiBaseUrl.replace(/\/api\/v3$/, "/api/graphql")
      .replace(/^https:\/\/api\.github\.com$/, "https://api.github.com/graphql");

    const response = await globalThis.fetch(graphqlUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: {
          owner: this.config.owner,
          repo: this.config.repo,
          prNumber,
        },
      }),
    });

    if (!response.ok) return undefined;

    const result = (await response.json()) as Record<string, unknown>;
    const data = result["data"] as Record<string, unknown> | undefined;
    if (!data) return undefined;

    const repository = data["repository"] as Record<string, unknown> | undefined;
    const pullRequest = repository?.["pullRequest"] as Record<string, unknown> | undefined;
    const reviewThreads = pullRequest?.["reviewThreads"] as Record<string, unknown> | undefined;
    const nodes = reviewThreads?.["nodes"] as Array<Record<string, unknown>> | undefined;

    if (!nodes) return undefined;

    // Cache all thread mappings
    for (const thread of nodes) {
      const threadId = thread["id"] as string;
      const commentsNode = thread["comments"] as Record<string, unknown>;
      const commentNodes = commentsNode?.["nodes"] as Array<Record<string, unknown>> | undefined;
      if (!commentNodes) continue;

      for (const c of commentNodes) {
        const dbId = c["databaseId"] as number;
        this.threadIdCache.set(dbId, threadId);
      }
    }

    return this.threadIdCache.get(commentId);
  }

  async markReviewThreadResolved(threadId: string): Promise<void> {
    const mutation = `
      mutation($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) {
          thread { id }
        }
      }
    `;

    const graphqlUrl = this.config.apiBaseUrl.replace(/\/api\/v3$/, "/api/graphql")
      .replace(/^https:\/\/api\.github\.com$/, "https://api.github.com/graphql");

    const response = await globalThis.fetch(graphqlUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: mutation,
        variables: { threadId },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new GitHubPrApiError(response.status, "GraphQL resolveReviewThread", body);
    }

    log.debug({ threadId }, "resolved review thread via GraphQL");
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private prUrl(prNumber: number): string {
    return `${this.config.apiBaseUrl}/repos/${this.config.owner}/${this.config.repo}/pulls/${prNumber}`;
  }

  private parsePrNumber(changeId: string): number {
    const n = parseInt(changeId, 10);
    if (isNaN(n) || n <= 0) {
      throw new Error(`Invalid GitHub PR number: "${changeId}"`);
    }
    return n;
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
      const body = await response.text().catch(() => "");
      throw new GitHubPrApiError(response.status, url, body);
    }

    return response.json() as Promise<T>;
  }

  private async fetchJsonVoid(url: string, init?: RequestInit): Promise<void> {
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
      const body = await response.text().catch(() => "");
      throw new GitHubPrApiError(response.status, url, body);
    }

    await response.text();
  }
}

export class GitHubPrApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly url: string,
    public readonly body: string
  ) {
    super(`GitHub PR API error ${statusCode} on ${url}: ${body}`);
    this.name = "GitHubPrApiError";
  }
}
