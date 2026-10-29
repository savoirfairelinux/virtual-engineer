/**
 * GitLab Merge Request review provider.
 *
 * Implements the integration-agnostic `ReviewProvider` interface against
 * GitLab REST and GraphQL APIs: read diffs, post discussions and summaries,
 * approve, or request changes.
 *
 * changeId formats supported:
 *  - `"group/project#42"`  project path + MR IID (preferred, mirrors GitHub)
 *  - `"123#42"`            numeric project id + MR IID
 *  - `"42"`               legacy bare MR IID (falls back to the configured project)
 */
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
import { GitLabHttpClient } from "./gitlabHttpClient.js";
import { ReviewApiError } from "../interfaces.js";
import { filterCommentsByAllowedFiles } from "../review/commentFilter.js";
import { patchsetFromRevisionSha } from "../review/revisionPatchset.js";
import { parsePatchNewLineNumbers } from "./githubReviewProvider.js";
import { sanitizeErrorDetail } from "../utils/redactUrl.js";
import { renderReviewOverview, type ReviewOverviewFinding } from "../review/reviewOverview.js";

const log = getLogger("gitlab-mr-review-provider");

const DiffRefsSchema = z
  .object({
    base_sha: z.string().nullable().optional(),
    head_sha: z.string().nullable().optional(),
    start_sha: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

const MrSchema = z.object({
  iid: z.number(),
  state: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  web_url: z.string(),
  target_branch: z.string(),
  source_branch: z.string(),
  project_id: z.number(),
  sha: z.string().nullable().optional(),
  author: z.object({ id: z.number(), username: z.string() }).nullable().optional(),
  reviewers: z.array(z.object({ id: z.number(), username: z.string() })).default([]),
  references: z.object({ full: z.string().optional() }).partial().optional(),
  diff_refs: DiffRefsSchema,
});

interface InlinePositionTarget {
  oldPath: string;
  newPath: string;
  lines: Set<number>;
}

/** Index changed files by new path, keeping the original path GitLab requires for renamed-file positions. */
function inlinePositionTargets(
  changes: ReadonlyArray<{ old_path: string; new_path: string; diff?: string | undefined }>,
): Map<string, InlinePositionTarget> {
  const targets = new Map<string, InlinePositionTarget>();
  for (const change of changes) {
    const newPath = change.new_path || change.old_path;
    targets.set(newPath, {
      oldPath: change.old_path || newPath,
      newPath,
      lines: parsePatchNewLineNumbers(change.diff ?? ""),
    });
  }
  return targets;
}

const MrChangeSchema = z.object({
  old_path: z.string(),
  new_path: z.string(),
  new_file: z.boolean().optional().default(false),
  renamed_file: z.boolean().optional().default(false),
  deleted_file: z.boolean().optional().default(false),
  diff: z.string().optional(),
});

const MrChangesResponseSchema = z.object({
  changes: z.array(MrChangeSchema),
  diff_refs: DiffRefsSchema,
  overflow: z.boolean().optional().default(false),
});

const ProjectSchema = z.object({ path_with_namespace: z.string() });

const GraphqlResponseSchema = z.object({
  data: z.unknown().nullable().optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

const ReviewersSchema = z.object({
  reviewers: z.object({
    nodes: z.array(z.object({
      id: z.string(),
      mergeRequestInteraction: z.object({ reviewState: z.string().nullable() }).nullable(),
    })),
  }),
});

const MutationSchema = z.object({
  errors: z.array(z.string()),
  mergeRequest: ReviewersSchema.nullable(),
});

export type GitLabReviewDecisionOutcome = "requested_changes" | "advisory_only" | "other";

const CurrentUserSchema = z.object({ id: z.number(), username: z.string() });

const MrCommitSchema = z.object({
  created_at: z.string().nullable().optional(),
  committed_date: z.string().nullable().optional(),
});

const MrNoteSchema = z.object({
  system: z.boolean().optional().default(false),
  created_at: z.string().nullable().optional(),
  author: z.object({ username: z.string() }).nullable().optional(),
});

const DiscussionNoteSchema = z.object({
  id: z.number(),
  body: z.string().default(""),
  system: z.boolean().optional().default(false),
  resolvable: z.boolean().optional().default(false),
  resolved: z.boolean().optional().default(false),
  author: z.object({ id: z.number(), username: z.string() }).nullable().optional(),
  position: z
    .object({
      new_path: z.string().nullable().optional(),
      old_path: z.string().nullable().optional(),
      new_line: z.number().nullable().optional(),
      old_line: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
});

const DiscussionSchema = z.object({
  id: z.string(),
  individual_note: z.boolean().optional().default(false),
  notes: z.array(DiscussionNoteSchema).optional().default([]),
});

export interface GitLabMrReviewProviderConfig {
  baseUrl: string;
  /** Default/legacy project (path or numeric id) used when the changeId carries no project prefix. */
  projectId: string | number;
  token: string;
}

function createGitLabReviewError(status: number, url: string, body: string): ReviewApiError {
  return new ReviewApiError(status, url, body);
}

export class GitLabMergeRequestReviewProvider implements ReviewProvider {
  public readonly kind = "gitlab";

  private readonly http: GitLabHttpClient;
  private currentUser: z.infer<typeof CurrentUserSchema> | null = null;
  private currentUserPromise: Promise<z.infer<typeof CurrentUserSchema> | null> | undefined;

  constructor(private readonly config: GitLabMrReviewProviderConfig) {
    this.http = new GitLabHttpClient(config.token, createGitLabReviewError);
  }

  /** Parse a GitLab review changeId into a project ref and MR IID. */
  private parseChange(changeId: ExternalChangeId): { project: string | number; iid: number } {
    const raw = String(changeId);
    const hashIdx = raw.indexOf("#");
    if (hashIdx > 0) {
      const projectPart = raw.slice(0, hashIdx);
      const iid = parseInt(raw.slice(hashIdx + 1), 10);
      if (!projectPart || isNaN(iid) || iid <= 0) {
        throw new Error(`Invalid GitLab changeId: "${raw}" — expected "project#iid"`);
      }
      return { project: projectPart, iid };
    }
    const iid = parseInt(raw, 10);
    if (isNaN(iid) || iid <= 0) {
      throw new Error(`Invalid GitLab MR IID: "${raw}"`);
    }
    return { project: this.config.projectId, iid };
  }

  /** URL-encode a project path or numeric id for use in an API path segment. */
  private projectRef(project: string | number): string {
    return encodeURIComponent(String(project));
  }

  private mrUrl(project: string | number, iid: number): string {
    return `${this.config.baseUrl}/api/v4/projects/${this.projectRef(project)}/merge_requests/${iid}`;
  }

  async getChangeDetails(changeId: ExternalChangeId, signal?: AbortSignal): Promise<ReviewChangeDetails> {
    const { project, iid } = this.parseChange(changeId);
    const mr = MrSchema.parse(await this.http.fetchJson(
      this.mrUrl(project, iid),
      signal !== undefined ? { signal } : undefined,
    ));

    const status: ReviewChangeDetails["status"] =
      mr.state === "merged"
        ? "MERGED"
        : mr.state === "closed" || mr.state === "locked"
          ? "ABANDONED"
          : "OPEN";

    const projectPath = await this.resolveProjectPath(project, mr, signal);

    return {
      changeId,
      changeNumber: mr.iid,
      subject: mr.title,
      description: (mr.description ?? "").trim(),
      ownerAccountId: mr.author ? String(mr.author.id) : "",
      // Derived from the MR head SHA so the review dedup re-reviews the MR when
      // new commits are pushed (GitLab has no monotonic patchset counter).
      currentPatchset: patchsetFromRevisionSha(mr.sha ?? mr.diff_refs?.head_sha ?? null),
      status,
      project: projectPath,
      targetBranch: mr.target_branch,
      url: mr.web_url,
      headSha: mr.sha ?? mr.diff_refs?.head_sha ?? undefined,
    };
  }

  async isReviewer(changeId: ExternalChangeId, signal?: AbortSignal): Promise<boolean> {
    const { project, iid } = this.parseChange(changeId);
    const mr = MrSchema.parse(await this.http.fetchJson(
      this.mrUrl(project, iid),
      signal !== undefined ? { signal } : undefined,
    ));
    const currentUser = await this.resolveCurrentUser(signal);
    if (currentUser === null || mr.state !== "opened" || mr.author?.id === currentUser.id) return false;
    return mr.reviewers.some((reviewer) => reviewer.id === currentUser.id || reviewer.username === currentUser.username);
  }

  /** Add VE to the MR reviewer set without removing existing reviewers. */
  async ensureReviewerAssignment(changeId: ExternalChangeId, signal?: AbortSignal): Promise<boolean> {
    const { project, iid } = this.parseChange(changeId);
    const mr = MrSchema.parse(await this.http.fetchJson(
      this.mrUrl(project, iid),
      signal !== undefined ? { signal } : undefined,
    ));
    const currentUser = await this.resolveCurrentUser(signal);
    if (currentUser === null || mr.state !== "opened" || mr.author?.id === currentUser.id) return false;

    const reviewerIds = [...new Set([
      ...mr.reviewers.map((reviewer) => reviewer.id),
      currentUser.id,
    ])];
    if (mr.reviewers.some((reviewer) => reviewer.id === currentUser.id)) return true;
    await this.http.fetchJsonVoid(this.mrUrl(project, iid), {
      method: "PUT",
      body: JSON.stringify({ reviewer_ids: reviewerIds }),
      ...(signal !== undefined ? { signal } : {}),
    });
    return true;
  }

  /**
   * Returns true when VE has already posted a review note on the MR at or after
   * the latest commit's timestamp. GitLab notes are not tagged with a revision,
   * so we compare VE's newest non-system note against the MR head commit date:
   * VE posts its summary note when it reviews, so a VE note dated at/after the
   * head commit means the current revision was already reviewed. A subsequent
   * push adds a newer commit → returns false → re-review.
   */
  async hasReviewedCurrentPatchset(changeId: ExternalChangeId): Promise<boolean> {
    const { project, iid } = this.parseChange(changeId);
    const me = await this.resolveCurrentUsername();
    if (me === null) return false;

    let latestCommitMs: number | null = null;
    try {
      const commits = z
        .array(MrCommitSchema)
        .parse(await this.http.fetchJson(`${this.mrUrl(project, iid)}/commits`));
      for (const c of commits) {
        const ts = c.committed_date ?? c.created_at;
        if (!ts) continue;
        const ms = Date.parse(ts);
        if (!Number.isNaN(ms) && (latestCommitMs === null || ms > latestCommitMs)) latestCommitMs = ms;
      }
    } catch (err) {
      log.warn({ project, iid, err }, "hasReviewedCurrentPatchset: failed to fetch MR commits — assuming not reviewed");
      return false;
    }
    if (latestCommitMs === null) return false;
    const commitMs = latestCommitMs;

    try {
      // Notes are returned newest-first; walk pages until we find VE's own note
      // at/after the latest commit, or reach notes older than the commit (all
      // remaining notes are older too, so we can stop early).
      let page: number | null = 1;
      for (let guard = 0; page !== null && guard < 50; guard++) {
        const { body, nextPage } = await this.http.fetchPaginated(
          `${this.mrUrl(project, iid)}/notes?per_page=100&sort=desc&order_by=created_at&page=${page}`
        );
        const notes = z.array(MrNoteSchema).parse(body);
        for (const n of notes) {
          if (n.system || !n.created_at) continue;
          const ms = Date.parse(n.created_at);
          if (Number.isNaN(ms)) continue;
          if (ms < commitMs) return false;
          if (n.author?.username === me) return true;
        }
        page = nextPage;
      }
      return false;
    } catch (err) {
      log.warn({ project, iid, err }, "hasReviewedCurrentPatchset: failed to fetch MR notes — assuming not reviewed");
      return false;
    }
  }

  async getChangeDiff(changeId: ExternalChangeId, patchset?: number, signal?: AbortSignal): Promise<ReviewChangeDiff> {
    const { project, iid } = this.parseChange(changeId);
    const res = MrChangesResponseSchema.parse(
      await this.http.fetchJson(
        `${this.mrUrl(project, iid)}/changes`,
        signal !== undefined ? { signal } : undefined,
      )
    );
    if (res.overflow) {
      throw new Error(`GitLab MR ${project}#${iid}: diff overflow; cannot review an incomplete diff`);
    }
    const missingPatch = res.changes.find((change) => change.diff === undefined);
    if (missingPatch !== undefined) {
      throw new Error(`GitLab MR ${project}#${iid}: patch unavailable for ${missingPatch.new_path || missingPatch.old_path}; cannot review an incomplete diff`);
    }

    return {
      changeId,
      // Echo the requested patchset so diff.patchset stays consistent with the
      // SHA-derived currentPatchset surfaced in prompts/logs.
      patchset: patchset ?? 1,
      files: res.changes.map(
        (ch): ReviewDiffFile => ({
          path: ch.new_path || ch.old_path,
          status: mapFileStatus(ch),
          patch: ch.diff ?? "",
        })
      ),
    };
  }

  async postReviewComments(
    changeId: ExternalChangeId,
    _revision: number,
    comments: InlineReviewComment[],
    summary: string,
    allowedFiles?: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.submitReview(changeId, comments, summary, undefined, allowedFiles, signal);
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
    await this.postReviewWithDecision(changeId, _revision, comments, summary, score, allowedFiles, signal);
  }

  /** Use this concrete method when callers need to distinguish blocking from advisory reviews. */
  async postReviewWithDecision(
    changeId: ExternalChangeId,
    _revision: number,
    comments: InlineReviewComment[],
    summary: string,
    score: -1 | 0 | 1,
    allowedFiles?: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<GitLabReviewDecisionOutcome> {
    return this.submitReview(changeId, comments, summary, score, allowedFiles, signal);
  }

  async vote(
    changeId: ExternalChangeId,
    _revision: number,
    score: number,
    message?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.submitReview(changeId, [], message ?? "", score < 0 ? -1 : score > 0 ? 1 : 0, undefined, signal);
  }

  async postReviewOverview(
    changeId: ExternalChangeId,
    _revision: number,
    publication: ReviewOverviewPublication,
    signal?: AbortSignal,
  ): Promise<ReviewOverviewPublicationResult> {
    const { project, iid } = this.parseChange(changeId);
    const headSha = publication.details.headSha;
    const reviewedRevisionError = (): ReviewApiError => new ReviewApiError(
      409, this.mrUrl(project, iid), "Merge request no longer matches the reviewed revision",
    );
    if (!headSha || publication.details.status !== "OPEN") throw reviewedRevisionError();
    const current = MrSchema.parse(await this.http.fetchJson(
      this.mrUrl(project, iid),
      signal !== undefined ? { signal } : undefined,
    ));
    if (current.state !== "opened") {
      throw new ReviewApiError(409, this.mrUrl(project, iid), "Merge request is no longer open for the reviewed revision");
    }
    if ((current.sha ?? current.diff_refs?.head_sha) !== headSha) throw reviewedRevisionError();
    let advisoryOnly = false;
    if (publication.score === -1) {
      if (await this.requestChanges(project, iid, signal) === "unsupported") {
        await this.approve(project, iid, false, signal);
        advisoryOnly = true;
        log.warn({ project, iid }, "GitLab request changes unavailable; review overview is advisory only");
      }
    } else {
      await this.removeOwnRequestedChanges(project, iid, signal);
      if (publication.score === 1) await this.approve(project, iid, true, signal);
    }

    const inline: PublishedReviewFinding[] = [];
    const folded: InlineReviewComment[] = [...publication.folded];
    let refs: z.infer<typeof DiffRefsSchema> = null;
    let positions = new Map<string, InlinePositionTarget>();
    if (publication.comments.some((comment) => comment.line > 0)) {
      const changes = MrChangesResponseSchema.parse(await this.http.fetchJson(
        `${this.mrUrl(project, iid)}/changes`,
        signal !== undefined ? { signal } : undefined,
      ));
      refs = changes.diff_refs;
      if (refs?.head_sha !== headSha) throw reviewedRevisionError();
      positions = inlinePositionTargets(changes.changes);
    }
    for (const comment of publication.comments) {
      const target = positions.get(comment.file);
      if (comment.line <= 0 ||
          typeof refs?.base_sha !== "string" ||
          typeof refs.head_sha !== "string" ||
          typeof refs.start_sha !== "string" ||
          target === undefined ||
          !target.lines.has(comment.line)) {
        folded.push(comment);
        continue;
      }
      let response: unknown;
      try {
        response = await this.http.fetchJson(`${this.mrUrl(project, iid)}/discussions`, {
          method: "POST",
          body: JSON.stringify({
            body: comment.message,
            position: {
              base_sha: refs.base_sha,
              head_sha: refs.head_sha,
              start_sha: refs.start_sha,
              position_type: "text",
              new_path: target.newPath,
              new_line: comment.line,
              old_path: target.oldPath,
            },
          }),
          ...(signal !== undefined ? { signal } : {}),
        });
      } catch (err: unknown) {
        if (signal?.aborted === true) throw signal.reason ?? err;
        if (!(err instanceof ReviewApiError && (err.statusCode === 400 || err.statusCode === 422))) throw err;
        log.warn({ project, iid, file: comment.file, line: comment.line, err }, "GitLab inline finding failed; folding into overview");
        folded.push(comment);
        continue;
      }
      const discussion = z.object({
        id: z.string(),
        notes: z.tuple([z.object({ id: z.number() })]).rest(z.object({ id: z.number() })),
      }).parse(response);
      const finding: PublishedReviewFinding = {
        comment,
        url: `${publication.details.url}#note_${discussion.notes[0].id}`,
        providerThreadId: discussion.id,
        disposition: "inline",
      };
      inline.push(finding);
      await publication.onFindingPosted?.(finding);
    }

    const findings: ReviewOverviewFinding[] = [
      ...inline.map((finding) => ({ comment: finding.comment, status: "new" as const, url: finding.url ?? undefined })),
      ...folded.map((comment) => ({ comment, status: "new" as const })),
      ...publication.previous.map((finding) => ({
        comment: finding.comment,
        status: "previous" as const,
        url: finding.url ?? undefined,
      })),
    ];
    const body = renderReviewOverview({
      score: publication.score,
      summary: publication.summary,
      changeOverview: publication.changeOverview,
      requiredAction: publication.requiredAction,
      commitSha: publication.details.headSha,
      kind: "gitlab",
      advisoryOnly,
      reReview: publication.reReview,
      fixedCount: publication.fixedCount,
      findings,
    });
    const note = z.object({ id: z.union([z.number(), z.string()]) }).parse(await this.http.fetchJson(
      `${this.mrUrl(project, iid)}/notes`,
      {
        method: "POST",
        body: JSON.stringify({ body }),
        ...(signal !== undefined ? { signal } : {}),
      },
    ));
    const remoteId = String(note.id);
    await publication.onPublicationCreated?.(remoteId);
    const posted: PublishedReviewFinding[] = [...inline];
    for (const comment of folded) {
      const finding: PublishedReviewFinding = {
        comment,
        url: null,
        providerThreadId: null,
        disposition: "folded",
      };
      posted.push(finding);
      await publication.onFindingPosted?.(finding);
    }
    return { findings: posted, remoteId, advisoryOnly };
  }

  /**
   * Post inline discussions + a summary note and (optionally) approve/unapprove.
   * Comments targeting lines outside the diff hunks are folded into the summary
   * note so no feedback is lost and GitLab never rejects the whole request.
   */
  private async submitReview(
    changeId: ExternalChangeId,
    comments: InlineReviewComment[],
    summary: string,
    score: -1 | 0 | 1 | undefined,
    allowedFiles?: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<GitLabReviewDecisionOutcome> {
    const { project, iid } = this.parseChange(changeId);

    const fileFiltered = filterCommentsByAllowedFiles(comments, allowedFiles, { project, iid });
    const positiveLine = fileFiltered.filter((c) => c.line > 0);
    // File-level comments (line <= 0) cannot be positioned inline; fold them
    // into the summary note so the feedback is not lost.
    const fileLevel = fileFiltered.filter((c) => c.line <= 0);

    // Fetch changes once to validate inline comment lines and obtain diff_refs.
    let diffRefs:
      | { base_sha?: string | null | undefined; head_sha?: string | null | undefined; start_sha?: string | null | undefined }
      | null = null;
    let positions = new Map<string, InlinePositionTarget>();
    if (positiveLine.length > 0) {
      try {
        const res = MrChangesResponseSchema.parse(
          await this.http.fetchJson(
            `${this.mrUrl(project, iid)}/changes`,
            signal !== undefined ? { signal } : undefined,
          )
        );
        diffRefs = res.diff_refs ?? null;
        positions = inlinePositionTargets(res.changes.filter((change) => (change.diff ?? "").length > 0));
      } catch (err) {
        if (signal?.aborted === true) throw signal.reason ?? err;
        log.warn({ project, iid, err }, "failed to fetch MR changes for line validation; folding comments into summary");
      }
    }

    const inline: InlineReviewComment[] = [];
    const outOfDiff: InlineReviewComment[] = [...fileLevel];
    const canPositionInline =
      diffRefs !== null &&
      typeof diffRefs.base_sha === "string" &&
      typeof diffRefs.head_sha === "string" &&
      typeof diffRefs.start_sha === "string";
    for (const c of positiveLine) {
      const validLines = positions.get(c.file)?.lines;
      if (canPositionInline && (validLines === undefined || validLines.has(c.line))) inline.push(c);
      else outOfDiff.push(c);
    }

    // Post inline discussions; on a per-comment failure, fold into the summary.
    for (const c of inline) {
      try {
        await this.http.fetchJsonVoid(`${this.mrUrl(project, iid)}/discussions`, {
          method: "POST",
          body: JSON.stringify({
            body: c.message,
            position: {
              base_sha: diffRefs?.base_sha,
              head_sha: diffRefs?.head_sha,
              start_sha: diffRefs?.start_sha,
              position_type: "text",
              new_path: c.file,
              new_line: c.line,
              old_path: positions.get(c.file)?.oldPath ?? c.file,
            },
          }),
          ...(signal !== undefined ? { signal } : {}),
        });
      } catch (err) {
        if (signal?.aborted === true) throw signal.reason ?? err;
        log.warn({ project, iid, file: c.file, line: c.line, err }, "inline discussion failed; folding into summary");
        outOfDiff.push(c);
      }
    }

    const foldedSection =
      outOfDiff.length > 0
        ? "\n\n---\n**Additional comments (lines outside diff hunk):**\n" +
          outOfDiff
            .map((c) =>
              c.line > 0
                ? `- \`${c.file}:${c.line}\` [${c.severity}]: ${c.message}`
                : `- \`${c.file}\` [${c.severity}]: ${c.message}`
            )
            .join("\n")
        : "";

    const noteBody = summary + foldedSection;
    if (noteBody.trim().length > 0) {
      await this.http.fetchJsonVoid(`${this.mrUrl(project, iid)}/notes`, {
        method: "POST",
        body: JSON.stringify({ body: noteBody }),
        ...(signal !== undefined ? { signal } : {}),
      });
    }

    let decision: GitLabReviewDecisionOutcome = "other";
    if (score === -1) {
      const native = await this.requestChanges(project, iid, signal);
      if (native === "unsupported") {
        await this.approve(project, iid, false, signal);
        decision = "advisory_only";
        log.warn({ project, iid, decision }, "GitLab native request changes unavailable; REST unapprove is advisory only and does not block merging");
      } else {
        decision = "requested_changes";
      }
    } else if (score !== undefined) {
      await this.removeOwnRequestedChanges(project, iid, signal);
      if (score === 1) await this.approve(project, iid, true, signal);
    }

    log.info(
      { project, iid, inlineCount: inline.length, foldedCount: outOfDiff.length, score, decision },
      "posted GitLab MR review"
    );
    return decision;
  }

  private async graphql(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ data: unknown; errors: readonly string[] }> {
    const url = `${this.config.baseUrl}/api/graphql`;
    const response = GraphqlResponseSchema.parse(await this.http.fetchJson(url, {
      method: "POST",
      body: JSON.stringify({ query, variables }),
      ...(signal !== undefined ? { signal } : {}),
    }));
    return {
      data: response.data,
      errors: response.errors?.map((error) => error.message) ?? [],
    };
  }

  private unsupportedRequestChanges(errors: readonly string[]): boolean {
    return errors.length > 0 && errors.every((error) =>
      /(?:mergeRequestRequestChanges.*(?:doesn't exist|not (?:found|supported|available))|(?:request(?:ing|ed)? changes|review(?:er)? state).*(?:not (?:available|supported|enabled)|requires? (?:premium|ultimate)|(?:premium|ultimate|subscription|license|tier|plan)))/i.test(error)
    );
  }

  private async graphqlProjectPath(project: string | number, signal?: AbortSignal): Promise<string> {
    if (typeof project === "string" && project.includes("/")) return project;
    const response = ProjectSchema.parse(await this.http.fetchJson(
      `${this.config.baseUrl}/api/v4/projects/${this.projectRef(project)}`,
      signal !== undefined ? { signal } : undefined,
    ));
    return response.path_with_namespace;
  }

  private async requestChanges(
    project: string | number,
    iid: number,
    signal?: AbortSignal,
  ): Promise<"requested_changes" | "unsupported"> {
    const projectPath = await this.graphqlProjectPath(project, signal);
    const url = `${this.config.baseUrl}/api/graphql`;
    let response: Awaited<ReturnType<typeof this.graphql>>;
    try {
      response = await this.graphql(
        "mutation($input: MergeRequestRequestChangesInput!) { mergeRequestRequestChanges(input: $input) { errors mergeRequest { reviewers(first: 100) { nodes { id mergeRequestInteraction { reviewState } } } } } }",
        { input: { projectPath, iid: String(iid) } },
        signal,
      );
    } catch (err: unknown) {
      if (signal?.aborted === true) throw signal.reason ?? err;
      if (err instanceof ReviewApiError && err.statusCode === 404) return "unsupported";
      throw err;
    }
    if (this.unsupportedRequestChanges(response.errors)) return "unsupported";
    if (response.errors.length > 0) throw new ReviewApiError(422, url, sanitizeErrorDetail(response.errors.join("; ")));
    const result = z.object({ mergeRequestRequestChanges: MutationSchema }).parse(response.data).mergeRequestRequestChanges;
    if (this.unsupportedRequestChanges(result.errors)) return "unsupported";
    if (result.errors.length > 0) throw new ReviewApiError(422, url, sanitizeErrorDetail(result.errors.join("; ")));
    if (result.mergeRequest === null) {
      throw new ReviewApiError(422, url, "GitLab returned no merge request for native changes request");
    }
    const me = await this.resolveCurrentUser(signal);
    if (me === null || this.ownReviewState(result.mergeRequest, `gid://gitlab/User/${me.id}`) !== "REQUESTED_CHANGES") {
      throw new ReviewApiError(422, url, "GitLab did not confirm own REQUESTED_CHANGES reviewer state");
    }
    return "requested_changes";
  }

  private ownReviewState(
    mergeRequest: z.infer<typeof ReviewersSchema> | null,
    userId: string,
  ): string | null | undefined {
    const reviewer = mergeRequest?.reviewers.nodes.find((entry) => entry.id === userId);
    if (reviewer === undefined) return undefined;
    return reviewer.mergeRequestInteraction?.reviewState ?? null;
  }

  private unsupportedReviewStateSchema(errors: readonly string[]): boolean {
    return errors.length > 0 && errors.every((error) =>
      /^(?:Field ['"]reviewState['"] doesn't exist on type ['"]UserMergeRequestInteraction['"]|Field ['"]mergeRequestInteraction['"] doesn't exist on type ['"]MergeRequestReviewer['"]|Cannot query field ['"]reviewState['"] on type ['"]UserMergeRequestInteraction['"]|Cannot query field ['"]mergeRequestInteraction['"] on type ['"]MergeRequestReviewer['"])/i.test(error)
    );
  }

  private async hasNoNativeChangesMutations(signal?: AbortSignal): Promise<boolean> {
    // GitLab serves static introspection responses in production; omit required
    // mutation inputs so validation proves field availability without execution.
    const response = await this.graphql(
      "mutation { mergeRequestRequestChanges { errors } mergeRequestDestroyRequestedChanges { errors } }",
      {},
      signal,
    );
    if (response.data != null) return false;
    const missing = new Set<string>();
    for (const error of response.errors) {
      const field = /^(?:Field ['"](mergeRequestRequestChanges|mergeRequestDestroyRequestedChanges)['"] doesn't exist on type ['"]Mutation['"]|Cannot query field ['"](mergeRequestRequestChanges|mergeRequestDestroyRequestedChanges)['"] on type ['"]Mutation['"])/i.exec(error);
      if (field === null) return false;
      missing.add(field[1] ?? field[2] ?? "");
    }
    return missing.size === 2;
  }

  private async removeOwnRequestedChanges(
    project: string | number,
    iid: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const projectPath = await this.graphqlProjectPath(project, signal);
    const url = `${this.config.baseUrl}/api/graphql`;
    const response = await this.graphql(
      "query($projectPath: ID!, $iid: String!) { currentUser { id } project(fullPath: $projectPath) { mergeRequest(iid: $iid) { reviewers(first: 100) { nodes { id mergeRequestInteraction { reviewState } } } } } }",
      { projectPath, iid: String(iid) },
      signal,
    );
    if (this.unsupportedReviewStateSchema(response.errors)) {
      if (await this.hasNoNativeChangesMutations(signal)) {
        log.warn({ project, iid }, "GitLab native reviewer-state and request-changes mutations absent; skipping changes-request cleanup");
        return;
      }
      throw new ReviewApiError(422, url, "Cannot confirm own requested changes: native mutation schema exists");
    }
    if (response.errors.length > 0) throw new ReviewApiError(422, url, sanitizeErrorDetail(response.errors.join("; ")));
    const data = z.object({
      currentUser: z.object({ id: z.string() }).nullable(),
      project: z.object({ mergeRequest: ReviewersSchema.nullable() }).nullable(),
    }).parse(response.data);
    const currentUserId = data.currentUser?.id;
    const mergeRequest = data.project?.mergeRequest ?? null;
    if (currentUserId === undefined || mergeRequest === null) {
      throw new ReviewApiError(422, url, "Cannot determine own GitLab MR review state");
    }
    // A user absent from the reviewer list cannot hold a changes request.
    if (this.ownReviewState(mergeRequest, currentUserId) !== "REQUESTED_CHANGES") return;

    const removed = await this.graphql(
      "mutation($input: MergeRequestDestroyRequestedChangesInput!) { mergeRequestDestroyRequestedChanges(input: $input) { errors mergeRequest { reviewers(first: 100) { nodes { id mergeRequestInteraction { reviewState } } } } } }",
      { input: { projectPath, iid: String(iid) } },
      signal,
    );
    if (removed.errors.length > 0) throw new ReviewApiError(422, url, sanitizeErrorDetail(removed.errors.join("; ")));
    const result = z.object({ mergeRequestDestroyRequestedChanges: MutationSchema }).parse(removed.data).mergeRequestDestroyRequestedChanges;
    if (result.errors.length > 0) throw new ReviewApiError(422, url, sanitizeErrorDetail(result.errors.join("; ")));
    const clearedState = this.ownReviewState(result.mergeRequest, currentUserId);
    if (clearedState === undefined || clearedState === "REQUESTED_CHANGES") {
      throw new ReviewApiError(422, url, "GitLab did not confirm removal of own requested changes");
    }
  }

  /** Approve (or unapprove) the MR. Best-effort: approval may be unavailable on the GitLab tier. */
  private async approve(
    project: string | number,
    iid: number,
    approve: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.http.fetchJsonVoid(`${this.mrUrl(project, iid)}/${approve ? "approve" : "unapprove"}`, {
        method: "POST",
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted === true) throw signal.reason ?? err;
      log.warn({ project, iid, approve, err }, "GitLab MR approve/unapprove failed (non-fatal)");
    }
  }

  async getDiscussionThreads(changeId: ExternalChangeId, signal?: AbortSignal): Promise<ReviewDiscussionThread[]> {
    const { project, iid } = this.parseChange(changeId);
    const me = await this.resolveCurrentUsername(signal);
    const discussions = z
      .array(DiscussionSchema)
      .parse(await this.http.fetchJson(
        `${this.mrUrl(project, iid)}/discussions`,
        signal !== undefined ? { signal } : undefined,
      ));

    const threads: ReviewDiscussionThread[] = [];
    for (const d of discussions) {
      const notes = d.notes.filter((n) => !n.system);
      if (notes.length === 0) continue;

      const comments: ReviewDiscussionComment[] = notes.map((n) => ({
        author: n.author?.username ?? "unknown",
        message: n.body,
        isOwn: me !== null && n.author?.username === me,
      }));

      // A discussion is resolved only when it has resolvable notes and all of
      // them are resolved. Individual notes (non-resolvable) are never resolved.
      const resolvable = notes.filter((n) => n.resolvable);
      const resolved = resolvable.length > 0 && resolvable.every((n) => n.resolved);

      const anchor = notes.find((n) => n.position)?.position ?? null;
      const file = anchor?.new_path ?? anchor?.old_path ?? null;
      const line = anchor?.new_line ?? null;

      threads.push({
        threadId: d.id,
        file: file ?? null,
        line: line ?? null,
        resolved,
        comments,
      });
    }
    return threads;
  }

  async postThreadReply(
    changeId: ExternalChangeId,
    _revision: number,
    threadId: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const { project, iid } = this.parseChange(changeId);
    await this.http.fetchJsonVoid(
      `${this.mrUrl(project, iid)}/discussions/${encodeURIComponent(threadId)}/notes`,
      {
        method: "POST",
        body: JSON.stringify({ body: message }),
        ...(signal !== undefined ? { signal } : {}),
      }
    );
    log.info({ project, iid, threadId }, "posted GitLab MR discussion reply");
  }

  /** Resolve and cache VE's own GitLab identity. */
  private async resolveCurrentUser(signal?: AbortSignal): Promise<z.infer<typeof CurrentUserSchema> | null> {
    if (this.currentUser !== null) return this.currentUser;
    if (this.currentUserPromise !== undefined) return this.currentUserPromise;
    const lookup = (async (): Promise<z.infer<typeof CurrentUserSchema> | null> => {
      try {
        const me = CurrentUserSchema.parse(
          await this.http.fetchJson(
            `${this.config.baseUrl}/api/v4/user`,
            signal !== undefined ? { signal } : undefined,
          )
        );
        this.currentUser = me;
        return me;
      } catch (err) {
        if (signal?.aborted === true) throw signal.reason ?? err;
        log.warn({ err }, "failed to resolve GitLab current user; identity checks disabled");
        return null;
      }
    })();
    this.currentUserPromise = lookup.catch((err: unknown) => {
      this.currentUserPromise = undefined;
      throw err;
    });
    return this.currentUserPromise;
  }

  /** Resolve VE's own GitLab username (used to tag `isOwn` comments). */
  private async resolveCurrentUsername(signal?: AbortSignal): Promise<string | null> {
    return (await this.resolveCurrentUser(signal))?.username ?? null;
  }

  /** Resolve the project path-with-namespace for clone URL construction. */
  private async resolveProjectPath(
    project: string | number,
    mr: z.infer<typeof MrSchema>,
    signal?: AbortSignal,
  ): Promise<string> {
    const full = mr.references?.full;
    if (full && full.includes("!")) {
      const path = full.slice(0, full.indexOf("!"));
      if (path) return path;
    }
    if (typeof project === "string" && project.includes("/")) return project;
    try {
      const proj = ProjectSchema.parse(
        await this.http.fetchJson(
          `${this.config.baseUrl}/api/v4/projects/${this.projectRef(project)}`,
          signal !== undefined ? { signal } : undefined,
        )
      );
      return proj.path_with_namespace;
    } catch (err) {
      if (signal?.aborted === true) throw signal.reason ?? err;
      log.warn({ project, err }, "failed to resolve GitLab project path; using raw project ref");
      return String(project);
    }
  }
}

function mapFileStatus(ch: z.infer<typeof MrChangeSchema>): ReviewFileStatus {
  if (ch.new_file) return "added";
  if (ch.deleted_file) return "deleted";
  if (ch.renamed_file) return "renamed";
  return "modified";
}
