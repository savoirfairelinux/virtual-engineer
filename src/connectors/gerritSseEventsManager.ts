/**
 * GerritSseEventsManager — Server-Sent Events based event stream for Gerrit.
 *
 * Implements `IntegrationEventStreamManager` using Gerrit's SSE endpoint
 * (`GET /a/events`) instead of the SSH `stream-events` command.  Available
 * since Gerrit ≥ 3.5.  The events payload is identical to the SSH stream,
 * so all existing event-processing logic (change-merged, patchset-created,
 * reviewer-added, comment-added) is reused.
 *
 * Used when `authMode = "http"` is configured on a Gerrit integration.
 */
import type { Integration, ReviewComment } from "../interfaces.js";
import { getLogger } from "../logger.js";
import { PREAMBLE_RE, COMMENTS_SUMMARY_RE } from "./gerritSshClient.js";
import { GerritHttpClient } from "./gerritHttpClient.js";
import type {
  IntegrationEventStreamDependencies,
  IntegrationEventStreamManager,
  IntegrationEventStreamStatus,
} from "./integrationStreamEvents.js";

const log = getLogger("gerrit-sse-events");
const DEFAULT_RECONNECT_DELAY_MS = 2_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const BACKFILL_MAX_CHANGES = 20;

type GerritEventType =
  | "change-merged"
  | "change-abandoned"
  | "patchset-created"
  | "reviewer-added"
  | "comment-added";

interface GerritSseConfig {
  httpBaseUrl: string;
  httpUsername: string;
  httpToken: string;
}

interface GerritSseHandle {
  integration: Integration;
  config: GerritSseConfig;
  abortController: AbortController;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  stopRequested: boolean;
  /** Tail of the event-processing promise chain — serialises events and catches errors. */
  processingChain: Promise<void>;
}

export interface GerritSseEventsManagerOptions extends IntegrationEventStreamDependencies {
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
}

export class GerritSseEventsManager implements IntegrationEventStreamManager {
  private readonly handles = new Map<string, GerritSseHandle>();
  private readonly statuses = new Map<string, IntegrationEventStreamStatus>();
  private readonly desiredIntegrations = new Map<string, Integration>();
  private readonly backfilledIntegrations = new Set<string>();
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectAttempts: number;

  constructor(private readonly options: GerritSseEventsManagerOptions) {
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
  }

