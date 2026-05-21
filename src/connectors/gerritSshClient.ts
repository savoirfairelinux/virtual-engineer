/**
 * GerritSshClient — shared SSH transport and protocol helper for Gerrit.
 *
 * Encapsulates all `ssh gerrit …` execution and NDJSON parsing so that
 * GerritSshConnector, GerritSshReviewProvider, and GerritVcsConnector
 * can each hold a single instance and delegate, rather than duplicating
 * the same implementation three times.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ReviewComment } from "../interfaces.js";
import { getLogger } from "../logger.js";

const log = getLogger("gerrit-ssh-client");
const execFileAsync = promisify(execFile);

type ExecFileWithInput = (
  file: string,
  args: string[],
  options: { timeout: number; input: string }
) => Promise<{ stdout: string; stderr: string }>;

const SSH_TIMEOUT_MS = 30_000;
const SSH_REVIEW_TIMEOUT_MS = 120_000;

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const SshChangeInfoSchema = z.object({
  id: z.string().optional(),
  number: z.number(),
  status: z.enum(["NEW", "MERGED", "ABANDONED"]),
  url: z.string().optional(),
  currentPatchSet: z.object({
    number: z.number(),
    revision: z.string(),
  }).optional(),
});

export type SshChangeInfo = z.infer<typeof SshChangeInfoSchema>;

export const SshCommentSchema = z.object({
  timestamp: z.number(),
  reviewer: z.object({ name: z.string().optional(), email: z.string().optional() }).optional(),
  message: z.string(),
  line: z.number().optional(),
  file: z.string().optional(),
  patchSet: z.number().optional(),
});

// ─── NDJSON parser ────────────────────────────────────────────────────────────

/**
 * Parse Gerrit SSH NDJSON output: one JSON object per line, trailing
 * stats line (`{"type":"stats","rowCount":N}`) is skipped.
 */
export function parseSshNdjson(raw: string): unknown[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as unknown)
    .filter((entry) => (entry as Record<string, unknown>)["type"] !== "stats");
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface GerritSshConfig {
  host: string;
  port: number;
  user: string;
  keyPath: string;
  knownHostsPath?: string | undefined;
}

// ─── Shared SSH host-key helper ───────────────────────────────────────────────

/**
 * Build the SSH host-key verification option flags for a given known_hosts path.
 * Returns strict-checking args when a path is provided; falls back to accepting
 * any fingerprint (with an explicit no-op known_hosts file) when absent.
 *
 * Export: consumed by GerritStreamEventsManager, GerritVcsConnector, and
 * GerritSshReviewProvider so all SSH callers share a single source of truth.
 */
