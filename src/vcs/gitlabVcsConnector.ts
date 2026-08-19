/**
 * GitLabVcsConnector — HTTP-based clone and push for GitLab.
 * Clone uses token in `.git-credentials`; push creates or updates a merge request via the REST API.
 */

import { getLogger } from "../logger.js";
import type { VcsConnector, VcsPushResult } from "./vcsConnector.js";
import { buildFeatureBranchRef } from "./branchNaming.js";
import type { ReviewComment } from "../interfaces.js";
import { ReviewApiError } from "../interfaces.js";
import { GitLabHttpClient } from "../connectors/gitlabHttpClient.js";
import { redactUrls, sanitizeErrorDetail } from "../utils/redactUrl.js";
import type { GitRunner } from "./gitRunner.js";
import { NodeGitRunner } from "./nodeGitRunner.js";

const log = getLogger("gitlab-vcs");

export interface GitLabVcsConnectorConfig {
  baseUrl: string;
  projectId: string | number;
  token: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  /** Target branch for MR creation. Defaults to "main". */
  targetBranch?: string;
}

export class GitLabVcsConnector implements VcsConnector {
  readonly useChangeIdContinuity = false;
  readonly reviewSystemLabel = "gitlab";

  private readonly httpClient: GitLabHttpClient;

  constructor(
    private readonly config: GitLabVcsConnectorConfig,
    private readonly gitRunner: GitRunner = new NodeGitRunner()
  ) {
    this.httpClient = new GitLabHttpClient(
      config.token,
      (statusCode, url, body) => new ReviewApiError(statusCode, url, body)
    );
  }

  buildPushSpec(_baseBranch: string, taskId: string, ticketTitle?: string | null): { ref: string; topic?: string } {
    return { ref: buildFeatureBranchRef(taskId, ticketTitle ?? null) };
  }

  /** Clone a GitLab repository via HTTP into the target directory. */
  async clone(repoUrl: string, branch: string, targetDir: string): Promise<void> {
    log.info(
      { repoUrl: redactUrls(repoUrl), branch, targetDir },
      "cloning repository from GitLab via HTTP"
    );

    try {
      await this.gitRunner.run(
        ["clone", "--branch", branch, "--depth", "1", repoUrl, targetDir],
        { cwd: process.cwd(), timeoutMs: 300_000 }
      );

      log.info({ targetDir }, "repository cloned successfully");
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(
        `Failed to clone GitLab repository: ${sanitizeErrorDetail(error.message)}`
      );
    }
  }

  /**
   * Push HEAD directly to GitLab without creating a new commit on the host.
   * Used when the agent has already created commits inside the container.
   * Force-pushes the branch and creates/finds the MR.
   */
  async pushDirect(
    repoDir: string,
    ref: string,
    _topic?: string,
    reviewerEmails?: string[]
  ): Promise<VcsPushResult> {
    log.info({ repoDir, ref }, "pushing HEAD directly to GitLab (agent-created commits)");

    try {
      const featureBranch = ref;

      // Configure HTTP credentials for push
      const remoteUrl = (
        await this.gitRunner.run(["remote", "get-url", "origin"], { cwd: repoDir })
      ).stdout.trim();
      const authenticatedUrl = new URL(remoteUrl);
      authenticatedUrl.username = "oauth2";
      authenticatedUrl.password = this.config.token;
      await this.gitRunner.run(
        ["remote", "set-url", "origin", authenticatedUrl.toString()],
        { cwd: repoDir }
      );

      try {
        // Create the branch from HEAD and force-push (allows retry with amended commits)
        await this.gitRunner.run(["checkout", "-B", featureBranch], { cwd: repoDir });
        await this.gitRunner.run(["push", "--force", "-u", "origin", featureBranch], {
          cwd: repoDir,
          timeoutMs: 300_000,
        });
        log.info({ featureBranch }, "direct push to GitLab completed");
      } finally {
        // Always reset remote URL to avoid leaking token on push failure
        await this.gitRunner.run(["remote", "set-url", "origin", remoteUrl], { cwd: repoDir });
      }

      // Create or find existing MR
      const headSubject = (
        await this.gitRunner.run(["log", "-1", "--format=%s"], { cwd: repoDir })
      ).stdout.trim();
      const mr = await this.createOrFindMergeRequest(
        featureBranch,
        this.config.targetBranch ?? "main",
        headSubject || `[VE] Feature branch ${featureBranch}`,
        reviewerEmails
      );

      const mrIid = String(mr["iid"]);
      const mrUrl = (mr["web_url"] as string)
        || `${this.config.baseUrl}/project/${this.config.projectId}/-/merge_requests/${mrIid}`;

      return {
        changeId: mrIid,
        url: mrUrl,
        status: "OPEN",
      };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(`Failed to push directly to GitLab: ${sanitizeErrorDetail(error.message)}`);
    }
  }

