/**
 * Gerrit review provider (SSH + git).
 *
 * Implements `ReviewProvider` using Gerrit's SSH API for change queries and
 * review posting, and `git fetch` + `git diff` for diff retrieval. Used when
 * HTTP REST credentials are unavailable or the Gerrit instance is SSH-only.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  type ExternalChangeId,
  type InlineReviewComment,
  type ReviewChangeDetails,
  type ReviewChangeDiff,
  type ReviewDiffFile,
  type ReviewDiscussionThread,
  type ReviewFileStatus,
  type ReviewProvider,
} from "../interfaces.js";
import { getLogger } from "../logger.js";
import { filterCommentsByAllowedFiles } from "../review/commentFilter.js";
import {
  GerritSshClient,
  type GerritDiscussionComment,
  parseSshNdjson,
  buildSshHostKeyOptions,
} from "./gerritSshClient.js";

const log = getLogger("gerrit-ssh-review-provider");
const execFileAsync = promisify(execFile);

/** Prefix for inline-thread ids (`gerrit-line:<file>:<line>`). */
const GERRIT_LINE_PREFIX = "gerrit-line:";
/** Sentinel thread id for the single change-level discussion bucket. */
const GERRIT_CHANGE_THREAD_ID = "gerrit-change";

// Git operations allow up to 2 minutes because they involve network I/O
// and potentially large diffs. SSH query/review operations are handled by
// GerritSshClient which has its own timeout constants.
const GIT_TIMEOUT_MS = 120_000;

// ─── SSH query schemas ────────────────────────────────────────────────────────

const SshAccountSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  username: z.string().optional(),
});

const SshPatchSetSchema = z.object({
  number: z.number(),
  revision: z.string(),
  ref: z.string(),
});

const SshFileSchema = z.object({
  file: z.string(),
  fileOld: z.string().optional(),
  type: z.enum(["ADDED", "MODIFIED", "DELETED", "RENAMED", "COPIED", "REWRITE"]),
  insertions: z.number().optional(),
  deletions: z.number().optional(),
});

const SshChangeSchema = z.object({
  id: z.string().optional(),
  number: z.number(),
  project: z.string(),
  branch: z.string(),
  subject: z.string(),
  commitMessage: z.string().optional(),
  status: z.enum(["NEW", "MERGED", "ABANDONED"]),
  url: z.string().optional(),
  owner: SshAccountSchema,
  currentPatchSet: SshPatchSetSchema.extend({
    files: z.array(SshFileSchema).optional(),
  }).optional(),
  allReviewers: z.array(SshAccountSchema).optional(),
  createdOn: z.number().optional(),
});

// ─── Provider config ──────────────────────────────────────────────────────────

export interface GerritSshReviewProviderConfig {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshKeyPath: string;
  /** Path to a known_hosts file. When set, SSH uses strict host key verification. */
  sshKnownHostsPath?: string | undefined;
  /** Numeric Gerrit account id of the VE reviewer (as a string). Optional — when absent the self-review guard is skipped. */
  reviewerAccountId?: string | undefined;
  /**
   * Base directory for temporary git checkouts (used to compute diffs).
   * Defaults to /tmp/virtual-engineer/review-diffs.
   */
  workspaceBaseDir?: string | undefined;
}

/**
 * GerritSshReviewProvider — SSH-only reviewer-side connector for Gerrit.
 *
 * Uses `gerrit query` via SSH for discovery, `git clone --depth=1` +
 * `git fetch` for diffs, and `gerrit review --json` for posting comments
 * and votes. Does NOT require HTTP credentials.
 */
export class GerritSshReviewProvider implements ReviewProvider {
  public readonly kind = "gerrit";
  private readonly sshClient: GerritSshClient;

  constructor(private readonly config: GerritSshReviewProviderConfig) {
    this.sshClient = new GerritSshClient({
      host: config.sshHost,
      port: config.sshPort,
      user: config.sshUser,
      keyPath: config.sshKeyPath,
      ...(config.sshKnownHostsPath !== undefined ? { knownHostsPath: config.sshKnownHostsPath } : {}),
    });
  }

