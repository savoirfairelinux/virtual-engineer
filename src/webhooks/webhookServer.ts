import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getLogger } from "../logger.js";
import type { Integration, IntegrationStore, ProjectRecord } from "../interfaces.js";
import type { PluginManager } from "../plugins/pluginManager.js";
import { getHandlerForProviderEvent, getSupportedEventsForProvider, providerHasWebhookHandler } from "./handlers/index.js";


const log = getLogger("webhook-server");

const MAX_WEBHOOK_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB — webhook payloads can be larger than admin API bodies

export interface WebhookCapableOrchestrator {
  startTaskForProject(
    ticket: { id: string; subject?: string; description?: string; webUrl?: string | undefined },
    project: ProjectRecord,
    ticketSourceLabel: string
  ): Promise<void>;
  triggerFeedbackForChange(integrationId: string, changeId: string): Promise<void>;
  markChangeMerged(integrationId: string, changeId: string): Promise<void>;
  markChangeAbandoned(integrationId: string, changeId: string): Promise<void>;
  /**
   * Trigger a standalone code-review task for the given change. Implemented by
   * the index.ts wrapper that bridges to the active reviewTrigger holder. A
   * no-op when no review-capable integration is configured.
   */
  triggerReviewForChange?(integrationId: string, changeId: string): Promise<void>;
}

export interface ProjectLookupStore {
  findProjectByTicketSource(integrationId: string, ticketProjectKey: string): Promise<ProjectRecord | null>;
}

export interface WebhookServerDependencies {
  integrationStore: IntegrationStore;
  pluginManager?: PluginManager | undefined;
  projectStore: ProjectLookupStore;
  orchestrator: WebhookCapableOrchestrator;
}

export interface WebhookContext {
  integrationId: string;
  integration: Integration;
  event: string;
  payload: unknown;
  rawBody: string;
  headers: IncomingMessage["headers"];
  projectStore: ProjectLookupStore;
  orchestrator: WebhookCapableOrchestrator;
  log: ReturnType<typeof getLogger>;
}

export type WebhookHandler = (ctx: WebhookContext) => Promise<{ status: number; body?: unknown }>;

/**
 * Returns true if this URL path is a webhook path the admin server should
 * delegate to {@link handleWebhookRequest}.
 */
export function isWebhookPath(path: string): boolean {
  return path.startsWith("/webhooks/");
}

/**
 * HTTP entry point. Returns false if the path is not a webhook path (so the
 * admin server can keep dispatching). Otherwise it handles the response
 * fully (including writing status + body) and returns true.
 */
