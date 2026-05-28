import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import type { Integration, ReviewComment } from "../interfaces.js";
import { getLogger } from "../logger.js";
import { buildSshHostKeyOptions, PREAMBLE_RE, COMMENTS_SUMMARY_RE } from "./gerritSshClient.js";
import type {
  IntegrationEventStreamDependencies,
  IntegrationEventStreamManager,
  IntegrationEventStreamOrchestrator,
  IntegrationEventStreamReviewTrigger,
  IntegrationEventStreamStatus,
} from "./integrationStreamEvents.js";

const execFileAsync = promisify(execFile);
const SSH_QUERY_TIMEOUT_MS = 30_000;

export const GERRIT_SSH_KEY_DEFAULT = "/app/secrets/gerrit_id_ed25519";
export const GERRIT_SSH_PORT_DEFAULT = 29418;

type SshQueryFn = (args: string[], config: GerritStreamConfig) => Promise<string>;

const log = getLogger("gerrit-stream-events");
const DEFAULT_RECONNECT_DELAY_MS = 2_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;

type GerritEventType =
  | "change-merged"
  | "change-abandoned"
  | "patchset-created"
  | "reviewer-added"
  | "comment-added";

export type GerritStreamStatus = IntegrationEventStreamStatus;

export type GerritStreamOrchestrator = IntegrationEventStreamOrchestrator;

export type GerritStreamReviewTrigger = IntegrationEventStreamReviewTrigger;

interface GerritStreamConfig {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshKeyPath: string;
  sshKnownHostsPath?: string | undefined;
}

interface GerritStreamHandle {
  integration: Integration;
  config: GerritStreamConfig;
  child: ChildProcessWithoutNullStreams;
  stdoutBuffer: string;
  stderrBuffer: string;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  stopRequested: boolean;
  /** True once the first byte of stdout data has been received (SSH handshake complete). */
  hasReceivedData: boolean;
  /** Tail of the event-processing promise chain — serialises events and catches errors. */
  processingChain: Promise<void>;
}

export interface GerritStreamEventsManagerOptions extends IntegrationEventStreamDependencies {
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
  spawnProcess?: typeof spawn;
  /** Injectable SSH query function — used by tests to avoid real SSH calls. */
  sshQueryFn?: SshQueryFn;
}

const BACKFILL_MAX_CHANGES = 20;

export class GerritStreamEventsManager implements IntegrationEventStreamManager {
  private readonly handles = new Map<string, GerritStreamHandle>();
  private readonly statuses = new Map<string, GerritStreamStatus>();
  private readonly desiredIntegrations = new Map<string, Integration>();
  private readonly backfilledIntegrations = new Set<string>();
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly spawnProcess: typeof spawn;
  private readonly sshQueryFn: SshQueryFn;

  constructor(private readonly options: GerritStreamEventsManagerOptions) {
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.sshQueryFn = options.sshQueryFn ?? defaultSshQuery;
  }

  /** Sync the set of running stream-events listeners to match the provided integration list. */
  async reconcile(integrations: Integration[]): Promise<void> {
    this.desiredIntegrations.clear();
    for (const integration of integrations) {
      this.desiredIntegrations.set(integration.id, integration);
    }

    for (const integrationId of [...this.handles.keys()]) {
      if (!this.desiredIntegrations.has(integrationId)) {
        this.stopHandle(integrationId, { removeStatus: true });
        this.backfilledIntegrations.delete(integrationId);
      }
    }

    for (const integration of integrations) {
      const parsed = parseGerritStreamConfig(integration);
      if (!parsed.success) {
        this.stopHandle(integration.id);
        this.statuses.set(integration.id, {
          integrationId: integration.id,
          integrationName: integration.name,
          integrationType: integration.type,
          state: "error",
          reconnectCount: 0,
          lastEventType: null,
          lastEventAt: null,
          lastError: parsed.error,
        });
        log.warn({ integrationId: integration.id, error: parsed.error }, "cannot start Gerrit stream-events listener");
        continue;
      }

      const existing = this.handles.get(integration.id);
      if (!existing) {
        this.startHandle(integration, parsed.config, this.statuses.get(integration.id)?.reconnectCount ?? 0);
        continue;
      }

      if (!sameConfig(existing.config, parsed.config)) {
        this.stopHandle(integration.id);
        this.startHandle(integration, parsed.config, this.statuses.get(integration.id)?.reconnectCount ?? 0);
        continue;
      }

      existing.integration = integration;
      existing.config = parsed.config;
      const status = this.statuses.get(integration.id);
      if (status) {
        status.integrationName = integration.name;
      }
    }
  }

