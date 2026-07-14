/**
 * GitLabVcsConnector — HTTP-based clone and push for GitLab.
 * Clone uses token in `.git-credentials`; push creates or updates a merge request via the REST API.
 */

import { execFileSync } from "child_process";
import { getLogger } from "../logger.js";
import { execGit, trustedGitArgs, trustedGitEnv } from "../utils/gitExec.js";
import type { VcsConnector, VcsPushResult } from "./vcsConnector.js";
import { buildFeatureBranchRef } from "./branchNaming.js";
import type { ReviewComment } from "../interfaces.js";
import { ReviewApiError } from "../interfaces.js";
import { GitLabHttpClient } from "../connectors/gitlabHttpClient.js";
import { redactUrls } from "../utils/redactUrl.js";

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

  constructor(private readonly config: GitLabVcsConnectorConfig) {
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
      { repoUrl, branch, targetDir },
      "cloning repository from GitLab via HTTP"
    );

    try {
      execFileSync("git", trustedGitArgs(["clone", "--branch", branch, "--depth", "1", repoUrl, targetDir]), {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 300_000,
        env: trustedGitEnv(),
      });

      log.info({ targetDir }, "repository cloned successfully");
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(
        `Failed to clone GitLab repository: ${error.message.slice(0, 300)}`
      );
    }
  }

  /**
   * Push changes to GitLab via HTTP and create/update a Merge Request.
   */
  async push(
    repoDir: string,
    ref: string,
    message: string,
    changeId?: string
  ): Promise<VcsPushResult> {
    log.info(
      { repoDir, ref, changeId },
      "preparing to push to GitLab"
    );

    try {
      // Configure git identity
      execGit(["config", "user.name", this.config.gitAuthorName], repoDir);
      execGit(["config", "user.email", this.config.gitAuthorEmail], repoDir);

      // The `ref` parameter is typically the feature branch name for GitLab
      // (unlike Gerrit's refs/for/main)
      const featureBranch = ref;

      // Configure HTTP credentials for push
      // GitLab expects oauth2:<token>@host URL credentials
      const remoteUrl = execGit(["remote", "get-url", "origin"], repoDir).trim();
      const authenticatedUrl = new URL(remoteUrl);
      authenticatedUrl.username = "oauth2";
      authenticatedUrl.password = this.config.token;

      execGit(["remote", "set-url", "origin", authenticatedUrl.toString()], repoDir);

      // Stage and commit changes
      execGit(["add", "-A"], repoDir);
      execGit(["commit", "-m", message], repoDir);
      log.info({ repoDir }, "changes committed");

      try {
        // Push the feature branch
        execGit(["push", "-u", "origin", featureBranch], repoDir);
        log.info({ featureBranch }, "pushed to GitLab");
      } finally {
        // Always reset remote URL to original (avoid leaking token in logs or on failure)
        execGit(["remote", "set-url", "origin", remoteUrl], repoDir);
      }

      // Create or find existing MR
      const mr = await this.createOrFindMergeRequest(
        featureBranch,
        this.config.targetBranch ?? "main",
        message.split("\n")[0] || `[VE] Feature branch ${featureBranch}`
      );

      const mrIid = String(mr["iid"]);
      const mrUrl = (mr["web_url"] as string)
        || `${this.config.baseUrl}/project/${this.config.projectId}/-/merge_requests/${mrIid}`;

      log.info({ mrIid, mrUrl }, "merge request created/updated");

      return {
        changeId: mrIid,
        url: mrUrl,
        status: "OPEN",
      };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(`Failed to push to GitLab: ${redactUrls(error.message.slice(0, 500))}`);
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
    _topic?: string
  ): Promise<VcsPushResult> {
    log.info({ repoDir, ref }, "pushing HEAD directly to GitLab (agent-created commits)");

    try {
      const featureBranch = ref;

      // Configure HTTP credentials for push
      const remoteUrl = execGit(["remote", "get-url", "origin"], repoDir).trim();
      const authenticatedUrl = new URL(remoteUrl);
      authenticatedUrl.username = "oauth2";
      authenticatedUrl.password = this.config.token;
      execGit(["remote", "set-url", "origin", authenticatedUrl.toString()], repoDir);

      try {
        // Create the branch from HEAD and force-push (allows retry with amended commits)
        execGit(["checkout", "-B", featureBranch], repoDir);
        execGit(["push", "--force", "-u", "origin", featureBranch], repoDir);
        log.info({ featureBranch }, "direct push to GitLab completed");
      } finally {
        // Always reset remote URL to avoid leaking token on push failure
        execGit(["remote", "set-url", "origin", remoteUrl], repoDir);
      }

      // Create or find existing MR
      const headSubject = execGit(["log", "-1", "--format=%s"], repoDir).trim();
      const mr = await this.createOrFindMergeRequest(
        featureBranch,
        this.config.targetBranch ?? "main",
        headSubject || `[VE] Feature branch ${featureBranch}`
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
      throw new Error(`Failed to push directly to GitLab: ${redactUrls(error.message.slice(0, 500))}`);
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
   * Create a new MR or find existing one for the given branches.
   */
  private async createOrFindMergeRequest(
    sourceBranch: string,
    targetBranch: string,
    title: string
  ): Promise<Record<string, unknown>> {
    const mrBody = {
      source_branch: sourceBranch,
      target_branch: targetBranch,
      title,
      description: `Automated MR created by Virtual Engineer`,
      remove_source_branch: false,
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
        return this.findExistingMergeRequest(sourceBranch, targetBranch);
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
