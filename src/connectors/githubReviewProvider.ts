import { z } from "zod";
import type {
  ReviewProvider,
  ReviewChangeDetails,
  ReviewChangeDiff,
  ReviewDiffFile,
  ReviewDiscussionThread,
  ReviewDiscussionComment,
  ReviewFileStatus,
  InlineReviewComment,
  ExternalChangeId,
} from "../interfaces.js";
import { getLogger } from "../logger.js";
import { filterCommentsByAllowedFiles } from "../review/commentFilter.js";
import { patchsetFromRevisionSha } from "../review/revisionPatchset.js";

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

const GraphQLThreadCommentSchema = z.object({
  body: z.string().default(""),
  author: z.object({ login: z.string() }).nullable().optional(),
});
const GraphQLThreadSchema = z.object({
  id: z.string(),
  isResolved: z.boolean().optional().default(false),
  path: z.string().nullable().optional(),
  line: z.number().nullable().optional(),
  comments: z.object({ nodes: z.array(GraphQLThreadCommentSchema).default([]) }),
});
const GraphQLThreadsResponseSchema = z.object({
  repository: z
    .object({
      pullRequest: z
        .object({
          reviewThreads: z.object({
            pageInfo: z.object({
              hasNextPage: z.boolean(),
              endCursor: z.string().nullable().optional(),
            }),
            nodes: z.array(GraphQLThreadSchema).default([]),
          }),
        })
        .nullable(),
    })
    .nullable(),
});
const GraphQLViewerSchema = z.object({ viewer: z.object({ login: z.string() }) });

export interface GitHubReviewProviderConfig {
  apiBaseUrl: string;
  /** Owner (user or org) — optional; preferred source is now the `owner/repo#pr` changeId format. */
  owner?: string;
  /** Optional default repo, used when changeId has no `repo#` prefix (legacy single-repo integration). */
  repo?: string;
  token: string;
}

export class GitHubReviewProvider implements ReviewProvider {
  public readonly kind = "github";

  private currentLogin: string | null = null;

  constructor(private readonly config: GitHubReviewProviderConfig) {}

  /**
   * Parse a GitHub changeId. Supported formats:
   *  - `"owner/repo#42"`  multi-repo with owner (preferred; emitted by webhook handler)
   *  - `"repo#42"`        legacy without owner (falls back to constructor `owner`)
   *  - `"42"`             legacy single-repo (falls back to constructor `owner` + `repo`)
   */
  private parseChangeId(changeId: ExternalChangeId): { owner: string; repo: string; prNumber: number } {
    const raw = String(changeId);
    const hashIdx = raw.indexOf("#");
    if (hashIdx > 0) {
      const repoOrFull = raw.slice(0, hashIdx);
      const n = parseInt(raw.slice(hashIdx + 1), 10);
      if (!repoOrFull || isNaN(n) || n <= 0) {
        throw new Error(`Invalid GitHub changeId: "${raw}" — expected "owner/repo#number" or "repo#number"`);
      }
      const slash = repoOrFull.indexOf("/");
      if (slash > 0) {
        // New format: owner/repo#prNumber
        const owner = repoOrFull.slice(0, slash);
        const repo = repoOrFull.slice(slash + 1);
        if (!owner || !repo) throw new Error(`Invalid GitHub changeId: "${raw}"`);
        return { owner, repo, prNumber: n };
      }
      // Legacy format: repo#prNumber — fall back to static owner
      const owner = this.config.owner;
      if (!owner) {
        throw new Error(
          `GitHub changeId "${raw}" has no owner prefix and no owner is configured on the provider. ` +
          `Update to "owner/repo#${n}" format.`
        );
      }
      return { owner, repo: repoOrFull, prNumber: n };
    }
    const n = parseInt(raw, 10);
    if (isNaN(n) || n <= 0) {
      throw new Error(`Invalid GitHub PR number: "${raw}"`);
    }
    if (!this.config.owner || !this.config.repo) {
      throw new Error(
        `GitHub changeId "${raw}" has no repo prefix and no default owner/repo is configured on the provider`,
      );
    }
    return { owner: this.config.owner, repo: this.config.repo, prNumber: n };
  }