  /**
   * Get the current status of a GitLab Merge Request.
   */
  async getChangeStatus(changeId: string): Promise<string> {
    try {
      const mrIid = String(changeId);
      const url = `${this.config.baseUrl}/api/v4/projects/${encodeURIComponent(String(this.config.projectId))}/merge_requests/${mrIid}`;
      const mr = await this.httpClient.fetchJson<{ state: string }>(url);

      const state = mr.state;
      return state.toUpperCase();
    } catch (err: unknown) {
      log.warn(
        { changeId, err: err instanceof Error ? err.message : String(err) },
        "failed to fetch MR status"
      );
      return "UNKNOWN";
    }
  }

  /**
   * Resolve reviewer emails to GitLab user IDs via the Users API. Unmatched
   * emails are skipped with a warning — GitLab's `reviewer_ids` field only
   * accepts numeric user IDs, not emails.
   */
  private async resolveReviewerIds(emails?: string[]): Promise<number[]> {
    if (!emails || emails.length === 0) return [];
    const ids = new Set<number>();
    for (const email of emails) {
      try {
        const url = `${this.config.baseUrl}/api/v4/users?search=${encodeURIComponent(email)}`;
        const users = await this.httpClient.fetchJson<Array<{
          id: number;
          email?: string;
          public_email?: string;
        }>>(url);
        const normalizedEmail = email.toLowerCase();
        const match = users.find((user) =>
          user.email?.toLowerCase() === normalizedEmail
          || user.public_email?.toLowerCase() === normalizedEmail
        );
        if (match) ids.add(match.id);
        else log.warn({ email }, "no exact GitLab user match for reviewer email — skipping");
      } catch (err: unknown) {
        log.warn({ email, err: err instanceof Error ? err.message : String(err) }, "failed to resolve reviewer email to GitLab user");
      }
    }
    return [...ids];
  }

