/**
 * GerritHttpReviewProvider — HTTP REST-based reviewer-side connector for Gerrit.
 *
 * Implements `ReviewProvider` using Gerrit's REST API for change queries and
 * review posting, and git clone over HTTPS for diff retrieval. Used when
 * authMode = "http" and SSH credentials are unavailable.
 *
 * Requires Gerrit ≥ 2.15 (stable REST API).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
  ExternalChangeId,
  InlineReviewComment,
  ReviewChangeDetails,
  ReviewChangeDiff,
  ReviewDiffFile,
  ReviewFileStatus,
  ReviewProvider,
} from "../interfaces.js";
import { getLogger } from "../logger.js";
import { filterCommentsByAllowedFiles } from "../review/commentFilter.js";
import { GerritHttpClient } from "./gerritHttpClient.js";
import { PREAMBLE_RE, COMMENTS_SUMMARY_RE } from "./gerritSshClient.js";

const log = getLogger("gerrit-http-review-provider");
const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 120_000;

// ─── REST API response schemas ────────────────────────────────────────────────

const RestAccountSchema = z.object({
  _account_id: z.number().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
  username: z.string().optional(),
});

const RestRevisionSchema = z.object({
  _number: z.number(),
  commit: z.object({
    message: z.string().optional(),
    author: RestAccountSchema.optional(),
  }).optional(),
});

const RestChangeSchema = z.object({
  _number: z.number(),
  id: z.string().optional(),
  change_id: z.string().optional(),
  project: z.string(),
  branch: z.string(),
  subject: z.string(),
  status: z.enum(["NEW", "MERGED", "ABANDONED"]),
  owner: RestAccountSchema,
  current_revision: z.string().optional(),
  revisions: z.record(RestRevisionSchema).optional(),
  messages: z.array(z.object({
    id: z.string().optional(),
    author: RestAccountSchema.optional(),
    date: z.string().optional(),
    message: z.string(),
    _revision_number: z.number().optional(),
  })).optional(),
  web_links: z.array(z.object({ url: z.string() })).optional(),
});

const RestReviewerSchema = z.object({
  _account_id: z.number().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
  username: z.string().optional(),
});

// ─── Provider config ──────────────────────────────────────────────────────────

export interface GerritHttpReviewProviderConfig {
  httpBaseUrl: string;
  httpUsername: string;
  httpToken: string;
  /** Numeric Gerrit account id of the VE reviewer (as a string). Optional — when absent the self-review guard is skipped. */
  reviewerAccountId?: string | undefined;
  /** Base directory for temporary git checkouts (used to compute diffs). Defaults to /tmp/ve-review-diffs */
  workspaceBaseDir?: string | undefined;
}

/**
 * GerritHttpReviewProvider — HTTP-only reviewer-side connector for Gerrit.
 *
 * Uses the Gerrit REST API for discovery and comment posting, and
 * `git clone` over HTTPS for diff retrieval. Does NOT require SSH keys.
 */
export class GerritHttpReviewProvider implements ReviewProvider {
  public readonly kind = "gerrit";
  private readonly http: GerritHttpClient;

  constructor(private readonly config: GerritHttpReviewProviderConfig) {
    this.http = new GerritHttpClient({
      baseUrl: config.httpBaseUrl,
      username: config.httpUsername,
      token: config.httpToken,
    });
  }

