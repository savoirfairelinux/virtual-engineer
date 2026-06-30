/**
 * Gerrit review connector — implements `ReviewConnector` via SSH API (GerritSshConnector)
 * or HTTP REST API (GerritHttpConnector).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type {
  DiscoveredRepository,
  ReviewConnector,
  ReviewChangeRef,
  ReviewChangeStatus,
  ReviewComment,
  ExternalChangeId,
} from "../interfaces.js";
import { getLogger } from "../logger.js";
import { GerritSshClient } from "./gerritSshClient.js";
import { GerritHttpClient } from "./gerritHttpClient.js";

const log = getLogger("gerrit-connector");
const execFileAsync = promisify(execFile);

const SSH_TIMEOUT_MS = 30_000;

const GerritProjectInfoSchema = z.object({
  id: z.string().optional(),
  state: z.enum(["ACTIVE", "READ_ONLY", "HIDDEN"]).optional(),
  HEAD: z.string().optional(),
});

const GerritProjectsResponseSchema = z.record(GerritProjectInfoSchema);

export interface GerritSshDiscoveryConfig {
  host: string;
  user: string;
  port: number;
  keyPath: string;
  knownHostsPath?: string | undefined;
}

/**
 * List Gerrit repositories via `ssh gerrit ls-projects --format JSON`.
 */
export async function listRepositoriesViaSsh(
  ssh: GerritSshDiscoveryConfig
): Promise<DiscoveredRepository[]> {
  const { stdout } = await execFileAsync(
    "ssh",
    [
      "-p", String(ssh.port),
      "-i", ssh.keyPath,
      ...(ssh.knownHostsPath
        ? ["-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${ssh.knownHostsPath}`]
        : ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null"]),
      `${ssh.user}@${ssh.host}`,
      "gerrit", "ls-projects", "--format", "JSON",
    ],
    { timeout: SSH_TIMEOUT_MS }
  );

  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`gerrit ls-projects returned non-JSON output: ${stdout.slice(0, 200)}`);
  }

  const projects = GerritProjectsResponseSchema.parse(raw ?? {});
  const out: DiscoveredRepository[] = [];

  for (const [name, info] of Object.entries(projects)) {
    if (info.state === "READ_ONLY" || info.state === "HIDDEN") continue;

    const repo: DiscoveredRepository = {
      key: name,
      name,
      cloneUrlSsh: `ssh://${ssh.user}@${ssh.host}:${ssh.port}/${name}`,
    };

    if (info.HEAD) {
      const head = info.HEAD.startsWith("refs/heads/")
        ? info.HEAD.slice("refs/heads/".length)
        : info.HEAD;
      repo.defaultBranch = head;
    }

    out.push(repo);
  }

  log.debug({ count: out.length }, "discovered Gerrit projects via SSH");
  return out;
}

export interface GerritConnectorConfig {
  ssh: GerritSshDiscoveryConfig;
  /** Optional Gerrit web URL used only to build clickable change links. */
  baseUrl?: string;
}

export class GerritSshConnector implements ReviewConnector {
  private readonly sshClient: GerritSshClient;

  constructor(private readonly config: GerritConnectorConfig) {
    this.sshClient = new GerritSshClient({
      host: config.ssh.host,
      port: config.ssh.port,
      user: config.ssh.user,
      keyPath: config.ssh.keyPath,
      ...(config.ssh.knownHostsPath !== undefined ? { knownHostsPath: config.ssh.knownHostsPath } : {}),
    });
  }

  /** Fetch basic change ref info (number, patchset, URL) for a given Change-Id. */
  async getChange(changeId: ExternalChangeId): Promise<ReviewChangeRef> {
    const info = await this.sshClient.queryChange(changeId);
    const patchset = info.currentPatchSet?.number ?? 1;
    return {
      changeId,
      changeNumber: info.number,
      patchsetNumber: patchset,
      url: this.config.baseUrl
        ? `${this.config.baseUrl}/c/${info.number}`
        : info.url ?? `ssh://${this.config.ssh.user}@${this.config.ssh.host}:${this.config.ssh.port}/changes/${info.number}`,
    };
  }