  /** Fetch full change details including subject, owner, branch, and patchset metadata. */
  async getChangeDetails(changeId: ExternalChangeId): Promise<ReviewChangeDetails> {
    const raw = await this.sshClient.query([
      "query", "--format", "JSON", "--current-patch-set", "--commit-message",
      `change:${changeId}`,
    ]);
    const rows = parseSshNdjson(raw);
    if (rows.length === 0) throw new Error(`Gerrit SSH: change not found for id=${changeId}`);
    const entry = SshChangeSchema.parse(rows[0]);
    const patchset = entry.currentPatchSet?.number ?? 1;
    // Extract the commit body (everything after the blank separator line).
    // Re-flow prose paragraphs: single \n (git hard-wrap at 72 chars) become
    // a space; \n\n paragraph separators and list-item lines are kept intact.
    const msg = (entry.commitMessage ?? "").replace(/\r/g, "");
    const sep = msg.indexOf("\n\n");
    const commitBody = sep === -1 ? "" : reflowCommitBody(msg.slice(sep + 2).trim());
    return {
      changeId,
      changeNumber: entry.number,
      subject: entry.subject,
      description: commitBody,
      ownerAccountId: String(this.getAccountId(entry.owner)),
      currentPatchset: patchset,
      status: entry.status === "NEW" ? "OPEN" : entry.status,
      project: entry.project,
      targetBranch: entry.branch,
      url: entry.url ?? `ssh://${this.config.sshUser}@${this.config.sshHost}:${this.config.sshPort}/changes/${entry.number}`,
    };
  }

  /**
   * Returns true when VE is an active REVIEWER on this change and the change is
   * OPEN. The SSH provider does not have a cheap reviewer-list API, so we query
   * change details (which includes `allReviewers`) via `gerrit query` and check
   * the `--all-reviewers` field. Self-review guard is applied.
   */
  async isReviewer(changeId: ExternalChangeId): Promise<boolean> {
    let details: ReviewChangeDetails;
    try {
      details = await this.getChangeDetails(changeId);
    } catch {
      return false;
    }
    if (details.status !== "OPEN") return false;

    // When no reviewerAccountId is configured, skip the self-review guard and
    // reviewer-list check — any OPEN change is eligible for review.
    if (!this.config.reviewerAccountId) return true;

    const ownAccountId = Number(this.config.reviewerAccountId);
    if (details.ownerAccountId === this.config.reviewerAccountId) return false;

    // Re-query with --all-reviewers to get the reviewer list over SSH.
    try {
      const raw = await this.sshClient.query([
        "query", "--format", "JSON", "--all-reviewers",
        `change:${changeId}`,
      ]);
      const rows = parseSshNdjson(raw);
      if (rows.length === 0) return false;
      const entry = SshChangeSchema.safeParse(rows[0]);
      if (!entry.success) return false;
      const reviewers = entry.data.allReviewers ?? [];
      // SSH output doesn't include _account_id — fall back to username match.
      const matchById = reviewers.some((r) => this.getAccountId(r) === ownAccountId);
      if (matchById) return true;
      return reviewers.some((r) => r.username === this.config.sshUser);
    } catch {
      // If SSH query fails, allow the review path to proceed — better to
      // attempt a review than silently drop a webhook event.
      log.warn({ changeId }, "SSH isReviewer query failed — allowing review to proceed");
      return true;
    }
  }

