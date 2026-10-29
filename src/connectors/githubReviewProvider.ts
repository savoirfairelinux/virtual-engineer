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
  ReviewOverviewPublication,
  ReviewOverviewPublicationResult,
  PublishedReviewFinding,
} from "../interfaces.js";
import { getLogger } from "../logger.js";
import { filterCommentsByAllowedFiles } from "../review/commentFilter.js";
import { renderReviewOverview } from "../review/reviewOverview.js";
import { patchsetFromRevisionSha } from "../review/revisionPatchset.js";
import { sanitizeErrorDetail } from "../utils/redactUrl.js";

const log = getLogger("github-pr-review-provider");

const PENDING_REVIEW_PLACEHOLDER_BODY = "Virtual Engineer review in progress.";

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
  patch: z.string().optional(),
  changes: z.number().int().nonnegative().optional(),
});
const GitHubPrFileListSchema = z.array(GitHubPrFileSchema);
const GitHubPendingReviewSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const GitHubPendingCommentListSchema = z.array(z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  html_url: z.string(),
  path: z.string(),
  // The review comments endpoint does not return `line` for pending reviews.
  line: z.number().int().positive().nullable().optional(),
  body: z.string(),
}));

const GitHubPrCommitListSchema = z.array(z.object({ sha: z.string() }));
const GitHubCompareResponseSchema = z.object({
  files: z.array(z.object({
    filename: z.string(),
    status: z.string(),
    patch: z.string().nullable().optional(),
    changes: z.number().int().nonnegative().optional(),
  })).default([]),
});

const GitHubReviewListSchema = z.array(
  z.object({
    user: z.object({ login: z.string() }).nullable().optional(),
    state: z.string(),
    commit_id: z.string().nullable().optional(),
  })
);
const GitHubRequestedReviewersSchema = z.object({
  users: z.array(z.object({ login: z.string() })).default([]),
  teams: z.array(z.object({ slug: z.string() })).default([]),
});
const SUBMITTED_REVIEW_STATES = new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
]);

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
  /** Optional login used for reviewer assignment; otherwise resolved from `/user`. */
  virtualEngineerUserLogin?: string | undefined;
}

export class GitHubReviewProvider implements ReviewProvider {
  public readonly kind = "github";

  private currentLogin: string | null = null;
  private reviewerLoginPromise: Promise<string> | undefined;

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