  async getChangeDetails(changeId: ExternalChangeId): Promise<ReviewChangeDetails> {
    const { owner, repo, prNumber } = this.parseChangeId(changeId);
    const pr = GitHubPrSchema.parse(await this.fetchJson(this.prUrl(owner, repo, prNumber)));

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
      // Derived from the PR head SHA so the review dedup re-reviews the PR when
      // new commits are pushed (GitHub has no monotonic patchset counter).
      currentPatchset: patchsetFromRevisionSha(pr.head.sha),
      status,
      project: pr.base.repo.full_name,
      targetBranch: pr.base.ref,
      url: pr.html_url,
    };
  }

  async getChangeDiff(changeId: ExternalChangeId, patchset?: number): Promise<ReviewChangeDiff> {
    const { owner, repo, prNumber } = this.parseChangeId(changeId);
    const files = GitHubPrFileListSchema.parse(
      await this.fetchJson(`${this.prUrl(owner, repo, prNumber)}/files?per_page=300`)
    );

    return {
      changeId,
      // Echo the requested patchset so diff.patchset stays consistent with the
      // SHA-derived currentPatchset surfaced in prompts/logs.
      patchset: patchset ?? 1,
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
    summary: string,
    allowedFiles?: ReadonlySet<string>
  ): Promise<void> {
    await this.submitReview(changeId, comments, summary, "COMMENT", allowedFiles);
  }

  async postReviewWithComments(
    changeId: ExternalChangeId,
    _revision: number,
    comments: InlineReviewComment[],
    summary: string,
    score: -1 | 1,
    allowedFiles?: ReadonlySet<string>
  ): Promise<void> {
    await this.submitReview(
      changeId,
      comments,
      summary,
      score === -1 ? "REQUEST_CHANGES" : "APPROVE",
      allowedFiles
    );
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
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    allowedFiles?: ReadonlySet<string>
  ): Promise<void> {
    const { owner, repo, prNumber } = this.parseChangeId(changeId);

    // First, drop comments for files not present in the patchset.
    const fileFilteredComments = filterCommentsByAllowedFiles(comments, allowedFiles, { repo, prNumber });
    const positiveLineComments = fileFilteredComments.filter((c) => c.line > 0);
    // File-level comments (line <= 0) cannot be anchored to a diff line; fold
    // them into the review body so the feedback is not lost.
    const fileLevelComments = fileFilteredComments.filter((c) => c.line <= 0);

    // Build a map of filename → valid new-file line numbers by fetching the PR
    // diff. GitHub's review API rejects the entire request with 422 if even one
    // inline comment targets a line that does not appear in the diff hunks.
    const validLinesByFile = new Map<string, Set<number>>();
    if (positiveLineComments.length > 0) {
      try {
        const files = GitHubPrFileListSchema.parse(
          await this.fetchJson(`${this.prUrl(owner, repo, prNumber)}/files?per_page=300`)
        );
        for (const f of files) {
          if (f.patch) {
            validLinesByFile.set(f.filename, parsePatchNewLineNumbers(f.patch));
          }
        }
      } catch (err) {
        log.warn({ repo, prNumber, err }, "failed to fetch PR files for line validation; skipping inline comments");
      }
    }

    const inlineComments: InlineReviewComment[] = [];
    const outOfDiffComments: InlineReviewComment[] = [...fileLevelComments];
    for (const c of positiveLineComments) {
      const validLines = validLinesByFile.get(c.file);
      if (validLines === undefined || validLines.has(c.line)) {
        // Include when we have no diff data (fall back to best-effort) or line is valid.
        inlineComments.push(c);
      } else {
        outOfDiffComments.push(c);
      }
    }

    // Fold out-of-diff and file-level comments into the review body so no
    // feedback is lost. File-level comments (line <= 0) render without a line.
    const foldedSection =
      outOfDiffComments.length > 0
        ? "\n\n---\n**Additional comments (lines outside diff hunk):**\n" +
          outOfDiffComments
            .map((c) =>
              c.line > 0
                ? `- \`${c.file}:${c.line}\` [${c.severity}]: ${c.message}`
                : `- \`${c.file}\` [${c.severity}]: ${c.message}`
            )
            .join("\n")
        : "";

    const apiComments = inlineComments.map((c) => ({
      path: c.file,
      line: c.line,
      body: c.message,
      side: "RIGHT" as const,
    }));

    // A bare COMMENT event with no inline comments and no summary would post a
    // visible empty review. APPROVE/REQUEST_CHANGES still post since they carry a vote.
    if (
      event === "COMMENT" &&
      apiComments.length === 0 &&
      summary.trim().length === 0 &&
      foldedSection.length === 0
    ) {
      return;
    }

    const body = {
      event,
      body: summary + foldedSection,
      ...(apiComments.length > 0 ? { comments: apiComments } : {}),
    };

    await this.fetchJson(`${this.prUrl(owner, repo, prNumber)}/reviews`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    log.info(
      { repo, prNumber, event, inlineCount: apiComments.length, foldedCount: outOfDiffComments.length },
      "posted GitHub PR review"
    );
  }

  private prUrl(owner: string, repo: string, prNumber: number): string {
    return `${this.config.apiBaseUrl}/repos/${owner}/${repo}/pulls/${prNumber}`;
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

  async getDiscussionThreads(changeId: ExternalChangeId): Promise<ReviewDiscussionThread[]> {
    const { owner, repo, prNumber } = this.parseChangeId(changeId);
    const me = await this.resolveCurrentLogin();

    const query = `
      query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
        repository(owner:$owner,name:$repo){
          pullRequest(number:$number){
            reviewThreads(first:100, after:$cursor){
              pageInfo{ hasNextPage endCursor }
              nodes{
                id
                isResolved
                path
                line
                comments(first:50){ nodes{ body author{ login } } }
              }
            }
          }
        }
      }`;

    const threads: ReviewDiscussionThread[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const data = GraphQLThreadsResponseSchema.parse(
        await this.graphql(query, { owner, repo, number: prNumber, cursor })
      );
      const reviewThreads = data.repository?.pullRequest?.reviewThreads;
      if (!reviewThreads) break;

      for (const node of reviewThreads.nodes) {
        const comments: ReviewDiscussionComment[] = node.comments.nodes.map((c) => ({
          author: c.author?.login ?? "unknown",
          message: c.body,
          isOwn: me !== null && c.author?.login === me,
        }));
        if (comments.length === 0) continue;
        threads.push({
          threadId: node.id,
          file: node.path ?? null,
          line: node.line ?? null,
          resolved: node.isResolved,
          comments,
        });
      }

      if (!reviewThreads.pageInfo.hasNextPage) break;
      cursor = reviewThreads.pageInfo.endCursor ?? null;
      if (cursor === null) break;
    }
    return threads;
  }

  async postThreadReply(
    _changeId: ExternalChangeId,
    _revision: number,
    threadId: string,
    message: string
  ): Promise<void> {
    const mutation = `
      mutation($threadId:ID!,$body:String!){
        addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId, body:$body}){
          comment{ id }
        }
      }`;
    await this.graphql(mutation, { threadId, body: message });
    log.info({ threadId }, "posted GitHub PR review thread reply");
  }

  /** Resolve and cache VE's own GitHub login (used to tag `isOwn` comments). */
  private async resolveCurrentLogin(): Promise<string | null> {
    if (this.currentLogin !== null) return this.currentLogin;
    try {
      const data = GraphQLViewerSchema.parse(await this.graphql(`query{ viewer{ login } }`, {}));
      this.currentLogin = data.viewer.login;
      return this.currentLogin;
    } catch (err) {
      log.warn({ err }, "failed to resolve GitHub viewer login; isOwn tagging disabled");
      return null;
    }
  }

  /** Derive the GraphQL endpoint from the REST API base URL. */
  private graphqlEndpoint(): string {
    const base = this.config.apiBaseUrl.replace(/\/+$/, "");
    if (base.endsWith("/api/v3")) return `${base.slice(0, -"/api/v3".length)}/api/graphql`;
    if (base === "https://api.github.com") return "https://api.github.com/graphql";
    return `${base}/graphql`;
  }

  private async graphql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await globalThis.fetch(this.graphqlEndpoint(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`GitHub GraphQL ${response.status}: ${text.slice(0, 500)}`);
    }
    const json = (await response.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };
    if (json.errors && json.errors.length > 0) {
      throw new Error(`GitHub GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
    }
    if (json.data === undefined) {
      throw new Error("GitHub GraphQL response missing data");
    }
    return json.data;
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

/**
 * Parse a unified diff patch and return the set of new-file line numbers that
 * appear in the diff hunks. Only these lines can be targeted by GitHub's review
 * inline comment API (using the `line` + `side: "RIGHT"` parameters).
 *
 * Lines prefixed with `+` (added) and ` ` (context) are valid new-file lines.
 * Lines prefixed with `-` (removed) have no new-file line number.
 */
export function parsePatchNewLineNumbers(patch: string): Set<number> {
  const validLines = new Set<number>();
  let newLineNo = 0;
  for (const line of patch.split("\n")) {
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLineNo = parseInt(hunkMatch[1]!, 10) - 1;
      continue;
    }
    // Skip "\ No newline at end of file" markers and empty lines
    if (line.startsWith("\\") || line === "") continue;
    // Removed lines have no position on the new-file side
    if (line.startsWith("-")) continue;
    // Context lines (start with " ") and added lines (start with "+")
    if (line.startsWith(" ") || line.startsWith("+")) {
      newLineNo++;
      validLines.add(newLineNo);
    }
  }
  return validLines;
}