  /**
   * Create a new MR or find existing one for the given branches.
   */
  private async createOrFindMergeRequest(
    sourceBranch: string,
    targetBranch: string,
    title: string,
    reviewerEmails?: string[]
  ): Promise<Record<string, unknown>> {
    const reviewerIds = await this.resolveReviewerIds(reviewerEmails);
    const mrBody = {
      source_branch: sourceBranch,
      target_branch: targetBranch,
      title,
      description: `Automated MR created by Virtual Engineer`,
      remove_source_branch: false,
      ...(reviewerIds.length > 0 ? { reviewer_ids: reviewerIds } : {}),
    };

    const createUrl = `${this.config.baseUrl}/api/v4/projects/${encodeURIComponent(String(this.config.projectId))}/merge_requests`;
    try {
      // Try to create new MR
      const result = await this.httpClient.fetchJson<Record<string, unknown>>(createUrl, {
        method: "POST",
        body: JSON.stringify(mrBody),
      });
      return result;
    } catch (err: unknown) {
      // If MR already exists (409 conflict), find and return it
      if (err instanceof ReviewApiError && err.statusCode === 409) {
        log.info({ sourceBranch }, "MR already exists, finding it");
        const existing = await this.findExistingMergeRequest(sourceBranch, targetBranch);
        if (reviewerIds.length === 0) return existing;

        const mrIid = existing["iid"];
        if (typeof mrIid !== "number" && typeof mrIid !== "string") {
          throw new Error("Existing Merge Request response did not include an IID");
        }
        return this.httpClient.fetchJson<Record<string, unknown>>(
          `${createUrl}/${encodeURIComponent(String(mrIid))}`,
          {
            method: "PUT",
            body: JSON.stringify({ reviewer_ids: reviewerIds }),
          }
        );
      }

      const error = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to create Merge Request: ${error}`);
    }
  }

  /**
   * Find an existing open MR for the given branches.
   */
  private async findExistingMergeRequest(
    sourceBranch: string,
    targetBranch: string
  ): Promise<Record<string, unknown>> {
    const query = `state=opened&source_branch=${encodeURIComponent(sourceBranch)}&target_branch=${encodeURIComponent(targetBranch)}`;

    const url = `${this.config.baseUrl}/api/v4/projects/${encodeURIComponent(String(this.config.projectId))}/merge_requests?${query}`;
    const result = await this.httpClient.fetchJson<Record<string, unknown>[]>(url);

    const mrs = Array.isArray(result) ? result : [];
    if (mrs.length > 0) {
      // Length guard above ensures element exists; non-null assertion safe here.
      return mrs[0]!;
    }

    throw new Error(`No open MR found for branches ${sourceBranch} → ${targetBranch}`);
  }

  /**
   * Fetch unresolved review comment threads for a GitLab MR.
   * changeId is the MR IID (within-project integer) as a string.
   */
  async getUnresolvedComments(changeId: string): Promise<ReviewComment[]> {
    const mrNumber = parseInt(changeId, 10);
    if (isNaN(mrNumber) || mrNumber <= 0) {
      log.warn({ changeId }, "invalid MR IID for getUnresolvedComments");
      return [];
    }
    try {
      const url = `${this.config.baseUrl}/api/v4/projects/${encodeURIComponent(String(this.config.projectId))}/merge_requests/${mrNumber}/discussions`;
      const discussions = await this.httpClient.fetchJson<unknown[]>(url);
      const list = Array.isArray(discussions) ? discussions as Array<{
        id: string;
        resolved?: boolean;
        notes?: Array<{
          id: number;
          system?: boolean;
          author?: { username?: string };
          body?: string;
          updated_at?: string;
          position?: { new_path?: string; new_line?: number };
        }>;
      }> : [];

      const result: ReviewComment[] = [];
      for (const discussion of list) {
        if (discussion.resolved) continue;
        const note = discussion.notes?.find((n) => !n.system);
        if (!note) continue;
        const position = note.position ?? discussion.notes?.[0]?.position;
        result.push({
          id: discussion.id,
          author: note.author?.username ?? "unknown",
          message: note.body ?? "",
          filePath: position?.new_path,
          line: position?.new_line,
          unresolved: true,
          patchset: 0,
          updatedAt: new Date(note.updated_at ?? Date.now()),
        });
      }
      log.debug({ changeId, count: result.length }, "fetched unresolved GitLab MR discussions");
      return result;
    } catch (err) {
      log.warn({ changeId, err }, "failed to fetch GitLab MR discussions (non-fatal)");
      return [];
    }
  }

  /**
   * Resolve GitLab MR discussion threads by ID.
   * changeId is the MR IID (within-project integer) as a string.
   */
  async resolveComments(changeId: string, comments: ReviewComment[]): Promise<void> {
    if (comments.length === 0) return;
    const mrNumber = parseInt(changeId, 10);
    if (isNaN(mrNumber) || mrNumber <= 0) {
      log.warn({ changeId }, "invalid MR IID for resolveComments");
      return;
    }
    try {
      for (const comment of comments) {
        const url = `${this.config.baseUrl}/api/v4/projects/${encodeURIComponent(String(this.config.projectId))}/merge_requests/${mrNumber}/discussions/${comment.id}`;
        await this.httpClient.fetchJsonVoid(url, {
          method: "PUT",
          body: JSON.stringify({ resolved: true }),
        });
      }
      log.info({ changeId, count: comments.length }, "resolved GitLab MR discussions");
    } catch (err) {
      log.warn({ changeId, err }, "failed to resolve GitLab MR discussions (non-fatal)");
    }
  }
}