  /** Return the current open/merged/abandoned status of a Gerrit change. */
  async getChangeStatus(changeId: ExternalChangeId): Promise<ReviewChangeStatus> {
    const info = await this.sshClient.queryChange(changeId);
    return info.status === "NEW" ? "OPEN" : info.status;
  }

  /** Fetch all unresolved (actionable) comments for the change via SSH. */
  async getUnresolvedComments(
    changeId: ExternalChangeId,
    sincePatchset?: number
  ): Promise<ReviewComment[]> {
    return this.sshClient.getUnresolvedComments(changeId, sincePatchset, this.config.ssh.user);
  }

  /** Post a top-level (patchset-level) comment on the given Gerrit change. */
  async addChangeComment(changeId: ExternalChangeId, message: string): Promise<void> {
    const info = await this.sshClient.queryChange(changeId);
    const patchset = info.currentPatchSet?.number ?? 1;
    await this.sshClient.query(["review", "--message", message, `${info.number},${patchset}`]);
    log.info({ changeId }, "added comment to Gerrit change via SSH");
  }

  /** Mark the given comment threads as resolved via SSH `gerrit review --json`. */
  async resolveComments(changeId: ExternalChangeId, comments: ReviewComment[]): Promise<void> {
    return this.sshClient.resolveComments(changeId, comments);
  }

  /** Discover all active Gerrit repositories via `gerrit ls-projects`. */
  async listRepositories(ssh?: {
    host?: string;
    user?: string;
    port?: number;
  }): Promise<DiscoveredRepository[]> {
    return listRepositoriesViaSsh({
      host: ssh?.host ?? this.config.ssh.host,
      user: ssh?.user ?? this.config.ssh.user,
      port: ssh?.port ?? this.config.ssh.port,
      keyPath: this.config.ssh.keyPath,
    });
  }
}

// ─── Gerrit REST response schemas ─────────────────────────────────────────────

const RestProjectInfoSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  state: z.enum(["ACTIVE", "READ_ONLY", "HIDDEN"]).optional(),
  clone_links: z.array(z.object({ name: z.string().optional(), url: z.string() })).optional(),
});

const RestChangeInfoSchema = z.object({
  _number: z.number(),
  id: z.string().optional(),
  change_id: z.string().optional(),
  project: z.string().optional(),
  status: z.enum(["NEW", "MERGED", "ABANDONED"]),
  current_revision: z.string().optional(),
  revisions: z.record(z.object({ _number: z.number() })).optional(),
  web_links: z.array(z.object({ url: z.string() })).optional(),
});

const RestCommentInfoSchema = z.object({
  id: z.string().optional(),
  author: z.object({
    _account_id: z.number().optional(),
    name: z.string().optional(),
    email: z.string().optional(),
    username: z.string().optional(),
  }).optional(),
  message: z.string(),
  path: z.string().optional(),
  line: z.number().optional(),
  unresolved: z.boolean().optional(),
  updated: z.string().optional(),
  patch_set: z.number().optional(),
});

// ─── GerritHttpConnector ──────────────────────────────────────────────────────

export interface GerritHttpConnectorConfig {
  http: GerritHttpClient;
  /** Optional Gerrit web URL used only to build clickable change links. */
  baseUrl?: string | undefined;
}

/**
 * GerritHttpConnector — implements `ReviewConnector` using the Gerrit REST API.
 * Requires Gerrit ≥ 2.15.
 */
export class GerritHttpConnector implements ReviewConnector {
  constructor(private readonly config: GerritHttpConnectorConfig) {}

  /** Fetch basic change ref info for a given Change-Id via REST. */
  async getChange(changeId: ExternalChangeId): Promise<ReviewChangeRef> {
    const encoded = encodeURIComponent(changeId);
    const data = await this.config.http.fetchJson<unknown>(
      `changes/${encoded}?o=CURRENT_REVISION`
    );
    const info = RestChangeInfoSchema.parse(data);
    const patchset = getPatchsetNumber(info);
    const url = this.config.baseUrl
      ? `${this.config.baseUrl}/c/${info._number}`
      : `${this.config.http.baseUrl}/c/${info._number}`;
    return { changeId, changeNumber: info._number, patchsetNumber: patchset, url };
  }

