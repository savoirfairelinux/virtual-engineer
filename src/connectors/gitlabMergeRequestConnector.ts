/**
 * GitLab Merge Request connector — implements `ReviewConnector` via the GitLab REST API.
 * DB columns named `gerrit_change_id` store the MR IID when this connector is active.
 */
import { z } from "zod";
import type {
  DiscoveredRepository,
  ReviewConnector,
  ReviewChangeRef,
  ReviewChangeStatus,
  ReviewComment,
  ExternalChangeId,
} from "../interfaces.js";
import { ReviewApiError, ReviewNotFoundError } from "../interfaces.js";
import { GitLabHttpClient } from "./gitlabHttpClient.js";
import { getLogger } from "../logger.js";

const log = getLogger("gitlab-mr-connector");

// ─── Zod schemas for GitLab MR / Discussion API responses ────────────────────

const GitLabMrSchema = z.object({
  iid: z.number(),
  state: z.string(),
  web_url: z.string(),
  title: z.string(),
  source_branch: z.string(),
});

const GitLabNoteSchema = z.object({
  id: z.number(),
  author: z.object({ id: z.number(), username: z.string() }),
  body: z.string(),
  system: z.boolean().default(false),
  resolved: z.boolean().optional(),
  updated_at: z.string(),
  position: z
    .object({
      new_path: z.string().optional(),
      new_line: z.number().optional(),
    })
    .optional(),
});

const GitLabDiscussionSchema = z.object({
  id: z.string(),
  individual_note: z.boolean(),
  resolved: z.boolean().optional().default(false),
  notes: z.array(GitLabNoteSchema),
});

const GitLabDiscussionsResponseSchema = z.array(GitLabDiscussionSchema);

const GitLabProjectRepoSchema = z.object({
  id: z.number(),
  name: z.string(),
  path_with_namespace: z.string(),
  ssh_url_to_repo: z.string().optional(),
  http_url_to_repo: z.string().optional(),
  default_branch: z.string().nullable().optional(),
  web_url: z.string(),
});

const GitLabRepoListResponseSchema = z.array(GitLabProjectRepoSchema);

// ─── Config ───────────────────────────────────────────────────────────────────

export interface GitLabMergeRequestConnectorConfig {
  baseUrl: string;
  projectId: string | number;
  token: string;
}

// ─── Connector implementation ─────────────────────────────────────────────────

/**
 * GitLabMergeRequestConnector — implements the ReviewConnector interface
 * against GitLab Merge Requests.
 *
 * changeId convention: the GitLab MR IID (within-project integer) stored as
 * a string, e.g. "42".
 */
export class GitLabMergeRequestConnector implements ReviewConnector {
  private readonly http: GitLabHttpClient;

  constructor(private readonly config: GitLabMergeRequestConnectorConfig) {
    this.http = new GitLabHttpClient(config.token, createGitLabMrError);
  }

  /** Fetch basic MR ref info (number, patchset placeholder, URL) for a given change ID. */
  async getChange(changeId: ExternalChangeId): Promise<ReviewChangeRef> {
    const mrNumber = this.parseMrNumber(String(changeId));
    const mr = GitLabMrSchema.parse(await this.http.fetchJson(this.mrUrl(mrNumber)));

    return {
      changeId,
      changeNumber: mr.iid,
      patchsetNumber: 1, // GitLab doesn't have patchsets; always 1
      url: mr.web_url,
    };
  }

  /** Return the current open/merged/abandoned status of the GitLab MR. */
  async getChangeStatus(changeId: ExternalChangeId): Promise<ReviewChangeStatus> {
    const mrNumber = this.parseMrNumber(String(changeId));
    const mr = GitLabMrSchema.parse(await this.http.fetchJson(this.mrUrl(mrNumber)));

    switch (mr.state) {
      case "merged":
        return "MERGED";
      case "closed":
      case "locked":
        return "ABANDONED";
      default:
        return "OPEN";
    }
  }