  async getChangeDetails(changeId: ExternalChangeId, signal?: AbortSignal): Promise<ReviewChangeDetails> {
    const { owner, repo, prNumber } = this.parseChangeId(changeId);
    const pr = GitHubPrSchema.parse(await this.fetchJson(
      this.prUrl(owner, repo, prNumber),
      signal !== undefined ? { signal } : undefined,
    ));

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
      headSha: pr.head.sha,
      status,
      project: pr.base.repo.full_name,
      targetBranch: pr.base.ref,
      url: pr.html_url,
    };
  }

  async isReviewer(changeId: ExternalChangeId, signal?: AbortSignal): Promise<boolean> {
    const { owner, repo, prNumber } = this.parseChangeId(changeId);
    const pr = GitHubPrSchema.parse(await this.fetchJson(this.prUrl(owner, repo, prNumber), signal !== undefined ? { signal } : undefined));
    const login = await this.resolveReviewerLogin(signal);
    if (pr.merged || pr.state === "closed" || pr.user?.login === login) return false;
    const requested = await this.getRequestedReviewers(owner, repo, prNumber, signal);
    return requested.users.some((reviewer) => reviewer.login === login);
  }

  /** Request VE as a reviewer while preserving existing users and teams. */
  async ensureReviewerAssignment(changeId: ExternalChangeId, signal?: AbortSignal): Promise<boolean> {
    const { owner, repo, prNumber } = this.parseChangeId(changeId);
    const pr = GitHubPrSchema.parse(await this.fetchJson(this.prUrl(owner, repo, prNumber), signal !== undefined ? { signal } : undefined));
    const login = await this.resolveReviewerLogin(signal);
    if (pr.merged || pr.state === "closed" || pr.user?.login === login) return false;

    const requested = await this.getRequestedReviewers(owner, repo, prNumber, signal);
    if (requested.users.some((reviewer) => reviewer.login === login)) return true;

    await this.fetchJsonVoid(
      `${this.prUrl(owner, repo, prNumber)}/requested_reviewers`,
      {
        method: "POST",
        body: JSON.stringify({ reviewers: [login], team_reviewers: [] }),
        ...(signal !== undefined ? { signal } : {}),
      },
    );
    return true;
  }

  /**
   * Returns true when VE has already submitted a PR review whose commit_id
   * matches the PR's current head SHA. GitHub reviews are anchored to the exact
   * commit reviewed, so this reliably detects a review of the *current*
   * patchset — a new push advances head.sha, returning false so the PR is
   * re-reviewed.
   */
  async hasReviewedCurrentPatchset(changeId: ExternalChangeId): Promise<boolean> {
    const { owner, repo, prNumber } = this.parseChangeId(changeId);
    let headSha: string;
    try {
      const pr = GitHubPrSchema.parse(await this.fetchJson(this.prUrl(owner, repo, prNumber)));
      headSha = pr.head.sha;
    } catch (err) {
      log.warn({ owner, repo, prNumber, err }, "hasReviewedCurrentPatchset: failed to fetch PR — assuming not reviewed");
      return false;
    }
    const me = await this.resolveCurrentLogin();
    if (me === null) return false;
    try {
      const perPage = 100;
      for (let page = 1; page <= 20; page++) {
        const reviews = GitHubReviewListSchema.parse(
          await this.fetchJson(
            `${this.prUrl(owner, repo, prNumber)}/reviews?per_page=${perPage}&page=${page}`
          )
        );
        const matched = reviews.some(
          (r) =>
            r.user?.login === me &&
            r.commit_id === headSha &&
            (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "COMMENTED")
        );
        if (matched) return true;
        if (reviews.length < perPage) break;
      }
      return false;
    } catch (err) {
      log.warn({ owner, repo, prNumber, err }, "hasReviewedCurrentPatchset: failed to list PR reviews — assuming not reviewed");
      return false;
    }
  }

  async getChangeDiff(changeId: ExternalChangeId, patchset?: number, signal?: AbortSignal): Promise<ReviewChangeDiff> {
    const { owner, repo, prNumber } = this.parseChangeId(changeId);
    const files = await this.getPrFiles(this.prUrl(owner, repo, prNumber), signal);
    assertTextualPatchesPresent(files, `GitHub PR ${owner}/${repo}#${prNumber}`);

    return {
      changeId,
      // Echo the requested patchset so diff.patchset stays consistent with the
      // SHA-derived currentPatchset surfaced in prompts/logs.
      patchset: patchset ?? 1,
      files: files.map((f): ReviewDiffFile => ({
        path: f.filename,
        status: mapFileStatus(f.status),
        patch: f.patch ?? "",
      })),
    };
  }

  async getInterPatchsetDiff(
    details: ReviewChangeDetails,
    fromPatchset: number,
    toPatchset: number,
    signal?: AbortSignal,
  ): Promise<ReviewChangeDiff> {
    const { owner, repo, prNumber } = this.parseChangeId(details.changeId);
    const pr = GitHubPrSchema.parse(await this.fetchJson(
      this.prUrl(owner, repo, prNumber),
      signal !== undefined ? { signal } : undefined,
    ));
    const currentPatchset = patchsetFromRevisionSha(pr.head.sha);
    if (currentPatchset !== toPatchset) {
      throw new Error(
        `GitHub PR head changed while resolving patchset ${toPatchset}; current patchset is ${currentPatchset}`,
      );
    }

    const fromSha = await this.resolvePatchsetSha(owner, repo, prNumber, fromPatchset, signal);
    if (fromSha === undefined) {
      throw new Error(`GitHub PR commit for patchset ${fromPatchset} was not found`);
    }

    const compare = GitHubCompareResponseSchema.parse(
      await this.fetchJson(
        `${this.config.apiBaseUrl}/repos/${owner}/${repo}/compare/${fromSha}...${pr.head.sha}?per_page=300`,
        signal !== undefined ? { signal } : undefined,
      )
    );
    assertTextualPatchesPresent(compare.files, `GitHub PR ${owner}/${repo}#${prNumber} inter-patchset comparison`);
    const files: ReviewDiffFile[] = compare.files.map((file) => ({
      path: file.filename,
      status: mapFileStatus(file.status),
      patch: file.patch ?? "",
    }));
    if (compare.files.length >= 300) {
      throw new Error(`GitHub PR ${owner}/${repo}#${prNumber}: inter-patchset comparison reached GitHub's 300-file limit`);
    }

    log.info(
      { changeId: details.changeId, fromPatchset, toPatchset, fileCount: files.length },
      "computed GitHub inter-patchset diff",
    );
    return { changeId: details.changeId, patchset: toPatchset, files };
  }

  async postReviewComments(
    changeId: ExternalChangeId,
    _revision: number,
    comments: InlineReviewComment[],
    summary: string,
    allowedFiles?: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.submitReview(changeId, comments, summary, "COMMENT", allowedFiles, signal);
  }

  async postReviewWithComments(
    changeId: ExternalChangeId,
    _revision: number,
    comments: InlineReviewComment[],
    summary: string,
    score: -1 | 0 | 1,
    allowedFiles?: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.submitReview(
      changeId,
      comments,
      summary,
      score < 0 ? "REQUEST_CHANGES" : score > 0 ? "APPROVE" : "COMMENT",
      allowedFiles,
      signal,
    );
  }

  async postReviewOverview(
    changeId: ExternalChangeId,
    _revision: number,
    publication: ReviewOverviewPublication,
    signal?: AbortSignal,
  ): Promise<ReviewOverviewPublicationResult> {
    const { owner, repo, prNumber } = this.parseChangeId(changeId);
    const prUrl = this.prUrl(owner, repo, prNumber);
    const headSha = publication.details.headSha;
    if (!headSha || publication.details.status !== "OPEN") {
      throw new Error("GitHub review overview requires an open PR with a known head SHA");
    }
    signal?.throwIfAborted();

    const inline: InlineReviewComment[] = [];
    const folded: InlineReviewComment[] = [];
    const positive = publication.comments.filter((comment) => comment.line > 0);
    const validLinesByFile = new Map<string, Set<number>>();
    if (positive.length > 0) {
      const files = await this.getPrFiles(prUrl, signal);
      for (const file of files) {
        if (file.patch) validLinesByFile.set(file.filename, parsePatchNewLineNumbers(file.patch));
      }
    }
    for (const comment of publication.comments) {
      const lines = validLinesByFile.get(comment.file);
      if (comment.line > 0 && lines?.has(comment.line) === true) {
        inline.push(comment);
      } else {
        folded.push(comment);
      }
    }
    for (const comment of publication.folded) {
      if (!publication.comments.includes(comment)) folded.push(comment);
    }

    signal?.throwIfAborted();
    // Keep the draft non-empty; the submit call replaces it with the overview.
    const createdResponse = await this.fetchJson(`${prUrl}/reviews`, {
      method: "POST",
      body: JSON.stringify({
        body: PENDING_REVIEW_PLACEHOLDER_BODY,
        commit_id: headSha,
        ...(inline.length > 0 ? {
          comments: inline.map((comment) => ({
            path: comment.file, line: comment.line, body: comment.message, side: "RIGHT",
          })),
        } : {}),
      }),
      ...(signal !== undefined ? { signal } : {}),
    });
    const created = GitHubPendingReviewSchema.safeParse(createdResponse);
    if (!created.success) throw new Error("GitHub pending review response missing a valid review ID");
    const remoteId = String(created.data.id);
    const reviewUrl = `${prUrl}/reviews/${remoteId}`;
    let submitting = false;
    let submitted = false;
    try {
      await publication.onPublicationCreated?.(remoteId);
      const matched = new Map<number, PublishedReviewFinding>();
      const unmatched = new Map<string, number[]>();
      for (const [index, comment] of inline.entries()) {
        const key = JSON.stringify([comment.file, comment.message]);
        const indices = unmatched.get(key) ?? [];
        indices.push(index);
        unmatched.set(key, indices);
      }

      for (let page = 1; page <= 100; page++) {
        signal?.throwIfAborted();
        const comments = GitHubPendingCommentListSchema.parse(await this.fetchJson(
          `${reviewUrl}/comments?per_page=100&page=${page}`,
          signal !== undefined ? { signal } : undefined,
        ));
        for (const comment of comments) {
          // Same-path, same-body comments are returned in submission order;
          // a returned line must still agree with the requested anchor.
          const candidates = unmatched.get(JSON.stringify([comment.path, comment.body])) ?? [];
          const position = candidates.findIndex((candidate) =>
            comment.line == null || inline[candidate]?.line === comment.line);
          const index = position < 0 ? undefined : candidates.splice(position, 1)[0];
          if (index === undefined) {
            throw new Error("GitHub pending review returned an unexpected inline comment");
          }
          const url = new URL(comment.html_url);
          const expected = new URL(publication.details.url);
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.origin !== expected.origin ||
            url.pathname !== expected.pathname ||
            url.hash !== `#discussion_r${comment.id}`
          ) {
            throw new Error("GitHub pending review returned an invalid inline comment URL");
          }
          const finding: PublishedReviewFinding = {
            comment: inline[index]!, url: url.href,
            providerThreadId: String(comment.id), disposition: "inline",
          };
          matched.set(index, finding);
        }
        if (comments.length < 100) break;
        if (page === 100) throw new Error("GitHub pending review comment pagination exceeded 100 pages");
      }
      if (matched.size !== inline.length) {
        throw new Error("GitHub pending review is missing inline comments");
      }
      const findings: PublishedReviewFinding[] = inline.map((_, index) => matched.get(index)!);
      for (const comment of folded) {
        const finding: PublishedReviewFinding = {
          comment, url: null, providerThreadId: null, disposition: "folded",
        };
        findings.push(finding);
      }
      const body = renderReviewOverview({
        score: publication.score,
        summary: publication.summary,
        changeOverview: publication.changeOverview,
        requiredAction: publication.requiredAction,
        commitSha: headSha,
        kind: "github",
        advisoryOnly: false,
        reReview: publication.reReview,
        fixedCount: publication.fixedCount,
        findings: [
          ...findings.map((finding) => ({
            comment: finding.comment, status: "new" as const,
            ...(finding.url !== null ? { url: finding.url } : {}),
          })),
          ...publication.previous.map((previous) => ({
            comment: previous.comment, status: "previous" as const,
            ...(previous.url !== null ? { url: previous.url } : {}),
          })),
        ],
      });
      signal?.throwIfAborted();
      const current = GitHubPrSchema.parse(await this.fetchJson(
        prUrl, signal !== undefined ? { signal } : undefined,
      ));
      if (current.state !== "open" || current.merged || current.head.sha !== headSha) {
        throw new Error("GitHub PR is no longer open at the reviewed head SHA");
      }
      signal?.throwIfAborted();
      submitting = true;
      // The linked overview is sent with the submit call: editing a pending
      // review via PUT returns 404 for OAuth integration tokens.
      await this.fetchJson(`${reviewUrl}/events`, {
        method: "POST",
        body: JSON.stringify({
          body,
          event: publication.score < 0 ? "REQUEST_CHANGES" : publication.score > 0 ? "APPROVE" : "COMMENT",
        }),
        ...(signal !== undefined ? { signal } : {}),
      });
      submitted = true;
      for (const finding of findings) {
        await publication.onFindingPosted?.(finding);
      }
      return { findings, remoteId, advisoryOnly: false };
    } catch (error: unknown) {
      const reason = sanitizeErrorDetail(error instanceof Error ? error.message : String(error));
      if (!submitting) {
        try {
          await this.fetchJsonVoid(reviewUrl, { method: "DELETE" });
        } catch (cleanupError: unknown) {
          throw new AggregateError(
            [error, cleanupError],
            `GitHub pending review ${remoteId} cleanup failed after pre-submission failure; draft may remain`,
          );
        }
        throw new Error(`GitHub pending review ${remoteId} deleted after pre-submission failure: ${reason}`, { cause: error });
      }
      throw new Error(
        submitted
          ? `GitHub review ${remoteId} submitted but finding persistence failed: ${reason}`
          : `GitHub review ${remoteId} submission outcome unknown; pending review not deleted: ${reason}`,
        { cause: error },
      );
    }
  }

  async vote(
    changeId: ExternalChangeId,
    _revision: number,
    score: number,
    message?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const event = score < 0 ? "REQUEST_CHANGES" : score > 0 ? "APPROVE" : "COMMENT";
    await this.submitReview(changeId, [], message ?? "", event, undefined, signal);
  }

  private async submitReview(
    changeId: ExternalChangeId,
    comments: InlineReviewComment[],
    summary: string,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    allowedFiles?: ReadonlySet<string>,
    signal?: AbortSignal,
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
        const files = await this.getPrFiles(this.prUrl(owner, repo, prNumber), signal);
        for (const f of files) {
          if (f.patch) {
            validLinesByFile.set(f.filename, parsePatchNewLineNumbers(f.patch));
          }
        }
      } catch (err) {
        if (signal?.aborted === true) throw signal.reason ?? err;
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
      ...(signal !== undefined ? { signal } : {}),
    });
    log.info(
      { repo, prNumber, event, inlineCount: apiComments.length, foldedCount: outOfDiffComments.length },
      "posted GitHub PR review"
    );
  }

  private prUrl(owner: string, repo: string, prNumber: number): string {
    return `${this.config.apiBaseUrl}/repos/${owner}/${repo}/pulls/${prNumber}`;
  }

  private async getPrFiles(prUrl: string, signal?: AbortSignal): Promise<z.infer<typeof GitHubPrFileListSchema>> {
    const files: z.infer<typeof GitHubPrFileListSchema> = [];
    for (let page = 1; page <= 30; page++) {
      signal?.throwIfAborted();
      const pageFiles = GitHubPrFileListSchema.parse(await this.fetchJson(
        `${prUrl}/files?per_page=100&page=${page}`,
        signal !== undefined ? { signal } : undefined,
      ));
      if (pageFiles.length > 100) throw new Error("GitHub PR file page returned more than 100 files");
      files.push(...pageFiles);
      if (pageFiles.length < 100) return files;
    }
    throw new Error("GitHub PR files reached the 3,000-file cap; cannot verify complete file list");
  }

  private async resolvePatchsetSha(
    owner: string,
    repo: string,
    prNumber: number,
    patchset: number,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const perPage = 100;
    for (let page = 1; page <= 100; page++) {
      if (signal?.aborted === true) throw signal.reason ?? new Error("GitHub patchset lookup aborted");
      const commits = GitHubPrCommitListSchema.parse(
        await this.fetchJson(
          `${this.prUrl(owner, repo, prNumber)}/commits?per_page=${perPage}&page=${page}`,
          signal !== undefined ? { signal } : undefined,
        )
      );
      const matchingCommit = commits.find((commit) => patchsetFromRevisionSha(commit.sha) === patchset);
      if (matchingCommit !== undefined) return matchingCommit.sha;
      if (commits.length < perPage) break;
    }
    return undefined;
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
      throw new Error(`GitHub API ${response.status} ${sanitizeErrorDetail(url, 1000)}: ${sanitizeErrorDetail(text)}`);
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
      throw new Error(`GitHub API ${response.status} ${sanitizeErrorDetail(url, 1000)}: ${sanitizeErrorDetail(body)}`);
    }
    await response.text();
  }

  async getDiscussionThreads(changeId: ExternalChangeId, signal?: AbortSignal): Promise<ReviewDiscussionThread[]> {
    const { owner, repo, prNumber } = this.parseChangeId(changeId);
    const me = await this.resolveCurrentLogin(signal);
    const reviewerLogins = await this.getReviewerLogins(owner, repo, prNumber, signal);
    if (me !== null) reviewerLogins.add(me);

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
        await this.graphql(query, { owner, repo, number: prNumber, cursor }, signal)
      );
      const reviewThreads = data.repository?.pullRequest?.reviewThreads;
      if (!reviewThreads) break;

      for (const node of reviewThreads.nodes) {
        const comments: ReviewDiscussionComment[] = node.comments.nodes
          .filter((comment) => comment.author?.login !== undefined && reviewerLogins.has(comment.author.login))
          .map((c) => ({
            author: c.author!.login,
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

  private async getReviewerLogins(
    owner: string,
    repo: string,
    prNumber: number,
    signal?: AbortSignal,
  ): Promise<Set<string>> {
    const reviewerLogins = new Set<string>();
    try {
      const perPage = 100;
      for (let page = 1; page <= 20; page++) {
        const reviews = GitHubReviewListSchema.parse(
          await this.fetchJson(
            `${this.prUrl(owner, repo, prNumber)}/reviews?per_page=${perPage}&page=${page}`,
            signal !== undefined ? { signal } : undefined,
          )
        );
        for (const review of reviews) {
          const login = review.user?.login;
          if (login !== undefined && SUBMITTED_REVIEW_STATES.has(review.state)) {
            reviewerLogins.add(login);
          }
        }
        if (reviews.length < perPage) break;
      }
    } catch (err) {
      if (signal?.aborted === true) throw signal.reason ?? err;
      log.warn({ owner, repo, prNumber, err }, "failed to resolve GitHub PR reviewers; ignoring external thread authors");
    }
    return reviewerLogins;
  }

  async postThreadReply(
    _changeId: ExternalChangeId,
    _revision: number,
    threadId: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const mutation = `
      mutation($threadId:ID!,$body:String!){
        addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId, body:$body}){
          comment{ id }
        }
      }`;
    await this.graphql(mutation, { threadId, body: message }, signal);
    log.info({ threadId }, "posted GitHub PR review thread reply");
  }

  /** Resolve and cache VE's own GitHub login (used to tag `isOwn` comments). */
  private async resolveCurrentLogin(signal?: AbortSignal): Promise<string | null> {
    if (this.currentLogin !== null) return this.currentLogin;
    try {
      const data = GraphQLViewerSchema.parse(await this.graphql(`query{ viewer{ login } }`, {}, signal));
      this.currentLogin = data.viewer.login;
      return this.currentLogin;
    } catch (err) {
      if (signal?.aborted === true) throw signal.reason ?? err;
      log.warn({ err }, "failed to resolve GitHub viewer login; isOwn tagging disabled");
      return null;
    }
  }

  private async resolveReviewerLogin(signal?: AbortSignal): Promise<string> {
    if (this.config.virtualEngineerUserLogin) return this.config.virtualEngineerUserLogin;
    if (this.reviewerLoginPromise !== undefined) return this.reviewerLoginPromise;
    const lookup = this.fetchJson<{ login: string }>(
      `${this.config.apiBaseUrl}/user`,
      signal !== undefined ? { signal } : undefined,
    ).then((user) => {
      if (typeof user.login !== "string" || user.login.length === 0) {
        throw new Error("GitHub /user response missing expected 'login' field");
      }
      return user.login;
    });
    this.reviewerLoginPromise = lookup.catch((err: unknown) => {
      this.reviewerLoginPromise = undefined;
      throw err;
    });
    return this.reviewerLoginPromise;
  }

  private async getRequestedReviewers(
    owner: string,
    repo: string,
    prNumber: number,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof GitHubRequestedReviewersSchema>> {
    return GitHubRequestedReviewersSchema.parse(await this.fetchJson(
      `${this.prUrl(owner, repo, prNumber)}/requested_reviewers`,
      signal !== undefined ? { signal } : undefined,
    ));
  }

  /** Derive the GraphQL endpoint from the REST API base URL. */
  private graphqlEndpoint(): string {
    const base = this.config.apiBaseUrl.replace(/\/+$/, "");
    if (base.endsWith("/api/v3")) return `${base.slice(0, -"/api/v3".length)}/api/graphql`;
    if (base === "https://api.github.com") return "https://api.github.com/graphql";
    return `${base}/graphql`;
  }

  private async graphql<T = unknown>(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await globalThis.fetch(this.graphqlEndpoint(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ query, variables }),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`GitHub GraphQL ${response.status}: ${sanitizeErrorDetail(text)}`);
    }
    const json = (await response.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };
    if (json.errors && json.errors.length > 0) {
      throw new Error(`GitHub GraphQL error: ${sanitizeErrorDetail(json.errors.map((e) => e.message).join("; "))}`);
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

// Machine-generated files (Drizzle snapshots, lockfiles) are routinely too large
// for GitHub to return a patch and carry no reviewable intent.
const GENERATED_FILE_PATTERN =
  /(?:^|\/)(?:meta\/\d+_snapshot\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/;

/**
 * GitHub omits `patch` for binary files and pure renames/mode changes (zero
 * changed lines) as well as for oversized text diffs. Only the latter makes the
 * diff incomplete; missing line counts are treated as unknown and rejected.
 * Known generated files are exempt and kept with an empty patch.
 */
function assertTextualPatchesPresent(
  files: ReadonlyArray<{ filename: string; patch?: string | null | undefined; changes?: number | undefined }>,
  context: string,
): void {
  const missing = files.find(
    (file) =>
      (file.patch === undefined || file.patch === null) &&
      file.changes !== 0 &&
      !GENERATED_FILE_PATTERN.test(file.filename),
  );
  if (missing !== undefined) {
    throw new Error(`${context}: patch unavailable for ${missing.filename}; cannot review an incomplete diff`);
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