  /** Sync the set of running SSE listeners to match the provided integration list. */
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
      const parsed = parseGerritSseConfig(integration);
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
        log.warn(
          { integrationId: integration.id, error: parsed.error },
          "cannot start Gerrit SSE listener"
        );
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
      if (status) status.integrationName = integration.name;
    }
  }

  getStatus(integrationId: string): IntegrationEventStreamStatus | null {
    const status = this.statuses.get(integrationId);
    return status ? { ...status } : null;
  }

  listStatuses(): IntegrationEventStreamStatus[] {
    return [...this.statuses.values()]
      .map((s) => ({ ...s }))
      .sort((a, b) => a.integrationName.localeCompare(b.integrationName));
  }

  async stopAll(): Promise<void> {
    this.desiredIntegrations.clear();
    this.backfilledIntegrations.clear();
    for (const integrationId of [...this.handles.keys()]) {
      this.stopHandle(integrationId, { removeStatus: true });
    }
  }

  // ─── Private — stream lifecycle ──────────────────────────────────────────────

  private startHandle(
    integration: Integration,
    config: GerritSseConfig,
    reconnectCount: number
  ): void {
    log.info(
      { integrationId: integration.id, integrationName: integration.name, httpBaseUrl: config.httpBaseUrl },
      "Gerrit SSE: opening HTTP event stream"
    );

    const abortController = new AbortController();
    const handle: GerritSseHandle = {
      integration,
      config,
      abortController,
      reconnectTimer: null,
      stopRequested: false,
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

    // Launch the stream loop asynchronously
    void this.streamLoop(handle);
  }

  /**
   * Connect to GET /a/events and consume the SSE stream line by line.
   * On disconnection the handle is cleaned up and a reconnect is scheduled.
   */
  private async streamLoop(handle: GerritSseHandle): Promise<void> {
    const integrationId = handle.integration.id;
    const http = new GerritHttpClient({
      baseUrl: handle.config.httpBaseUrl,
      username: handle.config.httpUsername,
      token: handle.config.httpToken,
    });

    let response: Response;
    try {
      response = await http.fetchStream("events", handle.abortController.signal);
    } catch (err: unknown) {
      // Connect failed
      if (handle.stopRequested || handle.abortController.signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ integrationId, err }, "Gerrit SSE: connection failed");
      this.onStreamEnd(handle, msg);
      return;
    }

    // Connected
    const status = this.statuses.get(integrationId);
    if (status) {
      status.state = "connected";
      status.lastError = null;
    }
    log.info(
      { integrationId, integrationName: handle.integration.name, httpBaseUrl: handle.config.httpBaseUrl },
      "Gerrit SSE: connected — listening for events"
    );

    if (!this.backfilledIntegrations.has(integrationId)) {
      this.backfilledIntegrations.add(integrationId);
      void this.runBackfill(handle);
    }

    // Consume the stream line by line
    const reader = response.body?.getReader();
    if (!reader) {
      this.onStreamEnd(handle, "SSE response body is not readable");
      return;
    }

    const decoder = new TextDecoder();
    let lineBuffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          // SSE lines are prefixed with "data: "
          const data = line.startsWith("data: ") ? line.slice(6) : line;
          if (!data) continue;
          handle.processingChain = handle.processingChain
            .then(() => this.processEventLine(handle, data))
            .catch((err: unknown) => {
              log.error({ integrationId, err }, "error processing Gerrit SSE event");
            });
        }
      }
    } catch (err: unknown) {
      if (handle.stopRequested || handle.abortController.signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ integrationId, err }, "Gerrit SSE: stream read error");
      this.onStreamEnd(handle, msg);
      return;
    }

    if (!handle.stopRequested) {
      this.onStreamEnd(handle, "SSE stream ended unexpectedly");
    }
  }

  private onStreamEnd(handle: GerritSseHandle, reason: string): void {
    const integrationId = handle.integration.id;
    const current = this.handles.get(integrationId);
    if (current !== handle) return;

    this.handles.delete(integrationId);

    const status = this.statuses.get(integrationId);
    if (!status) return;

    if (handle.stopRequested || !this.desiredIntegrations.has(integrationId)) {
      status.state = "stopped";
      status.lastError = null;
      if (!this.desiredIntegrations.has(integrationId)) {
        this.statuses.delete(integrationId);
      }
      return;
    }

    status.reconnectCount += 1;
    status.lastError = reason;

    if (status.reconnectCount >= this.maxReconnectAttempts) {
      status.state = "error";
      this.desiredIntegrations.delete(integrationId);
      log.error(
        { integrationId, reconnectCount: status.reconnectCount },
        "Gerrit SSE exceeded max reconnect attempts — giving up"
      );
      return;
    }

    status.state = "reconnecting";
    log.warn(
      { integrationId, reason, reconnectCount: status.reconnectCount },
      "Gerrit SSE disconnected; scheduling reconnect"
    );

    handle.reconnectTimer = setTimeout(() => {
      handle.reconnectTimer = null;
      const nextIntegration = this.desiredIntegrations.get(integrationId);
      if (!nextIntegration) return;
      const parsed = parseGerritSseConfig(nextIntegration);
      if (!parsed.success) {
        const nextStatus = this.statuses.get(integrationId);
        if (nextStatus) { nextStatus.state = "error"; nextStatus.lastError = parsed.error; }
        return;
      }
      this.startHandle(nextIntegration, parsed.config, status.reconnectCount);
    }, this.reconnectDelayMs);
  }

  private stopHandle(integrationId: string, options?: { removeStatus?: boolean }): void {
    const handle = this.handles.get(integrationId);
    if (handle) {
      handle.stopRequested = true;
      if (handle.reconnectTimer) {
        clearTimeout(handle.reconnectTimer);
        handle.reconnectTimer = null;
      }
      handle.abortController.abort();
      this.handles.delete(integrationId);
    }
    if (options?.removeStatus) {
      this.statuses.delete(integrationId);
    } else {
      const status = this.statuses.get(integrationId);
      if (status) { status.state = "stopped"; status.lastError = null; }
    }
  }

  // ─── Private — backfill ───────────────────────────────────────────────────────

  private async runBackfill(handle: GerritSseHandle): Promise<void> {
    const reviewTrigger = this.options.getReviewTrigger();
    if (!reviewTrigger) return;

    const http = new GerritHttpClient({
      baseUrl: handle.config.httpBaseUrl,
      username: handle.config.httpUsername,
      token: handle.config.httpToken,
    });

    let changeIds: string[];
    try {
      const selfEncoded = encodeURIComponent(`reviewer:self+status:open`);
      const rows = await http.fetchJson<Array<Record<string, unknown>>>(
        `changes/?q=${selfEncoded}&o=CURRENT_REVISION`
      );
      changeIds = rows
        .map((row) => {
          const v = row["change_id"] ?? row["id"];
          return typeof v === "string" && v.length > 0 ? v : null;
        })
        .filter((id): id is string => id !== null);
    } catch (err) {
      log.warn(
        { integrationId: handle.integration.id, err },
        "Gerrit SSE: backfill query failed — skipping initial review backfill"
      );
      return;
    }

    if (changeIds.length === 0) {
      log.info(
        { integrationId: handle.integration.id },
        "Gerrit SSE: backfill found no assigned open reviews"
      );
      return;
    }

    const capped = changeIds.slice(0, BACKFILL_MAX_CHANGES);
    log.info(
      { integrationId: handle.integration.id, count: capped.length },
      "Gerrit SSE: backfilling assigned open reviews"
    );

    for (const changeId of capped) {
      try {
        await reviewTrigger.triggerReviewForChange(handle.integration.id, changeId);
      } catch (err) {
        log.warn(
          { integrationId: handle.integration.id, changeId, err },
          "Gerrit SSE: backfill trigger failed — continuing with next"
        );
      }
    }
  }

  // ─── Private — event processing ────────────────────────────────────────────

  private async processEventLine(handle: GerritSseHandle, line: string): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(line) as unknown;
    } catch {
      log.warn({ integrationId: handle.integration.id, line }, "ignoring non-JSON Gerrit SSE line");
      return;
    }

    log.info(
      { integrationId: handle.integration.id, integrationName: handle.integration.name, payload },
      "Gerrit SSE: raw event received"
    );

    const eventType = extractEventType(payload);
    if (!eventType) return;

    const changeId = extractChangeId(payload);
    if (!changeId) return;

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
          if (addedUsername === handle.config.httpUsername) {
            await reviewTriggerOnAdded.triggerReviewForChange(handle.integration.id, changeId);
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
              "Gerrit SSE: patchset-created skipped — trivial patchset kind"
            );
          } else {
            const veIsReviewer = await this.queryVeIsReviewer(handle, changeId);
            if (veIsReviewer) {
              await reviewTriggerOnPatchset.triggerReviewForChange(handle.integration.id, changeId);
            }
          }
        }
        return;
      }
      case "comment-added": {
        const streamComment = extractStreamComment(payload, handle.config.httpUsername);
        if (streamComment) {
          await this.options.orchestrator.triggerFeedbackForChange(handle.integration.id, changeId, [streamComment]);
        } else {
          await this.options.orchestrator.triggerFeedbackForChange(handle.integration.id, changeId);
        }
        return;
      }
    }
  }

  private async queryVeIsReviewer(handle: GerritSseHandle, changeId: string): Promise<boolean> {
    const http = new GerritHttpClient({
      baseUrl: handle.config.httpBaseUrl,
      username: handle.config.httpUsername,
      token: handle.config.httpToken,
    });

    try {
      const encoded = encodeURIComponent(changeId);
      const reviewers = await http.fetchJson<Array<Record<string, unknown>>>(
        `changes/${encoded}/reviewers`
      );
      return reviewers.some((r) => {
        if (typeof r !== "object" || r === null) return false;
        return (r as Record<string, unknown>)["username"] === handle.config.httpUsername;
      });
    } catch (err) {
      log.warn(
        { integrationId: handle.integration.id, changeId, err },
        "Gerrit SSE: HTTP reviewer query failed — skipping review trigger"
      );
      return false;
    }
  }
}