  /** Fetch all unresolved discussion threads on the GitLab MR. */
  async getUnresolvedComments(
    changeId: ExternalChangeId,
    // GitLab doesn't have patchsets — sincePatchset is ignored
    _sincePatchset?: number
  ): Promise<ReviewComment[]> {
    const mrNumber = this.parseMrNumber(String(changeId));
    const url = `${this.config.baseUrl}/api/v4/projects/${this.config.projectId}/merge_requests/${mrNumber}/discussions`;
    const discussions = GitLabDiscussionsResponseSchema.parse(await this.http.fetchJson(url));

    const comments: ReviewComment[] = [];

    for (const discussion of discussions) {
      if (discussion.resolved) continue;

      // Find the first non-system note in the discussion
      const note = discussion.notes.find((n) => !n.system);
      if (!note) continue;

      const position = note.position ?? discussion.notes[0]?.position;
      comments.push({
        id: discussion.id,
        author: note.author.username,
        message: note.body,
        filePath: position?.new_path,
        line: position?.new_line,
        unresolved: true,
        patchset: 0,
        updatedAt: new Date(note.updated_at),
      });
    }

    log.info({ changeId, count: comments.length }, "fetched unresolved GitLab MR discussions");
    return comments;
  }

  /** Post a top-level note on the GitLab MR. */
  async addChangeComment(changeId: ExternalChangeId, message: string): Promise<void> {
    const mrNumber = this.parseMrNumber(String(changeId));
    await this.http.fetchJsonVoid(
      `${this.config.baseUrl}/api/v4/projects/${this.config.projectId}/merge_requests/${mrNumber}/notes`,
      {
        method: "POST",
        body: JSON.stringify({ body: message }),
      }
    );
    log.info({ changeId }, "added comment to GitLab MR");
  }

  /** Mark the given discussion threads as resolved via the GitLab Discussions API. */
  async resolveComments(changeId: ExternalChangeId, comments: ReviewComment[]): Promise<void> {
    if (comments.length === 0) return;

    const mrNumber = this.parseMrNumber(String(changeId));

    for (const comment of comments) {
      const discussionId = comment.id;

      // Mark the discussion as resolved
      await this.http.fetchJsonVoid(
        `${this.config.baseUrl}/api/v4/projects/${this.config.projectId}/merge_requests/${mrNumber}/discussions/${discussionId}/resolve`,
        {
          method: "PUT",
          body: JSON.stringify({ resolved: true }),
        }
      );
    }

    log.info({ changeId, count: comments.length }, "resolved GitLab MR discussions");
  }

  /**
   * Discovery: list every GitLab project the current token has membership on.
   * The MR connector exposes them as repositories (push targets).
   */
  async listRepositories(): Promise<DiscoveredRepository[]> {
    const all: DiscoveredRepository[] = [];
    let page = 1;

    while (true) {
      const url = new URL(`${this.config.baseUrl}/api/v4/projects`);
      url.searchParams.set("membership", "true");
      url.searchParams.set("simple", "true");
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));

      const { body, nextPage } = await this.http.fetchPaginated(url.toString());
      const projects = GitLabRepoListResponseSchema.parse(body);

      for (const project of projects) {
        const repo: DiscoveredRepository = {
          key: project.path_with_namespace,
          name: project.name,
          webUrl: project.web_url,
        };
        if (project.ssh_url_to_repo) repo.cloneUrlSsh = project.ssh_url_to_repo;
        if (project.http_url_to_repo) repo.cloneUrlHttp = project.http_url_to_repo;
        if (project.default_branch) repo.defaultBranch = project.default_branch;
        all.push(repo);
      }

      if (!nextPage) break;
      page = nextPage;
    }

    log.debug({ count: all.length }, "discovered GitLab repositories");
    return all;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** Build the GitLab REST API URL for a specific MR by number. */
  private mrUrl(mrNumber: number): string {
    return `${this.config.baseUrl}/api/v4/projects/${this.config.projectId}/merge_requests/${mrNumber}`;
  }

  /** Parse and validate a GitLab MR IID string into a positive integer. */
  private parseMrNumber(changeId: string): number {
    const n = parseInt(changeId, 10);
    if (isNaN(n) || n <= 0) {
      throw new Error(`Invalid GitLab MR number: "${changeId}"`);
    }
    return n;
  }

}

export class GitLabMrApiError extends ReviewApiError {
  constructor(
    statusCode: number,
    url: string,
    body: string
  ) {
    super(statusCode, url, body);
    this.name = "GitLabMrApiError";
  }
}

export class GitLabMrNotFoundError extends ReviewNotFoundError {
  constructor(statusCode: number, url: string, body: string) {
    super(statusCode, url, body);
    this.name = "GitLabMrNotFoundError";
  }
}

/** Create a typed GitLab MR API error, using GitLabMrNotFoundError for 404 responses. */
function createGitLabMrError(statusCode: number, url: string, body: string): ReviewApiError {
  if (statusCode === 404) {
    return new GitLabMrNotFoundError(statusCode, url, body);
  }
  return new GitLabMrApiError(statusCode, url, body);
}