  /** Return a snapshot of the current stream status for a single integration, or null if unknown. */
  getStatus(integrationId: string): GerritStreamStatus | null {
    const status = this.statuses.get(integrationId);
    return status ? { ...status } : null;
  }

  /** Return a sorted snapshot of all known stream statuses. */
  listStatuses(): GerritStreamStatus[] {
    return [...this.statuses.values()]
      .map((status) => ({ ...status }))
      .sort((left, right) => left.integrationName.localeCompare(right.integrationName));
  }

  /** Terminate all active stream-events SSH processes and clear state. */
  async stopAll(): Promise<void> {
    this.desiredIntegrations.clear();
    this.backfilledIntegrations.clear();
    for (const integrationId of [...this.handles.keys()]) {
      this.stopHandle(integrationId, { removeStatus: true });
    }
  }

  /** Spawn a new SSH `gerrit stream-events` process for an integration and register its event handlers. */
  private startHandle(integration: Integration, config: GerritStreamConfig, reconnectCount: number): void {
    log.info(
      { integrationId: integration.id, integrationName: integration.name, sshHost: config.sshHost, sshPort: config.sshPort, sshUser: config.sshUser },
      "Gerrit stream-events: opening SSH connection"
    );
    const child = this.spawnProcess(
      "ssh",
      [
        "-p", String(config.sshPort),
        "-i", config.sshKeyPath,
        "-o", "BatchMode=yes",
        "-o", `ConnectTimeout=30`,
        ...buildSshHostKeyOptions(config.sshKnownHostsPath),
        "-o", "LogLevel=ERROR",
        "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=3",
        `${config.sshUser}@${config.sshHost}`,
        "gerrit", "stream-events",
      ],
      { stdio: "pipe" }
    );

    const handle: GerritStreamHandle = {
      integration,
      config,
      child,
      stdoutBuffer: "",
      stderrBuffer: "",
      reconnectTimer: null,
      stopRequested: false,
      hasReceivedData: false,
      processingChain: Promise.resolve(),
    };
    this.handles.set(integration.id, handle);
    this.statuses.set(integration.id, {
      integrationId: integration.id,
      integrationName: integration.name,
      integrationType: integration.type,
      state: "connecting",
      reconnectCount,
      lastEventType: null,
      lastEventAt: null,
      lastError: null,
    });

    child.on("spawn", () => {
      // The SSH process has started but the handshake is not yet complete.
      // State transitions to "connected" on the first stdout byte received.
      log.debug(
        { integrationId: integration.id, sshHost: config.sshHost, sshPort: config.sshPort },
        "Gerrit stream-events: SSH process started — awaiting handshake"
      );
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      this.consumeStdout(handle, String(chunk));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.consumeStderr(handle, String(chunk));
    });
    child.on("error", (err) => {
      const status = this.statuses.get(integration.id);
      if (status) {
        status.state = "error";
        status.lastError = err instanceof Error ? err.message : String(err);
      }
      log.error({ integrationId: integration.id, err }, "Gerrit stream-events process error");
    });
    child.on("close", (code, signal) => {
      this.onClose(handle, code, signal);
    });
  }