  /** Return the current open/merged/abandoned status of a Gerrit change. */
  async getChangeStatus(changeId: ExternalChangeId): Promise<ReviewChangeStatus> {
    const encoded = encodeURIComponent(changeId);
    const data = await this.config.http.fetchJson<unknown>(`changes/${encoded}`);
    const info = RestChangeInfoSchema.parse(data);
    return info.status === "NEW" ? "OPEN" : info.status;
  }

  /** Fetch all unresolved comments for a change via REST. */
  async getUnresolvedComments(
    changeId: ExternalChangeId,
    _sincePatchset?: number
  ): Promise<ReviewComment[]> {
    const encoded = encodeURIComponent(changeId);
    // File-level comments
    const fileComments = await this.config.http.fetchJson<Record<string, unknown[]>>(
      `changes/${encoded}/comments`
    ).catch(() => ({} as Record<string, unknown[]>));

    const results: ReviewComment[] = [];
    const veUsername = this.config.http.username;

    for (const [filePath, commentList] of Object.entries(fileComments)) {
      for (const raw of commentList) {
        const parsed = RestCommentInfoSchema.safeParse(raw);
        if (!parsed.success) continue;
        const c = parsed.data;
        if (c.unresolved === false) continue;
        const authorUsername = c.author?.username;
        if (veUsername && authorUsername === veUsername) continue;
        const updatedAt = c.updated ? new Date(c.updated) : new Date();
        results.push({
          id: c.id ?? `rest-${Date.now()}`,
          author: c.author?.email ?? c.author?.username ?? "unknown",
          message: c.message,
          filePath: filePath === "/COMMIT_MSG" ? undefined : filePath,
          line: c.line,
          unresolved: true,
          patchset: c.patch_set ?? 0,
          updatedAt,
        });
      }
    }
    return results;
  }

  /** Post a top-level comment on the given Gerrit change via REST. */
  async addChangeComment(changeId: ExternalChangeId, message: string): Promise<void> {
    const encoded = encodeURIComponent(changeId);
    const change = await this.getChange(changeId);
    await this.config.http.fetchVoid(
      `changes/${encoded}/revisions/${change.changeNumber},${change.patchsetNumber}/review`,
      { method: "POST", body: JSON.stringify({ message }) }
    );
    log.info({ changeId }, "added comment to Gerrit change via HTTP");
  }

  /** Mark comment threads as resolved via REST. */
  async resolveComments(changeId: ExternalChangeId, comments: ReviewComment[]): Promise<void> {
    if (comments.length === 0) return;
    const encoded = encodeURIComponent(changeId);
    const change = await this.getChange(changeId);
    const commentUpdates: Record<string, Array<{ id: string; unresolved: boolean }>> = {};
    for (const c of comments) {
      const key = c.filePath ?? "/COMMIT_MSG";
      const arr = commentUpdates[key] ?? (commentUpdates[key] = []);
      arr.push({ id: c.id, unresolved: false });
    }
    await this.config.http.fetchVoid(
      `changes/${encoded}/revisions/${change.changeNumber},${change.patchsetNumber}/review`,
      { method: "POST", body: JSON.stringify({ comments: commentUpdates }) }
    );
    log.info({ changeId, count: comments.length }, "resolved comments via HTTP");
  }

  /** List repositories via `GET /a/projects/`. */
  async listRepositories(): Promise<DiscoveredRepository[]> {
    const data = await this.config.http.fetchJson<Record<string, unknown>>(
      "projects/?type=CODE&format=JSON&state=ACTIVE"
    );
    const out: DiscoveredRepository[] = [];
    for (const [name, raw] of Object.entries(data)) {
      const parsed = RestProjectInfoSchema.safeParse(raw);
      if (!parsed.success) continue;
      if (parsed.data.state === "READ_ONLY" || parsed.data.state === "HIDDEN") continue;
      const cloneUrl = this.config.http.buildCloneUrl(name);
      const repo: DiscoveredRepository = {
        key: name,
        name,
        cloneUrlSsh: cloneUrl,
      };
      out.push(repo);
    }
    log.debug({ count: out.length }, "discovered Gerrit projects via HTTP REST");
    return out;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPatchsetNumber(info: z.infer<typeof RestChangeInfoSchema>): number {
  const currentRevSha = info.current_revision;
  if (currentRevSha && info.revisions) {
    const rev = info.revisions[currentRevSha];
    if (rev) return rev._number;
  }
  return 1;
}
