import { z } from "zod";
import type {
  ReviewConnector,
  ReviewChangeRef,
  ReviewChangeStatus,
  ReviewComment,
  ExternalChangeId,
  ReviewDiscoveryConnector,
  ReviewAssignmentDiscovery,
} from "../interfaces.js";
import { getLogger } from "../logger.js";

const log = getLogger("github-pr-review-connector");

// ─── Zod schemas for GitHub PR / Review API responses ─────────────────────────

const GitHubPrSchema = z.object({
  number: z.number(),
  state: z.string(),
  html_url: z.string(),
  title: z.string(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  merged: z.boolean().optional().default(false),
});

const CheckRunSchema = z.object({
  id: z.number(),
  name: z.string(),
  conclusion: z.string().nullable().optional(),
  status: z.string(),
  html_url: z.string().optional(),
  completed_at: z.string().nullable().optional(),
  started_at: z.string().nullable().optional(),
  output: z.object({
    title: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
  }).optional(),
});
const CheckRunListResponseSchema = z.object({
  check_runs: z.array(CheckRunSchema),
});

const CheckAnnotationSchema = z.object({
  path: z.string(),
  start_line: z.number(),
  annotation_level: z.string(),
  message: z.string(),
  title: z.string().nullable().optional(),
});
const CheckAnnotationListSchema = z.array(CheckAnnotationSchema);

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

// Schema for GET /pulls/{n}/reviews — used to detect CHANGES_REQUESTED state
const GitHubPrReviewSchema = z.object({
  state: z.string(),
  user: z.object({ login: z.string() }),
});
const GitHubPrReviewListSchema = z.array(GitHubPrReviewSchema);

// Schema for GET /repos/{owner}/{repo}/pulls?state=open — used for review discovery
const GitHubPrListItemSchema = z.object({
  number: z.number(),
  title: z.string(),
  html_url: z.string(),
  state: z.string(),
  requested_reviewers: z.array(z.object({ login: z.string() })),
});
const GitHubPrListSchema = z.array(GitHubPrListItemSchema);

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
 * GitHubPullRequestReviewConnector — implements the ReviewConnector interface
 * against GitHub Pull Requests.
 *
 * changeId convention: the PR number stored as a string, e.g. "42".
 */
export class GitHubPullRequestReviewConnector implements ReviewConnector, ReviewDiscoveryConnector {
  private readonly threadIdCache = new Map<number, string>();

  constructor(private readonly config: GitHubPullRequestReviewConnectorConfig) {}

  async getChange(changeId: ExternalChangeId): Promise<ReviewChangeRef> {
    const prNumber = this.parsePrNumber(String(changeId));
    const pr = GitHubPrSchema.parse(await this.fetchJson(this.prUrl(prNumber)));

    return {
      changeId,
      changeNumber: pr.number,
      patchsetNumber: 1,
      url: pr.html_url,
    };
  }

  async getChangeStatus(changeId: ExternalChangeId): Promise<ReviewChangeStatus> {
    const prNumber = this.parsePrNumber(String(changeId));
    const pr = GitHubPrSchema.parse(await this.fetchJson(this.prUrl(prNumber)));

    if (pr.merged) return "MERGED";
    if (pr.state === "closed") return "ABANDONED";
    return "OPEN";
  }

  async getUnresolvedComments(
    changeId: ExternalChangeId,
    _sincePatchset?: number
  ): Promise<ReviewComment[]> {
    const prNumber = this.parsePrNumber(String(changeId));
    const baseUrl = `${this.config.apiBaseUrl}/repos/${this.config.owner}/${this.config.repo}`;

    // Only process feedback when a reviewer has explicitly requested changes.
    // Plain comments and "LGTM" reviews do not trigger a retry cycle.
    const reviews = GitHubPrReviewListSchema.parse(
      await this.fetchJson(`${baseUrl}/pulls/${prNumber}/reviews`)
    );
    const veLogin = this.config.virtualEngineerUserLogin;
    const hasChangesRequested = reviews.some(
      (r) => r.state === "CHANGES_REQUESTED" && (veLogin === undefined || r.user.login !== veLogin)
    );
    if (!hasChangesRequested) {
      log.debug({ changeId }, "no CHANGES_REQUESTED review — skipping feedback");
      return [];
    }

    // Fetch review comments (inline) and issue comments (general) — paginated
    const PER_PAGE = 100;
    const MAX_PAGES = 5;
    const fetchAllPages = async <T>(buildUrl: (page: number) => string, schema: z.ZodType<T[]>): Promise<T[]> => {
      const all: T[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const batch = schema.parse(await this.fetchJson(buildUrl(page)));
        all.push(...batch);
        if (batch.length < PER_PAGE) break;
      }
      return all;
    };
    const [reviewComments, issueComments] = await Promise.all([
      fetchAllPages(
        (p) => `${baseUrl}/pulls/${prNumber}/comments?per_page=${PER_PAGE}&page=${p}`,
        GitHubReviewCommentListSchema
      ),
      fetchAllPages(
        (p) => `${baseUrl}/issues/${prNumber}/comments?per_page=${PER_PAGE}&page=${p}`,
        GitHubIssueCommentListSchema
      ),
    ]);

    const comments: ReviewComment[] = [];

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

    log.info({ changeId, count: comments.length }, "fetched GitHub PR comments");
    return comments;
  }

  async addChangeComment(changeId: ExternalChangeId, message: string): Promise<void> {
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

  async resolveComments(changeId: ExternalChangeId, comments: ReviewComment[]): Promise<void> {
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

  // ─── CI check failures ──────────────────────────────────────────────────────

  /**
   * Fetches failed GitHub Actions check runs for the PR's head commit and returns
   * them as ReviewComment objects. Comment IDs use the stable `"ci-run-{runId}"`
   * prefix so the feedback pipeline deduplicates them across poll ticks.
   *
   * For each failed run the comment body includes:
   *  - run name + conclusion
   *  - output title + summary (truncated to 2 000 chars)
   *  - up to 20 per-file annotations (path:line + message)
   */
  async getCICheckFailures(changeId: ExternalChangeId): Promise<ReviewComment[]> {
    const prNumber = this.parsePrNumber(String(changeId));
    const baseUrl = `${this.config.apiBaseUrl}/repos/${this.config.owner}/${this.config.repo}`;

    // Resolve head SHA
    const pr = GitHubPrSchema.parse(await this.fetchJson(this.prUrl(prNumber)));
    const sha = pr.head.sha;

    // Fetch all check runs for this commit
    let failedRuns: z.infer<typeof CheckRunSchema>[];
    try {
      const data = CheckRunListResponseSchema.parse(
        await this.fetchJson(`${baseUrl}/commits/${sha}/check-runs?per_page=100`)
      );
      const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "action_required"]);
      failedRuns = data.check_runs.filter(
        (r) => r.status === "completed" && r.conclusion != null && FAILURE_CONCLUSIONS.has(r.conclusion)
      );
    } catch (err) {
      log.warn({ changeId, err }, "getCICheckFailures: failed to fetch check runs");
      return [];
    }

    const results: ReviewComment[] = [];

    for (const run of failedRuns.slice(0, 5)) {
      // Fetch annotations (per-file errors) — non-fatal if unavailable
      let annotationLines = "";
      try {
        const annotations = CheckAnnotationListSchema.parse(
          await this.fetchJson(`${baseUrl}/check-runs/${run.id}/annotations?per_page=50`)
        );
        if (annotations.length > 0) {
          annotationLines =
            "\n\nAnnotations:\n" +
            annotations
              .slice(0, 20)
              .map((a) => `  ${a.path}:${a.start_line} [${a.annotation_level}] ${a.title ?? a.message}`)
              .join("\n");
        }
      } catch (annotationErr) {
        log.debug({ changeId, runId: run.id, err: annotationErr }, "could not fetch CI annotations (non-fatal)");
      }

      const outputParts: string[] = [];
      const title = run.output?.title;
      const summary = run.output?.summary;
      const text = run.output?.text;
      if (title) outputParts.push(title);
      if (summary) outputParts.push(summary.slice(0, 2000));
      if (text && !summary) outputParts.push(text.slice(0, 2000));

      const outputText = outputParts.length > 0 ? `\n${outputParts.join("\n")}` : "";
      const message =
        `CI check "${run.name}" failed (${run.conclusion ?? "unknown"}).${outputText}${annotationLines}`.trim();

      const completedAt = run.completed_at ?? run.started_at;
      results.push({
        id: `ci-run-${run.id}`,
        author: "github-actions[bot]",
        message,
        filePath: undefined,
        line: undefined,
        unresolved: true,
        patchset: 0,
        updatedAt: completedAt ? new Date(completedAt) : new Date(),
      });
    }

    log.info({ changeId, failedCount: failedRuns.length, reported: results.length }, "fetched CI check failures");
    return results;
  }

  // ─── Review discovery ────────────────────────────────────────────────────────

  /**
   * Returns all open PRs across `repos` where VE has been added as a requested
   * reviewer. The connector's configured `owner`/`repo` are ignored here —
   * each repo key is parsed from the `"owner/repo"` strings passed in.
   */
  async getOpenReviewAssignments(repos: string[]): Promise<ReviewAssignmentDiscovery[]> {
    const veLogin = await this.resolveLogin();
    const results: ReviewAssignmentDiscovery[] = [];

    for (const repoKey of repos) {
      const slash = repoKey.indexOf("/");
      if (slash <= 0) {
        log.warn({ repoKey }, "getOpenReviewAssignments: invalid repo key, expected owner/repo");
        continue;
      }
      const owner = repoKey.slice(0, slash);
      const repo = repoKey.slice(slash + 1);

      let prs: z.infer<typeof GitHubPrListSchema> = [];
      try {
        const PER_PAGE = 100;
        const MAX_PAGES = 5; // Cap at 500 PRs per repo
        let page = 1;
        let batch: z.infer<typeof GitHubPrListSchema>;
        do {
          batch = GitHubPrListSchema.parse(
            await this.fetchJson(
              `${this.config.apiBaseUrl}/repos/${owner}/${repo}/pulls?state=open&per_page=${PER_PAGE}&page=${page}`
            )
          );
          prs = prs.concat(batch);
          page += 1;
        } while (batch.length === PER_PAGE && page <= MAX_PAGES);
      } catch (err) {
        log.warn({ repoKey, err }, "getOpenReviewAssignments: failed to fetch PRs");
        continue;
      }

      for (const pr of prs) {
        if (!pr.requested_reviewers.some((r) => r.login === veLogin)) continue;
        results.push({
          changeId: `${repoKey}#${pr.number}`,
          project: repoKey,
          subject: pr.title,
        });
      }
    }

    log.debug({ repos: repos.length, found: results.length }, "review assignment poll complete");
    return results;
  }

  /** Resolve VE's GitHub login: uses configured value or fetches from GET /user once. */
  private loginPromise: Promise<string> | undefined;
  private async resolveLogin(): Promise<string> {
    if (this.config.virtualEngineerUserLogin) return this.config.virtualEngineerUserLogin;
    this.loginPromise ??= this.fetchJson<{ login: string }>(`${this.config.apiBaseUrl}/user`)
      .then((user) => {
        if (typeof user.login !== "string" || !user.login) {
          throw new Error("GitHub /user response missing expected 'login' field");
        }
        return user.login;
      });
    return this.loginPromise;
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