  /** Handle SSH process exit — schedule a reconnect or mark the integration as errored. */
  private onClose(handle: GerritStreamHandle, code: number | null, signal: NodeJS.Signals | null): void {
    const integrationId = handle.integration.id;
    const current = this.handles.get(integrationId);
    if (current !== handle) {
      return;
    }

    this.handles.delete(integrationId);

    const status = this.statuses.get(integrationId);
    if (!status) {
      return;
    }

    if (handle.stopRequested || !this.desiredIntegrations.has(integrationId)) {
      status.state = "stopped";
      status.lastError = null;
      if (!this.desiredIntegrations.has(integrationId)) {
        this.statuses.delete(integrationId);
      }
      return;
    }

    status.reconnectCount += 1;
    status.lastError = code !== null
      ? `stream-events exited with code ${code}`
      : signal !== null
        ? `stream-events exited with signal ${signal}`
        : "stream-events disconnected";

    if (status.reconnectCount >= this.maxReconnectAttempts) {
      status.state = "error";
      this.desiredIntegrations.delete(integrationId);
      log.error(
        { integrationId, reconnectCount: status.reconnectCount, maxReconnectAttempts: this.maxReconnectAttempts },
        "Gerrit stream-events exceeded max reconnect attempts — giving up (disable/enable integration to retry)"
      );
      return;
    }

    status.state = "reconnecting";

    log.warn(
      { integrationId, code, signal, reconnectCount: status.reconnectCount },
      "Gerrit stream-events disconnected; scheduling reconnect"
    );

    handle.reconnectTimer = setTimeout(() => {
      handle.reconnectTimer = null;
      const nextIntegration = this.desiredIntegrations.get(integrationId);
      if (!nextIntegration) {
        return;
      }
      const parsed = parseGerritStreamConfig(nextIntegration);
      if (!parsed.success) {
        const nextStatus = this.statuses.get(integrationId);
        if (nextStatus) {
          nextStatus.state = "error";
          nextStatus.lastError = parsed.error;
        }
        return;
      }
      this.startHandle(nextIntegration, parsed.config, status.reconnectCount);
    }, this.reconnectDelayMs);
  }

  /** Kill the SSH process for an integration and optionally remove its status entry. */
  private stopHandle(integrationId: string, options?: { removeStatus?: boolean }): void {
    const handle = this.handles.get(integrationId);
    if (handle) {
      handle.stopRequested = true;
      if (handle.reconnectTimer) {
        clearTimeout(handle.reconnectTimer);
        handle.reconnectTimer = null;
      }
      this.handles.delete(integrationId);
      handle.child.kill("SIGTERM");
    }

    if (options?.removeStatus) {
      this.statuses.delete(integrationId);
    } else {
      const status = this.statuses.get(integrationId);
      if (status) {
        status.state = "stopped";
        status.lastError = null;
      }
    }
  }