  /** Fetch full change details including subject, owner, branch, and patchset metadata. */
  async getChangeDetails(changeId: ExternalChangeId): Promise<ReviewChangeDetails> {
    const encoded = encodeURIComponent(changeId);
    const data = await this.http.fetchJson<unknown>(
      `changes/${encoded}?o=CURRENT_REVISION&o=DETAILED_ACCOUNTS&o=MESSAGES&o=COMMIT_FOOTERS`
    );
    const entry = RestChangeSchema.parse(data);

    const currentRevSha = entry.current_revision;
    const currentRevObj = currentRevSha && entry.revisions ? entry.revisions[currentRevSha] : undefined;
    const patchset = currentRevObj?._number ?? 1;

    // Parse commit body for description
    const rawMsg = currentRevObj?.commit?.message ?? "";
    const msg = rawMsg.replace(/\r/g, "");
    const sep = msg.indexOf("\n\n");
    const commitBody = sep === -1 ? "" : reflowCommitBody(msg.slice(sep + 2).trim());

    // Determine owner account id
    const ownerId = String(entry.owner._account_id ?? "unknown");

    // Determine change URL
    const url = `${this.http.baseUrl}/c/${entry._number}`;

    return {
      changeId,
      changeNumber: entry._number,
      subject: entry.subject,
      description: commitBody,
      ownerAccountId: ownerId,
      currentPatchset: patchset,
      status: entry.status === "NEW" ? "OPEN" : entry.status,
      project: entry.project,
      targetBranch: entry.branch,
      url,
    };
  }

  /**
   * Returns true when VE is an active REVIEWER on this change and the change
   * is OPEN. The self-review guard is applied when `reviewerAccountId` is set.
   */
  async isReviewer(changeId: ExternalChangeId): Promise<boolean> {
    let details: ReviewChangeDetails;
    try {
      details = await this.getChangeDetails(changeId);
    } catch {
      return false;
    }
    if (details.status !== "OPEN") return false;

    if (!this.config.reviewerAccountId) return true;

    // Self-review guard
    if (details.ownerAccountId === this.config.reviewerAccountId) return false;

    // Check reviewer list
    try {
      const encoded = encodeURIComponent(changeId);
      const reviewers = await this.http.fetchJson<unknown[]>(`changes/${encoded}/reviewers`);
      const parsed = z.array(RestReviewerSchema).safeParse(reviewers);
      if (!parsed.success) return false;
      const accountId = Number(this.config.reviewerAccountId);
      return parsed.data.some(
        (r) =>
          (r._account_id !== undefined && r._account_id === accountId) ||
          r.username === this.config.httpUsername
      );
    } catch {
      log.warn({ changeId }, "HTTP isReviewer query failed — allowing review to proceed");
      return true;
    }
  }