// ─── Config parsing ────────────────────────────────────────────────────────────

function parseGerritSseConfig(
  integration: Integration
): { success: true; config: GerritSseConfig } | { success: false; error: string } {
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
  const httpBaseUrl = typeof cfg["httpBaseUrl"] === "string" ? cfg["httpBaseUrl"].trim() : "";
  const httpUsername = typeof cfg["httpUsername"] === "string" ? cfg["httpUsername"].trim() : "";
  const httpToken = typeof cfg["httpToken"] === "string" ? cfg["httpToken"].trim() : "";
  if (!httpBaseUrl || !httpUsername || !httpToken) {
    return {
      success: false,
      error: "Gerrit SSE requires httpBaseUrl, httpUsername, and httpToken",
    };
  }
  return { success: true, config: { httpBaseUrl, httpUsername, httpToken } };
}

function sameConfig(a: GerritSseConfig, b: GerritSseConfig): boolean {
  return a.httpBaseUrl === b.httpBaseUrl
    && a.httpUsername === b.httpUsername
    && a.httpToken === b.httpToken;
}

// ─── Event payload helpers (identical to SSH stream-events) ───────────────────

function extractEventType(payload: unknown): GerritEventType | null {
  if (typeof payload !== "object" || payload === null) return null;
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

function extractChangeId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const root = payload as Record<string, unknown>;
  const change = root["change"];
  if (typeof change === "object" && change !== null) {
    const changeRecord = change as Record<string, unknown>;
    const id = changeRecord["id"];
    if (typeof id === "string" && id.length > 0) return id;
    const number = changeRecord["number"];
    if (typeof number === "number" || typeof number === "string") return String(number);
  }
  const changeKey = root["changeKey"];
  if (typeof changeKey === "object" && changeKey !== null) {
    const changeKeyId = (changeKey as Record<string, unknown>)["id"];
    if (typeof changeKeyId === "string" && changeKeyId.length > 0) return changeKeyId;
  }
  return null;
}