  /**
   * Query Gerrit over SSH to check whether VE's SSH user (`sshUser`) is in
   * the reviewer list for the given change. Used to gate `patchset-created`
   * review triggers — if VE was never added as a reviewer, it should not
   * review the change.
   *
   * Returns `false` on any error to be conservative (log a warning).
   */
  private async queryVeIsReviewer(handle: GerritStreamHandle, changeId: string): Promise<boolean> {
    try {
      const out = await this.sshQueryFn(
        ["query", "--format", "JSON", "--all-reviewers", `change:${changeId}`],
        handle.config
      );
      const rows = out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as unknown)
        .filter((o) => (o as Record<string, unknown>)["type"] !== "stats");

      if (rows.length === 0) return false;
      const entry = rows[0] as Record<string, unknown>;
      const allReviewers = entry["allReviewers"];
      if (!Array.isArray(allReviewers)) return false;
      return allReviewers.some((r) => {
        if (typeof r !== "object" || r === null) return false;
        return (r as Record<string, unknown>)["username"] === handle.config.sshUser;
      });
    } catch (err) {
      log.warn(
        { integrationId: handle.integration.id, changeId, err },
        "Gerrit stream-events: SSH reviewer query failed — skipping review trigger"
      );
      return false;
    }
  }

  /**
   * Backfill assigned open reviews on the integration's first successful
   * connect. `stream-events` is real-time only — changes where VE was added
   * as reviewer before the SSH stream connected would otherwise be missed.
   *
   * Capped at BACKFILL_MAX_CHANGES to avoid task-storms on first-config of
   * a long-lived Gerrit account. Idempotent: triggerReviewForChange is
   * gated by isReviewer() + startReviewTask() dedup downstream.
   */
  private async runBackfill(handle: GerritStreamHandle): Promise<void> {
    const reviewTrigger = this.options.getReviewTrigger();
    if (!reviewTrigger) {
      return;
    }
    let changeIds: string[];
    try {
      const out = await this.sshQueryFn(
        ["query", "--format", "JSON", `status:open reviewer:${handle.config.sshUser}`],
        handle.config
      );
      const rows = out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as unknown)
        .filter((o) => (o as Record<string, unknown>)["type"] !== "stats");
      changeIds = rows
        .map((row) => (row as Record<string, unknown>)["id"])
        .filter((id): id is string => typeof id === "string" && id.length > 0);
    } catch (err) {
      log.warn(
        { integrationId: handle.integration.id, err },
        "Gerrit stream-events: backfill query failed — skipping initial review backfill"
      );
      return;
    }

    if (changeIds.length === 0) {
      log.info(
        { integrationId: handle.integration.id, sshUser: handle.config.sshUser },
        "Gerrit stream-events: backfill found no assigned open reviews"
      );
      return;
    }

    const capped = changeIds.slice(0, BACKFILL_MAX_CHANGES);
    if (changeIds.length > BACKFILL_MAX_CHANGES) {
      log.warn(
        { integrationId: handle.integration.id, totalFound: changeIds.length, cap: BACKFILL_MAX_CHANGES },
        "Gerrit stream-events: backfill capped — extra open reviews will be picked up on next reviewer-added event"
      );
    } else {
      log.info(
        { integrationId: handle.integration.id, count: capped.length },
        "Gerrit stream-events: backfilling assigned open reviews"
      );
    }

    for (const changeId of capped) {
      try {
        await reviewTrigger.triggerReviewForChange(handle.integration.id, changeId);
      } catch (err) {
        log.warn(
          { integrationId: handle.integration.id, changeId, err },
          "Gerrit stream-events: backfill trigger failed for change — continuing with next"
        );
      }
    }
  }

  /** Append incoming stdout chunk to the line buffer and dispatch complete lines. */
  private consumeStdout(handle: GerritStreamHandle, chunk: string): void {
    if (!handle.hasReceivedData) {
      handle.hasReceivedData = true;
      const status = this.statuses.get(handle.integration.id);
      if (status) {
        status.state = "connected";
        status.lastError = null;
      }
      log.info(
        { integrationId: handle.integration.id, integrationName: handle.integration.name, sshHost: handle.config.sshHost, sshPort: handle.config.sshPort },
        "Gerrit stream-events connected — listening for events"
      );
      if (!this.backfilledIntegrations.has(handle.integration.id)) {
        this.backfilledIntegrations.add(handle.integration.id);
        void this.runBackfill(handle);
      }
    }
    handle.stdoutBuffer += chunk;
    const lines = handle.stdoutBuffer.split("\n");
    handle.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      handle.processingChain = handle.processingChain
        .then(() => this.processStreamLine(handle, trimmed))
        .catch((err: unknown) => {
          log.error({ integrationId: handle.integration.id, err }, "error processing Gerrit stream event");
        });
    }
  }

  /** Append incoming stderr chunk to the line buffer and log each complete line. */
  private consumeStderr(handle: GerritStreamHandle, chunk: string): void {
    handle.stderrBuffer += chunk;
    const lines = handle.stderrBuffer.split("\n");
    handle.stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const status = this.statuses.get(handle.integration.id);
      if (status) {
        status.lastError = trimmed;
      }
      log.warn({ integrationId: handle.integration.id, line: trimmed }, "Gerrit stream-events stderr");
    }
  }

  /** Parse and dispatch a single JSON line received from `gerrit stream-events`. */
  private async processStreamLine(handle: GerritStreamHandle, line: string): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(line) as unknown;
    } catch {
      log.warn({ integrationId: handle.integration.id, line }, "ignoring non-JSON Gerrit stream-events line");
      return;
    }

    log.info(
      { integrationId: handle.integration.id, integrationName: handle.integration.name, payload },
      "Gerrit stream-events: raw event received"
    );

    const eventType = extractEventType(payload);
    if (!eventType) {
      return;
    }

    const changeId = extractChangeId(payload);
    if (!changeId) {
      return;
    }

    const status = this.statuses.get(handle.integration.id);
    if (status) {
      status.lastEventType = eventType;
      status.lastEventAt = new Date().toISOString();
      status.lastError = null;
    }

    switch (eventType) {
      case "change-merged":
        await this.options.orchestrator.markChangeMerged(handle.integration.id, changeId);
        return;
      case "change-abandoned":
        await this.options.orchestrator.markChangeAbandoned(handle.integration.id, changeId);
        return;
      case "reviewer-added": {
        await this.options.orchestrator.triggerFeedbackForChange(handle.integration.id, changeId);
        const reviewTriggerOnAdded = this.options.getReviewTrigger();
        if (reviewTriggerOnAdded) {
          const addedUsername = extractReviewerUsername(payload);
          if (addedUsername === handle.config.sshUser) {
            await reviewTriggerOnAdded.triggerReviewForChange(handle.integration.id, changeId);
          } else {
            log.debug(
              { integrationId: handle.integration.id, changeId, addedUsername, veUser: handle.config.sshUser },
              "Gerrit stream-events: reviewer-added skipped — added reviewer is not VE"
            );
          }
        }
        return;
      }
      case "patchset-created": {
        await this.options.orchestrator.triggerFeedbackForChange(handle.integration.id, changeId);
        const reviewTriggerOnPatchset = this.options.getReviewTrigger();
        if (reviewTriggerOnPatchset) {
          const kind = extractPatchsetKind(payload);
          if (kind === "TRIVIAL_REBASE" || kind === "NO_CHANGE" || kind === "NO_CODE_CHANGE") {
            log.debug(
              { integrationId: handle.integration.id, changeId, kind },
              "Gerrit stream-events: patchset-created skipped — trivial patchset kind"
            );
          } else {
            const veIsReviewer = await this.queryVeIsReviewer(handle, changeId);
            if (veIsReviewer) {
              await reviewTriggerOnPatchset.triggerReviewForChange(handle.integration.id, changeId);
            } else {
              log.debug(
                { integrationId: handle.integration.id, changeId, veUser: handle.config.sshUser },
                "Gerrit stream-events: patchset-created skipped — VE is not a reviewer on this change"
              );
            }
          }
        }
        return;
      }
      case "comment-added": {
        // Extract the review comment from the stream event payload — this is the
        // authoritative source. Gerrit's `gerrit query --comments` only returns
        // inline file comments, not top-level change messages from Reply, so
        // querying SSH here would return nothing for general review feedback.
        const streamComment = extractStreamComment(payload, handle.config.sshUser);
        if (streamComment) {
          await this.options.orchestrator.triggerFeedbackForChange(handle.integration.id, changeId, [streamComment]);
        } else {
          await this.options.orchestrator.triggerFeedbackForChange(handle.integration.id, changeId);
        }
        return;
      }
    }
  }
}