export async function handleWebhookRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: WebhookServerDependencies
): Promise<boolean> {
  const path = (request.url ?? "").split("?")[0] ?? "";
  if (!isWebhookPath(path)) {
    return false;
  }

  log.info(
    { method: request.method, path, remoteAddress: request.socket.remoteAddress },
    "webhook HTTP request received"
  );

  if (request.method !== "POST") {
    writeJson(response, 405, { error: "Method not allowed" });
    return true;
  }

  const match = /^\/webhooks\/([^/]+)\/([^/]+)\/?$/.exec(path);
  if (!match) {
    writeJson(response, 404, { error: "Not found" });
    return true;
  }
  const integrationId = decodeURIComponent(match[1] ?? "");
  const event = decodeURIComponent(match[2] ?? "");

  let rawBody: string;
  try {
    rawBody = await readRawBody(request);
  } catch (err) {
    log.warn({ err }, "failed to read webhook body");
    writeJson(response, 413, { error: "Payload too large" });
    return true;
  }

  // Resolve integration first (we need its type and secret to verify), but
  // never leak existence: any auth-related failure returns the same 401 response.
  let integration: Integration | null;
  try {
    integration = await deps.integrationStore.getIntegration(integrationId);
  } catch (err) {
    log.warn({ integrationId, err }, "failed to load integration for webhook");
    writeUnauthorized(response);
    return true;
  }

  // If the integration provider has no registered webhook handler, reject early
  // without logging an auth warning (avoids noise from integrations like Gerrit
  // that use SSH stream-events instead of webhooks).
  if (integration && !providerHasWebhookHandler(integration.provider)) {
    log.debug({ integrationId, integrationType: integration.provider }, "webhook ignored: no handler for provider");
    writeJson(response, 202, { ignored: true, reason: `No webhook handler for provider '${integration.provider}'` });
    return true;
  }

  const secret = extractWebhookSecret(integration, deps.pluginManager);
  if (!secret) {
    log.warn({ integrationId }, "webhook rejected: integration missing or no secret");
    writeUnauthorized(response);
    return true;
  }

  // Get the remote IP address for IP-based allowlisting (useful when webhook
  // sender doesn't support auth headers, e.g., Gerrit 3.12 webhooks plugin)
  const remoteIp = extractRemoteAddress(request);

  // IP-based allowlisting: check if integration has allowed IPs configured,
  // and if the request comes from one of them, skip signature verification.
  const allowedIps = extractAllowedIpsFromConfig(integration);
  const isIpAllowed = allowedIps.length > 0 && remoteIp && allowedIps.includes(remoteIp);

  if (!isIpAllowed) {
    const sigVerifyResult = verifySignatureWithDiags(request.headers, rawBody, secret);
    if (!sigVerifyResult.valid) {
      log.warn(
        { integrationId, event, remoteIp, verification: sigVerifyResult.diagnostics },
        "webhook rejected: signature mismatch"
      );
      writeUnauthorized(response);
      return true;
    }
  } else {
    log.debug({ integrationId, remoteIp }, "webhook signature skipped: ip allowlisted");
  }

  let payload: unknown;
  if (rawBody.length === 0) {
    payload = null;
  } else {
    try {
      payload = JSON.parse(rawBody);
    } catch {
      writeJson(response, 400, { error: "Invalid JSON" });
      return true;
    }
  }

  // integration is non-null when secret is non-empty (extractWebhookSecret guards both).
  // handler is non-null because we already filtered providers with no handler above.
  const safeIntegration = integration as Integration;
  const handler = getHandlerForProviderEvent(safeIntegration.provider, event);
  if (!handler) {
    writeJson(response, 202, { ignored: true });
    return true;
  }

  log.info(
    {
      integrationId,
      integrationType: safeIntegration.provider,
      event,
      bodyBytes: Buffer.byteLength(rawBody, "utf8"),
      payloadSummary: summarizePayload(payload),
    },
    "webhook received"
  );
  log.debug(
    {
      integrationId,
      integrationType: safeIntegration.provider,
      event,
      headers: sanitizeHeaders(request.headers),
      rawBodyPreview: makeBodyPreview(rawBody),
    },
    "webhook payload preview"
  );

  try {
    const result = await handler({
      integrationId,
      integration: safeIntegration,
      event,
      payload,
      rawBody,
      headers: request.headers,
      projectStore: deps.projectStore,
      orchestrator: deps.orchestrator,
      log,
    });
    log.info(
      {
        integrationId,
        integrationType: safeIntegration.provider,
        event,
        status: result.status,
        responseSummary: summarizePayload(result.body ?? { ok: true }),
      },
      "webhook handled"
    );
    writeJson(response, result.status, result.body ?? { ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ integrationId, event, err }, "webhook handler threw");
    writeJson(response, 500, { error: msg });
  }
  return true;
}

