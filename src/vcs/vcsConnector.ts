/**
 * VCS Connector — abstract interface for version control system operations.
 * Handles repository clone and push operations on the host side.
 *
 * Implementations:
 * - GerritVcsConnector: SSH-based clone/push to Gerrit
 * - GitLabVcsConnector: HTTP-based clone/push + MR creation
 *
 * Key principle: All VCS credentials stay on the host. The container
 * receives a pre-cloned repository and never interacts with the VCS.
 */
import type { PatchsetCheckoutOptions, ReviewChangeStatus, ReviewComment, ReviewSystem } from "../interfaces.js";

/**
 * Result of a push operation.
 * Represents the change/MR that was created or updated.
 */
export interface VcsPushResult {
  /** Native review identifier: Gerrit Change-Id, GitHub PR number, or GitLab MR IID. */
  changeId: string;
  /** HTTP URL to view the change/MR */
  url: string;
  /** Current status in the shared review vocabulary. */
  status: ReviewChangeStatus;
}

/**
 * A review found by its source branch, with the target branch it was opened against.
 */
export interface ExistingReview extends VcsPushResult {
  targetBranch: string;
}

/**
 * VcsConnector — abstract interface for version control operations.
 */
export interface VcsConnector {
  /**
   * Clone a repository to the target directory on the host.
   * @param repoUrl The repository clone URL (may be SSH or HTTP depending on VCS)
   * @param branch The branch to clone (e.g., "main")
   * @param targetDir Absolute path where repo will be cloned
   * @param sshKeyPath Optional SSH key path to use instead of the default. Only used for SSH-based connectors (e.g., Gerrit).
   * @throws {Error} If clone fails
   */
  clone(repoUrl: string, branch: string, targetDir: string, sshKeyPath?: string): Promise<void>;

  /**
   * Push HEAD directly to the VCS without creating a new commit on the host.
   * Used when the agent has already created commits inside the container.
   * For Gerrit: pushes N commits in the range, each becoming a separate change.
   * For GitLab: pushes the branch (force-push on retry).
   *
   * @param repoDir Absolute path to the cloned repository
   * @param ref The push reference (e.g., "refs/for/main" for Gerrit, "feature-branch" for GitLab)
   * @param topic Optional topic to group related changes (Gerrit only)
   * @returns Push result with changeId, URL, and status
   * @throws {Error} If push fails
   */
  pushDirect?(
    repoDir: string,
    ref: string,
    topic?: string,
    reviewerEmails?: string[]
  ): Promise<VcsPushResult>;

  /**
   * Read-only lookup of the review opened from `sourceBranch` in the bound
   * repository, across every target branch and state; never pushes or creates
   * one. Returns null if none exists and throws when several exist, since a
   * target-branch filter could otherwise hide the original review.
   */
  findExistingReview?(sourceBranch: string): Promise<ExistingReview | null>;

  /**
   * Get the current status of a change/MR.
   * @param changeId The Gerrit Change-Id, GitHub PR number, or GitLab MR IID
   * @returns Normalized status: "OPEN", "MERGED", or "ABANDONED"
   * @throws {Error} If status cannot be determined
   */
  getChangeStatus(changeId: string): Promise<ReviewChangeStatus>;

  /**
   * Fetch unresolved review comments for a change.
   * Optional — only implemented by connectors that support inline comments
   * (Gerrit, GitLab MR). Without it, review progress reads comments through the
   * code_review connector bound to the change's repository (GitHub).
   */
  getUnresolvedComments?(changeId: string): Promise<ReviewComment[]>;

  /**
   * Mark review comments as resolved.
   * Optional — only implemented by connectors that support it (Gerrit, GitLab MR);
   * otherwise the repository-bound code_review connector resolves them.
   */
  resolveComments?(changeId: string, comments: ReviewComment[]): Promise<void>;

  /**
   * Compute the push destination spec for this connector's protocol.
   * Called once per task cycle; result drives both the agent session
   * configuration and the host-side push. The orchestrator never interprets
   * the returned ref or topic — it passes them through verbatim.
   * @param baseBranch The base/target branch (e.g. "main")
   * @param taskId The task identifier used for unique branch or topic names
   * @param ticketTitle Optional ticket title; connectors that produce branch refs may use it to build a human-readable slug. Connectors that ignore branch names (Gerrit) must ignore this parameter.
   */
  buildPushSpec(baseBranch: string, taskId: string, ticketTitle?: string | null): { ref: string; topic?: string };

  /**
   * Whether this connector's review system uses Change-Id trailers for
   * change continuity across amend/rebase cycles (Gerrit) vs. branch-based
   * identity (GitLab MR). When true the orchestrator populates
   * existingChangeId and perRepoChangeIds in the agent session; when false
   * it omits them. Push persistence follows the same capability: true stores
   * one change per commit; false stores the single native push result.
   */
  readonly useChangeIdContinuity: boolean;

  /**
   * Opaque label persisted in change_per_repository.review_system.
   * Connector-declared — the orchestrator never reads this for control flow.
   */
  readonly reviewSystemLabel: ReviewSystem;

  /** Optional path to a known_hosts file used by this connector's SSH transport. */
  readonly sshKnownHostsPath?: string | undefined;

  /** Optional path to the SSH private key used by this connector's transport (Gerrit / SSH-based only). */
  readonly sshKeyPath?: string | undefined;

  /**
   * Resolve a Change-Id to patchset options for WorkspaceRunner.applyPriorPatchset().
   * Only implemented by connectors that use Change-Id continuity (Gerrit).
   */
  resolvePatchsetOptions?(changeId: string): Promise<PatchsetCheckoutOptions>;

  /**
   * Best-effort lookup of the real name/email this connector's credentials
   * authenticate as, so commit authorship matches the actual pushing account
   * instead of a static placeholder. Only implemented by connectors that can
   * derive identity from their existing credentials (Gerrit, via SSH).
   * Returns `undefined` when the lookup isn't supported or fails.
   */
  queryAuthorIdentity?(): Promise<{ name: string; email: string } | undefined>;
}

/**
 * Sentinel value for review_system in change_per_repository rows where no
 * push occurred (status = "NO_CHANGE"). Distinct from any real connector
 * reviewSystemLabel so queries filtering by provider are unaffected.
 */
export const NO_REVIEW_SYSTEM = "none" as const;

/**
 * VcsConnectorConfig — base configuration for all VCS connectors.
 * Implementations may extend this with provider-specific fields.
 */
export interface VcsConnectorConfig {
  /** The base URL of the VCS (e.g., "https://gerrit.example.com" or "https://gitlab.example.com") */
  baseUrl: string;
}