export function buildSshHostKeyOptions(knownHostsPath?: string | undefined): string[] {
  return knownHostsPath
    ? ["-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHostsPath}`]
    : ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null"];
}

// ─── Client ───────────────────────────────────────────────────────────────────

/**
 * GerritSshClient — low-level SSH transport for Gerrit.
 *
 * All SSH arg construction and process spawning lives here. Consumers receive
 * typed results and never touch `child_process` directly.
 */
export class GerritSshClient {
  constructor(private readonly config: GerritSshConfig) {}

  /** Build the SSH argument list for the configured host, port, key, and known-hosts policy. */
  private buildArgs(gerritArgs: string[]): string[] {
    const { host, port, user, keyPath, knownHostsPath } = this.config;
    return [
      "-p", String(port),
      "-i", keyPath,
      ...buildSshHostKeyOptions(knownHostsPath),
      `${user}@${host}`,
      "gerrit", ...gerritArgs,
    ];
  }

  /** Execute a Gerrit SSH command and return stdout. */
  async query(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("ssh", this.buildArgs(args), { timeout: SSH_TIMEOUT_MS });
    return stdout;
  }

  /**
   * Execute a Gerrit SSH command with JSON piped to stdin, return stdout.
   * Used for `gerrit review` commands that read review input from stdin.
   */
  async queryWithInput(input: string, args: string[]): Promise<string> {
    const execFileWithInput = execFileAsync as unknown as ExecFileWithInput;
    const { stdout } = await execFileWithInput(
      "ssh",
      this.buildArgs(args),
      { input, timeout: SSH_TIMEOUT_MS }
    );
    return stdout;
  }

  /**
   * Pipe `input` to `gerrit review --json CHANGESPEC` via SSH stdin.
   *
   * Uses `spawn` (not `execFile`) so stdin is written only after the child
   * process is ready, avoiding a race where execFile closes stdin before the
   * SSH channel forwards the data to the remote gerrit command.
   */
  async reviewJson(changeSpec: string, input: string): Promise<void> {
    const args = this.buildArgs(["review", "--json", changeSpec]);

    await new Promise<void>((resolve, reject) => {
      const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill();
          reject(new Error(
            `SSH review timed out after ${SSH_REVIEW_TIMEOUT_MS}ms: ssh ${args.join(" ")}`
          ));
        }
      }, SSH_REVIEW_TIMEOUT_MS);

      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });

      child.on("close", (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(
              `gerrit review --json exited with code ${String(code)}: ${stderr.trim()}`
            ));
          }
        }
      });

      // Write JSON to stdin only after the process has spawned
      child.on("spawn", () => {
        child.stdin.end(input);
      });
    });
  }

  /**
   * Query a Gerrit change by Change-Id via SSH and return Zod-validated info.
   * Throws if the change is not found or the response fails schema validation.
   */
  async queryChange(changeId: string): Promise<SshChangeInfo> {
    const out = await this.query([
      "query", "--format", "JSON", "--current-patch-set", `change:${changeId}`,
    ]);
    const rows = parseSshNdjson(out);
    if (rows.length === 0) throw new Error(`Gerrit SSH: change not found for id=${changeId}`);
    return SshChangeInfoSchema.parse(rows[0]);
  }

  /**
   * Fetch review comments for a Gerrit change via SSH.
   * SSH does not expose a resolved flag, so every returned comment is treated
   * as unresolved/actionable.
   *
   * @param sincePatchset When provided, comments from earlier patchsets are excluded.
   */
  async getUnresolvedComments(changeId: string, sincePatchset?: number): Promise<ReviewComment[]> {
    const out = await this.query([
      "query", "--format", "JSON", "--current-patch-set", "--comments", `change:${changeId}`,
    ]);
    const rows = parseSshNdjson(out);
    if (rows.length === 0) return [];

    const result: ReviewComment[] = [];
    for (const row of rows) {
      const record = row as Record<string, unknown>;
      const rawComments = (record["currentPatchSet"] as Record<string, unknown> | undefined)?.["comments"];
      if (!Array.isArray(rawComments)) continue;
      for (const raw of rawComments) {
        const comment = SshCommentSchema.safeParse(raw);
        if (!comment.success) continue;
        const patchset = comment.data.patchSet ?? 0;
        if (sincePatchset !== undefined && patchset < sincePatchset) continue;
        result.push({
          id: `ssh-${comment.data.timestamp}-${patchset}`,
          author: comment.data.reviewer?.email ?? comment.data.reviewer?.name ?? "unknown",
          message: comment.data.message,
          filePath: comment.data.file && comment.data.file !== "/PATCHSET_LEVEL" ? comment.data.file : undefined,
          line: comment.data.line,
          unresolved: true,
          patchset,
          updatedAt: new Date(comment.data.timestamp * 1000),
        });
      }
    }

    log.debug({ changeId, count: result.length }, "fetched Gerrit comments via SSH");
    return result;
  }

  /**
   * Mark Gerrit review comment threads as resolved via SSH `gerrit review --json`.
   * Without `in_reply_to`, Gerrit creates new resolved follow-up comments.
   */
  async resolveComments(changeId: string, comments: ReviewComment[]): Promise<void> {
    if (comments.length === 0) return;

    const info = await this.queryChange(changeId);
    const patchset = info.currentPatchSet?.number ?? 1;

    const commentsByFile: Record<string, Array<{ message: string; line?: number; unresolved: boolean }>> = {};
    for (const comment of comments) {
      const key = comment.filePath ?? "/PATCHSET_LEVEL";
      if (!commentsByFile[key]) commentsByFile[key] = [];
      commentsByFile[key].push({
        message: "Addressed in this patchset.",
        ...(comment.line !== undefined ? { line: comment.line } : {}),
        unresolved: false,
      });
    }

    const reviewInput = JSON.stringify({ comments: commentsByFile });
    await this.queryWithInput(reviewInput, ["review", "--json", `${info.number},${patchset}`]);
    log.info({ changeId, count: comments.length }, "resolved Gerrit comment threads via SSH review --json");
  }
}