/** Parse and validate Gerrit SSH stream config from an integration's configJson. */
function parseGerritStreamConfig(integration: Integration):
  | { success: true; config: GerritStreamConfig }
  | { success: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(integration.configJson);
  } catch {
    return { success: false, error: "Invalid Gerrit integration JSON config" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { success: false, error: "Invalid Gerrit integration config shape" };
  }

  const cfg = raw as Record<string, unknown>;
  const sshHost = typeof cfg["sshHost"] === "string" ? cfg["sshHost"].trim() : "";
  const sshUser = typeof cfg["sshUser"] === "string" ? cfg["sshUser"].trim() : "";
  const sshKeyPath = typeof cfg["sshKeyPath"] === "string" && cfg["sshKeyPath"].trim() !== ""
    ? cfg["sshKeyPath"].trim()
    : GERRIT_SSH_KEY_DEFAULT;
  const sshPortValue = cfg["sshPort"];
  const sshPort = typeof sshPortValue === "number"
    ? sshPortValue
    : typeof sshPortValue === "string" && sshPortValue.trim() !== ""
      ? Number(sshPortValue)
      : GERRIT_SSH_PORT_DEFAULT;

  if (!sshHost || !sshUser || !sshKeyPath || !Number.isFinite(sshPort) || sshPort <= 0) {
    return { success: false, error: "Gerrit stream-events requires sshHost, sshUser, sshPort, and sshKeyPath" };
  }

  return {
    success: true,
    config: {
      sshHost,
      sshUser,
      sshPort,
      sshKeyPath,
      ...(typeof cfg["sshKnownHostsPath"] === "string" && cfg["sshKnownHostsPath"].trim() !== ""
        ? { sshKnownHostsPath: cfg["sshKnownHostsPath"].trim() }
        : {}),
    },
  };
}