  /** Clone the patchset ref via HTTPS and produce a per-file unified diff. */
  async getChangeDiff(
    changeId: ExternalChangeId,
    patchset?: number
  ): Promise<ReviewChangeDiff> {
    const details = await this.getChangeDetails(changeId);
    const ps = patchset ?? details.currentPatchset;

    // Compute the Gerrit change ref: refs/changes/NN/CHANGE/PATCHSET
    const nn = String(details.changeNumber % 100).padStart(2, "0");
    const changeRef = `refs/changes/${nn}/${details.changeNumber}/${ps}`;

    const baseDir = this.config.workspaceBaseDir ?? "/tmp/ve-review-diffs";
    const dir = await mkdtemp(join(baseDir, `diff-${details.changeNumber}-`));

    try {
      const cloneUrl = this.http.buildCloneUrl(details.project);
      const gitEnv = {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/false",
      };

      await execFileAsync("git", ["init"], { cwd: dir, timeout: GIT_TIMEOUT_MS });
      await execFileAsync("git", ["remote", "add", "origin", cloneUrl], {
        cwd: dir,
        timeout: GIT_TIMEOUT_MS,
      });
      await execFileAsync("git", ["fetch", "--depth=2", "origin", changeRef], {
        cwd: dir,
        timeout: GIT_TIMEOUT_MS,
        env: gitEnv,
      });
      await execFileAsync("git", ["checkout", "FETCH_HEAD"], {
        cwd: dir,
        timeout: GIT_TIMEOUT_MS,
      });

      const { stdout: diffOutput } = await execFileAsync(
        "git",
        ["diff", "HEAD~1..HEAD", "--no-color", "--unified=5"],
        { cwd: dir, timeout: GIT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }
      );

      const files = parseDiffOutput(diffOutput);
      log.info(
        { changeId, patchset: ps, fileCount: files.length },
        "computed diff from HTTPS checkout"
      );
      return { changeId, patchset: ps, files };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Post inline comments together with a Code-Review vote via the Gerrit REST API. */
  async postReviewWithComments(
    changeId: ExternalChangeId,
    revision: number,
    comments: InlineReviewComment[],
    summary: string,
    score: -1 | 1,
    allowedFiles?: ReadonlySet<string>
  ): Promise<void> {
    const details = await this.getChangeDetails(changeId);
    const kept = filterCommentsByAllowedFiles(comments, allowedFiles, { changeId, revision });

    const reviewInput: Record<string, unknown> = {
      labels: { "Code-Review": score },
    };
    const trimmedSummary = summary.trim();
    if (trimmedSummary.length > 0) reviewInput["message"] = trimmedSummary;
    if (kept.length > 0) reviewInput["comments"] = groupCommentsByFile(kept);

    const encoded = encodeURIComponent(changeId);
    await this.http.fetchVoid(
      `changes/${encoded}/revisions/${details.changeNumber},${revision}/review`,
      { method: "POST", body: JSON.stringify(reviewInput) }
    );
    log.info(
      { changeId, revision, comments: kept.length, score },
      "posted review comments and vote via HTTP"
    );
  }

  /** Post inline review comments (without a vote) via the Gerrit REST API. */
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

    const reviewInput: Record<string, unknown> = {};
    if (trimmedSummary.length > 0) reviewInput["message"] = trimmedSummary;
    if (kept.length > 0) reviewInput["comments"] = groupCommentsByFile(kept);

    const encoded = encodeURIComponent(changeId);
    const details = await this.getChangeDetails(changeId);
    await this.http.fetchVoid(
      `changes/${encoded}/revisions/${details.changeNumber},${revision}/review`,
      { method: "POST", body: JSON.stringify(reviewInput) }
    );
    log.info(
      { changeId, revision, comments: kept.length },
      "posted review comments via HTTP"
    );
  }

  /** Submit a Code-Review vote (optionally with a message) via the Gerrit REST API. */
  async vote(
    changeId: ExternalChangeId,
    revision: number,
    score: number,
    message?: string
  ): Promise<void> {
    const encoded = encodeURIComponent(changeId);
    const details = await this.getChangeDetails(changeId);
    const reviewInput: Record<string, unknown> = {
      labels: { "Code-Review": score },
    };
    if (message !== undefined && message.trim().length > 0) {
      reviewInput["message"] = message;
    }
    await this.http.fetchVoid(
      `changes/${encoded}/revisions/${details.changeNumber},${revision}/review`,
      { method: "POST", body: JSON.stringify(reviewInput) }
    );
    log.info({ changeId, revision, score }, "submitted Code-Review vote via HTTP");
  }
}

// ─── Diff parser (shared with SSH provider) ───────────────────────────────────

function parseDiffOutput(diffText: string): ReviewDiffFile[] {
  if (diffText.trim().length === 0) return [];
  const files: ReviewDiffFile[] = [];
  const chunks = diffText.split(/^diff --git /m).filter((c) => c.length > 0);
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    const headerMatch = lines[0]?.match(/^a\/(.+?) b\/(.+?)$/);
    if (!headerMatch) continue;
    const newPath = headerMatch[2] ?? headerMatch[1] ?? "";
    let status: ReviewFileStatus = "modified";
    for (const line of lines.slice(1, 6)) {
      if (line.startsWith("new file")) { status = "added"; break; }
      if (line.startsWith("deleted file")) { status = "deleted"; break; }
      if (line.startsWith("rename from")) { status = "renamed"; break; }
    }
    const patch = `diff --git ${chunk}`;
    files.push({ path: newPath, status, patch });
  }
  return files;
}

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

// Re-export for use in other modules that need to strip Gerrit message preambles
export { PREAMBLE_RE, COMMENTS_SUMMARY_RE };
