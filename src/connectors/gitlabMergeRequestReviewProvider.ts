/**
 * GitLab Merge Request review provider.
 *
 * Implements the integration-agnostic `ReviewProvider` interface against the
 * GitLab REST API so VE can act as a reviewer on merge requests: read the diff,
 * post inline discussion comments, post a summary note, and approve / unapprove.
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
} from "../interfaces.js";
import { getLogger } from "../logger.js";
import { GitLabHttpClient } from "./gitlabHttpClient.js";
import { ReviewApiError } from "../interfaces.js";
import { filterCommentsByAllowedFiles } from "../review/commentFilter.js";
import { patchsetFromRevisionSha } from "../review/revisionPatchset.js";
import { parsePatchNewLineNumbers } from "./githubReviewProvider.js";

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
  references: z.object({ full: z.string().optional() }).partial().optional(),
  diff_refs: DiffRefsSchema,
});

const MrChangeSchema = z.object({
  old_path: z.string(),
  new_path: z.string(),
  new_file: z.boolean().optional().default(false),
  renamed_file: z.boolean().optional().default(false),
  deleted_file: z.boolean().optional().default(false),
  diff: z.string().optional().default(""),
});

const MrChangesResponseSchema = z.object({
  changes: z.array(MrChangeSchema).optional().default([]),
  diff_refs: DiffRefsSchema,
});

const ProjectSchema = z.object({ path_with_namespace: z.string() });

const CurrentUserSchema = z.object({ id: z.number(), username: z.string() });

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
  private currentUsername: string | null = null;

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

  async getChangeDetails(changeId: ExternalChangeId): Promise<ReviewChangeDetails> {
    const { project, iid } = this.parseChange(changeId);
    const mr = MrSchema.parse(await this.http.fetchJson(this.mrUrl(project, iid)));

    const status: ReviewChangeDetails["status"] =
      mr.state === "merged"
        ? "MERGED"
        : mr.state === "closed" || mr.state === "locked"
          ? "ABANDONED"
          : "OPEN";

    const projectPath = await this.resolveProjectPath(project, mr);

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
    };
  }

  async getChangeDiff(changeId: ExternalChangeId, _patchset?: number): Promise<ReviewChangeDiff> {
    const { project, iid } = this.parseChange(changeId);
    const res = MrChangesResponseSchema.parse(
      await this.http.fetchJson(`${this.mrUrl(project, iid)}/changes`)
    );

    return {
      changeId,
      patchset: 1,
      files: res.changes.map(
        (ch): ReviewDiffFile => ({
          path: ch.new_path || ch.old_path,
          status: mapFileStatus(ch),
          patch: ch.diff,
        })
      ),
    };
  }

  async postReviewComments(
    changeId: ExternalChangeId,
    _revision: number,
    comments: InlineReviewComment[],
    summary: string,
    allowedFiles?: ReadonlySet<string>
  ): Promise<void> {
    await this.submitReview(changeId, comments, summary, undefined, allowedFiles);
  }

  async postReviewWithComments(
    changeId: ExternalChangeId,
    _revision: number,
    comments: InlineReviewComment[],
    summary: string,
    score: -1 | 1,
    allowedFiles?: ReadonlySet<string>
  ): Promise<void> {
    await this.submitReview(changeId, comments, summary, score, allowedFiles);
  }

  async vote(
    changeId: ExternalChangeId,
    _revision: number,
    score: number,
    message?: string
  ): Promise<void> {
    await this.submitReview(changeId, [], message ?? "", score < 0 ? -1 : score > 0 ? 1 : 0);
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
    allowedFiles?: ReadonlySet<string>
  ): Promise<void> {
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
    const validLinesByFile = new Map<string, Set<number>>();
    if (positiveLine.length > 0) {
      try {
        const res = MrChangesResponseSchema.parse(
          await this.http.fetchJson(`${this.mrUrl(project, iid)}/changes`)
        );
        diffRefs = res.diff_refs ?? null;
        for (const ch of res.changes) {
          if (ch.diff) validLinesByFile.set(ch.new_path || ch.old_path, parsePatchNewLineNumbers(ch.diff));
        }
      } catch (err) {
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
      const validLines = validLinesByFile.get(c.file);
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
              old_path: c.file,
            },
          }),
        });
      } catch (err) {
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
      });
    }

    if (score === 1) await this.approve(project, iid, true);
    else if (score === -1) await this.approve(project, iid, false);

    log.info(
      { project, iid, inlineCount: inline.length, foldedCount: outOfDiff.length, score },
      "posted GitLab MR review"
    );
  }

  /** Approve (or unapprove) the MR. Best-effort: approval may be unavailable on the GitLab tier. */
  private async approve(project: string | number, iid: number, approve: boolean): Promise<void> {
    try {
      await this.http.fetchJsonVoid(`${this.mrUrl(project, iid)}/${approve ? "approve" : "unapprove"}`, {
        method: "POST",
      });
    } catch (err) {
      log.warn({ project, iid, approve, err }, "GitLab MR approve/unapprove failed (non-fatal)");
    }
  }

  async getDiscussionThreads(changeId: ExternalChangeId): Promise<ReviewDiscussionThread[]> {
    const { project, iid } = this.parseChange(changeId);
    const me = await this.resolveCurrentUsername();
    const discussions = z
      .array(DiscussionSchema)
      .parse(await this.http.fetchJson(`${this.mrUrl(project, iid)}/discussions`));

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
    message: string
  ): Promise<void> {
    const { project, iid } = this.parseChange(changeId);
    await this.http.fetchJsonVoid(
      `${this.mrUrl(project, iid)}/discussions/${encodeURIComponent(threadId)}/notes`,
      {
        method: "POST",
        body: JSON.stringify({ body: message }),
      }
    );
    log.info({ project, iid, threadId }, "posted GitLab MR discussion reply");
  }

  /** Resolve and cache VE's own GitLab username (used to tag `isOwn` comments). */
  private async resolveCurrentUsername(): Promise<string | null> {
    if (this.currentUsername !== null) return this.currentUsername;
    try {
      const me = CurrentUserSchema.parse(
        await this.http.fetchJson(`${this.config.baseUrl}/api/v4/user`)
      );
      this.currentUsername = me.username;
      return this.currentUsername;
    } catch (err) {
      log.warn({ err }, "failed to resolve GitLab current user; isOwn tagging disabled");
      return null;
    }
  }

  /** Resolve the project path-with-namespace for clone URL construction. */
  private async resolveProjectPath(
    project: string | number,
    mr: z.infer<typeof MrSchema>
  ): Promise<string> {
    const full = mr.references?.full;
    if (full && full.includes("!")) {
      const path = full.slice(0, full.indexOf("!"));
      if (path) return path;
    }
    if (typeof project === "string" && project.includes("/")) return project;
    try {
      const proj = ProjectSchema.parse(
        await this.http.fetchJson(`${this.config.baseUrl}/api/v4/projects/${this.projectRef(project)}`)
      );
      return proj.path_with_namespace;
    } catch (err) {
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