  /** Clone the patchset ref via git and produce a per-file unified diff. */
  async getChangeDiff(
    changeId: ExternalChangeId,
    patchset?: number
  ): Promise<ReviewChangeDiff> {
    // Get change details to know project, ref, and patchset
    const details = await this.getChangeDetails(changeId);
    const ps = patchset ?? details.currentPatchset;

    // Compute the Gerrit change ref
    const nn = String(details.changeNumber % 100).padStart(2, "0");
    const changeRef = `refs/changes/${nn}/${details.changeNumber}/${ps}`;

    const baseDir = this.config.workspaceBaseDir ?? "/tmp/ve-review-diffs";
    const dir = await mkdtemp(join(baseDir, `diff-${details.changeNumber}-`));

    try {
      const sshUrl = `ssh://${this.config.sshUser}@${this.config.sshHost}:${this.config.sshPort}/${details.project}`;
      const hostKeyOpts = buildSshHostKeyOptions(this.config.sshKnownHostsPath).join(" ");
      const sshCmd = `ssh -p ${this.config.sshPort} -i ${this.config.sshKeyPath} ${hostKeyOpts}`;
      const gitEnv = {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: sshCmd,
      };

      // Init a bare repo and fetch just the patchset ref + its parent
      await execFileAsync("git", ["init"], { cwd: dir, timeout: GIT_TIMEOUT_MS });
      await execFileAsync("git", ["remote", "add", "origin", sshUrl], { cwd: dir, timeout: GIT_TIMEOUT_MS });
      await execFileAsync(
        "git",
        ["fetch", "--depth=2", "origin", changeRef],
        { cwd: dir, timeout: GIT_TIMEOUT_MS, env: gitEnv }
      );
      await execFileAsync("git", ["checkout", "FETCH_HEAD"], { cwd: dir, timeout: GIT_TIMEOUT_MS });

      // Generate unified diff against parent
      const { stdout: diffOutput } = await execFileAsync(
        "git",
        ["diff", "HEAD~1..HEAD", "--no-color", "--unified=5"],
        { cwd: dir, timeout: GIT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }
      );

      const files = parseDiffOutput(diffOutput);
      log.info(
        { changeId, patchset: ps, fileCount: files.length },
        "computed diff from SSH checkout"
      );
      return { changeId, patchset: ps, files };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Post inline comments together with a Code-Review vote via SSH `gerrit review --json`. */
  async postReviewWithComments(
    changeId: ExternalChangeId,
    revision: number,
    comments: InlineReviewComment[],
    summary: string,
    score: -1 | 1,
    allowedFiles?: ReadonlySet<string>
  ): Promise<void> {
    const details = await this.getChangeDetails(changeId);
    const changeSpec = `${details.changeNumber},${revision}`;

    const reviewInput: Record<string, unknown> = {
      labels: { "Code-Review": score },
    };
    const trimmedSummary = summary.trim();
    if (trimmedSummary.length > 0) reviewInput["message"] = trimmedSummary;

    const kept = filterCommentsByAllowedFiles(comments, allowedFiles, { changeId, revision });
    if (kept.length > 0) {
      reviewInput["comments"] = groupCommentsByFile(kept);
    }

    await this.sshClient.reviewJson(changeSpec, JSON.stringify(reviewInput));
    log.info(
      { changeId, revision, comments: kept.length, score },
      "posted review comments and vote via SSH"
    );
  }

  /** Post inline review comments (without a vote) via SSH `gerrit review --json`. */
  async postReviewComments(
    changeId: ExternalChangeId,
    revision: number,
    comments: InlineReviewComment[],
    summary: string,
    allowedFiles?: ReadonlySet<string>
  ): Promise<void> {
    const trimmedSummary = summary.trim();
    const kept = filterCommentsByAllowedFiles(comments, allowedFiles, { changeId, revision });
    if (kept.length === 0 && trimmedSummary.length === 0) return;

    const details = await this.getChangeDetails(changeId);
    const changeSpec = `${details.changeNumber},${revision}`;

    const reviewInput: Record<string, unknown> = {};
    if (trimmedSummary.length > 0) reviewInput["message"] = trimmedSummary;

    if (kept.length > 0) {
      reviewInput["comments"] = groupCommentsByFile(kept);
    }

    await this.sshClient.reviewJson(changeSpec, JSON.stringify(reviewInput));
    log.info(
      { changeId, revision, comments: kept.length },
      "posted review comments via SSH"
    );
  }

  /** Submit a Code-Review vote (optionally with a message) via SSH `gerrit review --json`. */
  async vote(
    changeId: ExternalChangeId,
    revision: number,
    score: number,
    message?: string
  ): Promise<void> {
    const details = await this.getChangeDetails(changeId);
    const changeSpec = `${details.changeNumber},${revision}`;

    const reviewInput: Record<string, unknown> = {
      labels: { "Code-Review": score },
    };
    if (message !== undefined && message.trim().length > 0) {
      reviewInput["message"] = message;
    }

    await this.sshClient.reviewJson(changeSpec, JSON.stringify(reviewInput));
    log.info({ changeId, revision, score }, "submitted Code-Review vote via SSH");
  }

  /**
   * Fetch open discussion threads via SSH and group them by location.
   *
   * SSH exposes neither comment UUIDs nor a resolved flag, so threads are keyed
   * by file+line (or a single change-level bucket), `resolved` is always false
   * (eligibility is deduped by the reply ledger), and replies are posted as a
   * fresh comment at the same location rather than a true in_reply_to thread.
   */
  async getDiscussionThreads(changeId: ExternalChangeId): Promise<ReviewDiscussionThread[]> {
    const comments = await this.sshClient.getDiscussionComments(String(changeId));
    const groups = new Map<string, GerritDiscussionComment[]>();
    for (const c of comments) {
      const key = c.file === null ? GERRIT_CHANGE_THREAD_ID : `${GERRIT_LINE_PREFIX}${c.file}:${c.line ?? 0}`;
      const list = groups.get(key);
      if (list) list.push(c);
      else groups.set(key, [c]);
    }

    const threads: ReviewDiscussionThread[] = [];
    for (const [threadId, list] of groups) {
      list.sort((a, b) => a.timestampMs - b.timestampMs);
      const first = list[0];
      if (!first) continue;
      threads.push({
        threadId,
        file: first.file,
        line: first.line,
        resolved: false,
        comments: list.map((c) => ({ author: c.author, message: c.message, isOwn: c.isOwn })),
      });
    }
    return threads;
  }

  /**
   * Post a reply to a discussion thread. Inline threads receive a new comment at
   * the same file+line; the change-level thread receives a change message. SSH
   * cannot set in_reply_to, so Gerrit renders the reply alongside the original.
   */
  async postThreadReply(
    changeId: ExternalChangeId,
    revision: number,
    threadId: string,
    message: string
  ): Promise<void> {
    const details = await this.getChangeDetails(changeId);
    const changeSpec = `${details.changeNumber},${revision}`;

    const reviewInput: Record<string, unknown> = {};
    if (threadId === GERRIT_CHANGE_THREAD_ID || !threadId.startsWith(GERRIT_LINE_PREFIX)) {
      reviewInput["message"] = message;
    } else {
      const key = threadId.slice(GERRIT_LINE_PREFIX.length);
      const sep = key.lastIndexOf(":");
      const file = sep > 0 ? key.slice(0, sep) : key;
      const line = sep > 0 ? parseInt(key.slice(sep + 1), 10) || 0 : 0;
      reviewInput["comments"] = { [file]: [{ line, message, unresolved: false }] };
    }

    await this.sshClient.reviewJson(changeSpec, JSON.stringify(reviewInput));
    log.info({ changeId, revision, threadId }, "posted discussion reply via SSH");
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /** Extract a numeric account ID from an SSH account object; returns -1 when unavailable. */
  private getAccountId(account: z.infer<typeof SshAccountSchema>): number {
    // SSH output doesn't have _account_id — we can't rely on it.
    // Return -1 to indicate unknown. Self-review guard will compare
    // against the configured reviewer which uses a different path.
    void account;
    return -1;
  }
}

// ─── Diff parser ──────────────────────────────────────────────────────────────

/**
 * Parse unified diff output from `git diff` into per-file ReviewDiffFile entries.
 */
function parseDiffOutput(diffText: string): ReviewDiffFile[] {
  if (diffText.trim().length === 0) return [];

  const files: ReviewDiffFile[] = [];
  // Split on `diff --git` boundaries
  const chunks = diffText.split(/^diff --git /m).filter((c) => c.length > 0);

  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    // First line: "a/path b/path"
    const headerMatch = lines[0]?.match(/^a\/(.+?) b\/(.+?)$/);
    if (!headerMatch) continue;

    const newPath = headerMatch[2] ?? headerMatch[1] ?? "";
    let status: ReviewFileStatus = "modified";

    // Detect status from the diff header lines
    for (const line of lines.slice(1, 6)) {
      if (line.startsWith("new file")) { status = "added"; break; }
      if (line.startsWith("deleted file")) { status = "deleted"; break; }
      if (line.startsWith("rename from")) { status = "renamed"; break; }
    }

    // The patch is the full chunk prefixed with "diff --git "
    const patch = `diff --git ${chunk}`;
    files.push({ path: newPath, status, patch });
  }

  return files;
}

/**
 * Re-flow a raw git commit body for display.
 *
 * Git commits hard-wrap prose lines at ~72 characters using single newlines.
 * Double newlines (\n\n) separate paragraphs and are always preserved.
 * Within a prose paragraph, single newlines are joined with a space.
 * Paragraphs that contain list items (lines starting with `- `, `* `, or
 * `N. `) are kept as-is so the dashboard's renderRichText can detect them.
 */
function reflowCommitBody(body: string): string {
  return body
    .split("\n\n")
    .map((para) => {
      const lines = para.split("\n");
      const hasListItem = lines.some((l) => {
        const t = l.trimStart();
        return t.startsWith("- ") || t.startsWith("* ") || /^\d+\. /.test(t);
      });
      if (hasListItem) return para;
      return lines.join(" ").replace(/ {2,}/g, " ");
    })
    .join("\n\n");
}

/** Format an inline comment body with severity tag and optional line prefix. */
function formatCommentBody(c: InlineReviewComment): string {
  const linePrefix = c.line > 0 ? `Line ${c.line}: ` : "";
  const severity = c.severity.trim().toLowerCase();
  if (severity === "suggestion") return `${linePrefix}${c.message}`;
  const tag = severity === "error" ? "[error]" : severity === "warning" ? "[warning]" : `[${c.severity}]`;
  return `${tag} ${linePrefix}${c.message}`;
}

function groupCommentsByFile(
  comments: InlineReviewComment[]
): Record<string, Array<{ line: number; message: string; unresolved: boolean }>> {
  const grouped: Record<string, Array<{ line: number; message: string; unresolved: boolean }>> = {};
  for (const c of comments) {
    const arr = grouped[c.file] ?? (grouped[c.file] = []);
    arr.push({
      line: c.line,
      message: formatCommentBody(c),
      unresolved: c.severity !== "suggestion",
    });
  }
  return grouped;
}