/** Extract the plain-text `webhookSecret` from the integration's JSON config; returns null if absent. */
function extractWebhookSecret(integration: Integration | null, pluginManager?: PluginManager): string | null {
  if (!integration) return null;
  let parsed: unknown;
  try {
    parsed = pluginManager
      ? pluginManager.decryptIntegrationConfig(integration)
      : JSON.parse(integration.configJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = (parsed as Record<string, unknown>)["webhookSecret"];
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

/**
 * Extract the remote IP address from the request, handling X-Forwarded-For
 * and other proxy headers. Returns undefined if no IP could be determined.
 */
function extractRemoteAddress(request: IncomingMessage): string | undefined {
  // Check X-Forwarded-For first (for proxied requests)
  const forwarded = pickHeader(request.headers, "x-forwarded-for");
  if (forwarded) {
    // X-Forwarded-For can contain multiple IPs; the client is the first
    return forwarded.split(",")[0]?.trim();
  }
  // Fall back to socket remote address
  const addr = request.socket.remoteAddress;
  if (addr) {
    // Remove IPv6 prefix if present (::ffff:192.168.x.x → 192.168.x.x)
    if (addr.startsWith("::ffff:")) {
      return addr.substring(7);
    }
    return addr;
  }
  return undefined;
}

/**
 * Extract the list of allowed IPs from the integration config.
 * These IPs are trusted for webhook delivery and will bypass signature verification.
 *
 * Format: { "webhookAllowedIps": ["192.168.48.60", "10.0.0.1"] }
 */
function extractAllowedIpsFromConfig(integration: Integration | null): string[] {
  if (!integration) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(integration.configJson);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const value = (parsed as Record<string, unknown>)["webhookAllowedIps"];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

interface SignatureVerificationDiagnostics {
  headersPresent: string[];
  hmacAttempted: boolean;
  hmacMatch: boolean;
  gitlabAttempted: boolean;
  gitlabMatch: boolean;
  bearerAttempted: boolean;
  bearerHeaderValue?: string;
  bearerTokenLength?: number;
  bearerTokenPrefix?: string;
  bearerMatch: boolean;
}

interface SignatureVerificationResult {
  valid: boolean;
  diagnostics: SignatureVerificationDiagnostics;
}

/**
 * Verify the request signature against `secret` and return detailed diagnostics. Accepts:
 *  - X-Hub-Signature-256: sha256=<hex> (HMAC-SHA256 of raw body)
 *  - X-Gitlab-Token: <secret>          (plain shared secret)
 *  - Authorization: Bearer <secret>    (plain shared secret)
 * All comparisons are timing-safe.
 */
export function verifySignatureWithDiags(
  headers: IncomingMessage["headers"],
  rawBody: string,
  secret: string
): SignatureVerificationResult {
  const diags: SignatureVerificationDiagnostics = {
    headersPresent: Object.keys(headers).sort(),
    hmacAttempted: false,
    hmacMatch: false,
    gitlabAttempted: false,
    gitlabMatch: false,
    bearerAttempted: false,
    bearerMatch: false,
  };

  // 1) GitHub-style HMAC
  const sigHeader = pickHeader(headers, "x-hub-signature-256");
  if (sigHeader && sigHeader.startsWith("sha256=")) {
    diags.hmacAttempted = true;
    const provided = sigHeader.slice("sha256=".length).trim();
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    if (timingSafeHexEqual(expected, provided)) {
      diags.hmacMatch = true;
      return { valid: true, diagnostics: diags };
    }
  }

  // 2) GitLab plain-shared-secret
  const gitlabToken = pickHeader(headers, "x-gitlab-token");
  if (gitlabToken) {
    diags.gitlabAttempted = true;
    if (timingSafeStringEqual(gitlabToken, secret)) {
      diags.gitlabMatch = true;
      return { valid: true, diagnostics: diags };
    }
  }

  // 3) Authorization: Bearer <secret>
  const auth = pickHeader(headers, "authorization");
  if (auth && /^Bearer\s+/i.test(auth)) {
    diags.bearerAttempted = true;
    diags.bearerHeaderValue = auth.substring(0, 10) + (auth.length > 10 ? "..." : "");
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    diags.bearerTokenLength = token.length;
    diags.bearerTokenPrefix = token.substring(0, 10) + (token.length > 10 ? "..." : "");
    if (timingSafeStringEqual(token, secret)) {
      diags.bearerMatch = true;
      return { valid: true, diagnostics: diags };
    }
  }

  return { valid: false, diagnostics: diags };
}

/** Return the first value of a (possibly multi-value) HTTP header, or undefined. */
function pickHeader(headers: IncomingMessage["headers"], name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Constant-time comparison of two hex strings. Returns false (without
 * short-circuiting on length) by extending the shorter buffer to the longer
 * length so timing depends on the longer length only.
 */
function timingSafeHexEqual(expectedHex: string, providedHex: string): boolean {
  // Both must be valid hex; if not, fall back to a constant-time compare against
  // a buffer of equal length so we still pay the timing cost.
  let expectedBuf: Buffer;
  let providedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expectedHex, "hex");
    providedBuf = Buffer.from(providedHex, "hex");
  } catch {
    return false;
  }
  return timingSafeBufferEqual(expectedBuf, providedBuf);
}

/** Constant-time comparison of two UTF-8 strings via Buffer to prevent timing attacks. */
function timingSafeStringEqual(a: string, b: string): boolean {
  return timingSafeBufferEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Constant-time Buffer comparison that pads buffers to equal length to prevent length-leak side channels. */
function timingSafeBufferEqual(a: Buffer, b: Buffer): boolean {
  // Pad the shorter buffer to the longer length so timingSafeEqual doesn't
  // throw on length mismatch and compares are still constant-time relative to
  // the (attacker-controlled) longer length. Final length-check is OR'd in so
  // the comparison is NOT short-circuited.
  const len = Math.max(a.length, b.length);
  const bufA = Buffer.alloc(len);
  const bufB = Buffer.alloc(len);
  a.copy(bufA);
  b.copy(bufB);
  const equal = timingSafeEqual(bufA, bufB);
  return equal && a.length === b.length;
}

/** Read the full HTTP request body as a UTF-8 string, rejecting payloads that exceed the size limit. */
function readRawBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_WEBHOOK_BODY_BYTES) {
        request.destroy();
        reject(new Error("Payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", (err) => reject(err));
  });
}

/** Serialize `body` as JSON and write it with the given HTTP status code to the response. */
function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

/** Write a canonical 401 response, identical for all auth failure reasons to prevent information leakage. */
function writeUnauthorized(response: ServerResponse): void {
  // Single canonical 401 body — must not differ between "integration unknown",
  // "no secret configured", and "bad signature" (anti-enumeration).
  writeJson(response, 401, { error: "Unauthorized" });
}

/** Return a copy of the headers map with sensitive authorization headers replaced by `[REDACTED]`. */
function sanitizeHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[] | undefined> {
  const redacted = new Set(["authorization", "x-gitlab-token", "x-hub-signature-256"]);
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      if (redacted.has(key.toLowerCase())) {
        return [key, "[REDACTED]"];
      }
      return [key, value];
    })
  );
}