/** Execute a `gerrit …` SSH command and return stdout; used for one-off queries. */
async function defaultSshQuery(args: string[], config: GerritStreamConfig): Promise<string> {
  const { stdout } = await execFileAsync(
    "ssh",
    [
      "-p", String(config.sshPort),
      "-i", config.sshKeyPath,
      ...buildSshHostKeyOptions(config.sshKnownHostsPath),
      "-o", "LogLevel=ERROR",
      `${config.sshUser}@${config.sshHost}`,
      "gerrit", ...args,
    ],
    { timeout: SSH_QUERY_TIMEOUT_MS }
  );
  return stdout;
}

/** Return true when two GerritStreamConfig objects represent the same SSH endpoint. */
function sameConfig(left: GerritStreamConfig, right: GerritStreamConfig): boolean {
  return left.sshHost === right.sshHost
    && left.sshPort === right.sshPort
    && left.sshUser === right.sshUser
    && left.sshKeyPath === right.sshKeyPath
    && (left.sshKnownHostsPath ?? "") === (right.sshKnownHostsPath ?? "");
}

/** Extract and narrow the event type string from a raw stream-events payload. */
function extractEventType(payload: unknown): GerritEventType | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const value = (payload as Record<string, unknown>)["type"];
  switch (value) {
    case "change-merged":
    case "change-abandoned":
    case "patchset-created":
    case "reviewer-added":
    case "comment-added":
      return value;
    default:
      return null;
  }
}

/** Extract the reviewer's username from a `reviewer-added` event payload. */
function extractReviewerUsername(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const reviewer = (payload as Record<string, unknown>)["reviewer"];
  if (typeof reviewer !== "object" || reviewer === null) return null;
  const username = (reviewer as Record<string, unknown>)["username"];
  return typeof username === "string" && username.length > 0 ? username : null;
}

/** Extract the patchset kind (e.g. TRIVIAL_REBASE) from a `patchset-created` event payload. */
function extractPatchsetKind(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const patchSet = (payload as Record<string, unknown>)["patchSet"];
  if (typeof patchSet !== "object" || patchSet === null) return null;
  const kind = (patchSet as Record<string, unknown>)["kind"];
  return typeof kind === "string" && kind.length > 0 ? kind : null;
}

/**
 * Extract a review comment from a `comment-added` stream event payload.
 * Returns null when the comment is from the VE bot, empty after preamble stripping, or absent.
 */
function extractStreamComment(payload: unknown, sshUser: string): ReviewComment | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;

  const raw = p["comment"];
  if (typeof raw !== "string" || !raw.trim()) return null;

  const author = p["author"];
  const authorUsername = (typeof author === "object" && author !== null)
    ? (author as Record<string, unknown>)["username"]
    : undefined;
  if (sshUser && authorUsername === sshUser) return null;

  const body = raw.replace(PREAMBLE_RE, "").replace(COMMENTS_SUMMARY_RE, "").trim();
  if (!body) return null;

  const ts = typeof p["eventCreatedOn"] === "number" ? (p["eventCreatedOn"] as number) : Math.floor(Date.now() / 1000);
  const authorEmail = (typeof author === "object" && author !== null)
    ? String((author as Record<string, unknown>)["email"] ?? (author as Record<string, unknown>)["username"] ?? "unknown")
    : "unknown";

  return {
    id: `gerrit-msg-${ts}`,
    author: authorEmail,
    message: body,
    filePath: undefined,
    line: undefined,
    unresolved: true,
    patchset: 0,
    updatedAt: new Date(ts * 1000),
  };
}

/** Extract the Gerrit Change-Id or change number from a raw stream-events payload. */
function extractChangeId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const root = payload as Record<string, unknown>;
  const change = root["change"];
  if (typeof change === "object" && change !== null) {
    const changeRecord = change as Record<string, unknown>;
    const id = changeRecord["id"];
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
    const number = changeRecord["number"];
    if (typeof number === "number" || typeof number === "string") {
      return String(number);
    }
  }
  const changeKey = root["changeKey"];
  if (typeof changeKey === "object" && changeKey !== null) {
    const changeKeyId = (changeKey as Record<string, unknown>)["id"];
    if (typeof changeKeyId === "string" && changeKeyId.length > 0) {
      return changeKeyId;
    }
  }
  return null;
}