function extractReviewerUsername(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const reviewer = (payload as Record<string, unknown>)["reviewer"];
  if (typeof reviewer !== "object" || reviewer === null) return null;
  const username = (reviewer as Record<string, unknown>)["username"];
  return typeof username === "string" && username.length > 0 ? username : null;
}

function extractPatchsetKind(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const patchSet = (payload as Record<string, unknown>)["patchSet"];
  if (typeof patchSet !== "object" || patchSet === null) return null;
  const kind = (patchSet as Record<string, unknown>)["kind"];
  return typeof kind === "string" && kind.length > 0 ? kind : null;
}

function extractStreamComment(payload: unknown, httpUsername: string): ReviewComment | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const raw = p["comment"];
  if (typeof raw !== "string" || !raw.trim()) return null;
  const author = p["author"];
  const authorUsername = (typeof author === "object" && author !== null)
    ? (author as Record<string, unknown>)["username"]
    : undefined;
  if (httpUsername && authorUsername === httpUsername) return null;
  const body = raw.replace(PREAMBLE_RE, "").replace(COMMENTS_SUMMARY_RE, "").trim();
  if (!body) return null;
  const ts = typeof p["eventCreatedOn"] === "number" ? (p["eventCreatedOn"] as number) : Math.floor(Date.now() / 1000);
  const authorEmail = (typeof author === "object" && author !== null)
    ? String((author as Record<string, unknown>)["email"] ?? (author as Record<string, unknown>)["username"] ?? "unknown")
    : "unknown";
  return {
    id: `gerrit-sse-${ts}`,
    author: authorEmail,
    message: body,
    filePath: undefined,
    line: undefined,
    unresolved: true,
    patchset: 0,
    updatedAt: new Date(ts * 1000),
  };
}