/** Collapse whitespace and truncate the raw body to 500 characters for safe debug logging. */
function makeBodyPreview(rawBody: string): string {
  const normalized = rawBody.replace(/\s+/g, " ").trim();
  if (normalized.length <= 500) return normalized;
  return `${normalized.slice(0, 500)}...`;
}

/** Produce a compact, log-friendly summary of an arbitrary webhook payload object. */
function summarizePayload(payload: unknown): Record<string, unknown> {
  if (payload === null) {
    return { kind: "null" };
  }
  if (Array.isArray(payload)) {
    return { kind: "array", length: payload.length };
  }
  if (typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const summary: Record<string, unknown> = {
      kind: "object",
      keys: Object.keys(record).slice(0, 10),
    };
    const type = record["type"];
    if (typeof type === "string") summary["type"] = type;
    const change = record["change"];
    if (typeof change === "object" && change !== null) {
      const changeRecord = change as Record<string, unknown>;
      summary["changeId"] = typeof changeRecord["id"] === "string"
        ? changeRecord["id"]
        : changeRecord["number"];
      summary["project"] = changeRecord["project"];
      summary["branch"] = changeRecord["branch"];
    }
    const issue = record["issue"];
    if (typeof issue === "object" && issue !== null) {
      const issueRecord = issue as Record<string, unknown>;
      summary["issueId"] = issueRecord["id"];
    }
    return summary;
  }
  return { kind: typeof payload, value: payload };
}

/**
 * Generate a new 32-byte hex secret suitable for `webhookSecret`. Uses
 * Node's crypto-quality randomness.
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Returns the supported event names for an integration type, used by the
 * `webhook-info` admin endpoint. Empty array means no handler is registered.
 */
export function listSupportedEvents(integrationType: string): readonly string[] {
  return getSupportedEventsForProvider(integrationType);
}
