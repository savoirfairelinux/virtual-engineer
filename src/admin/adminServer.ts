import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getLogger } from "../logger.js";
import type { OAuthAppStore, IntegrationStore, PromptStore, StateStore, Integration } from "../interfaces.js";
import { adminDashboardCss, renderAdminDashboardHtml } from "./dashboard.js";
import type { PluginManager } from "../plugins/pluginManager.js";
import type { ProviderAuthService } from "../agents/providerAuthService.js";
import { handleAgentsRoute, type AgentsRouteStore } from "./adminAgentsRoutes.js";
import { handleProjectsRoute, type ProjectsRouteStore } from "./adminProjectsRoutes.js";
import {
  handleWebhookRequest,
  isWebhookPath,
  type WebhookCapableOrchestrator,
  type ProjectLookupStore,
} from "../webhooks/webhookServer.js";
import { buildGitLabAuthHeaders } from "../utils/gitlabAuth.js";
import { writeJson, writeHtml } from "./adminRouteUtils.js";
import { handleTasksRoute } from "./adminTaskRoutes.js";
import { handlePromptsRoute } from "./adminPromptRoutes.js";
import { handleStreamRoutes } from "./adminStreamRoutes.js";
import { handleConcurrencyRoute } from "./adminConcurrencyRoutes.js";
import { handleWebhookRoutes } from "./adminWebhookRoutes.js";
import { handleIntegrationRoutes } from "./adminIntegrationRoutes.js";
import { makeTaskId } from "../interfaces.js";

/**
 * Admin HTTP server — REST API for orchestrator status, task control, prompts, integrations,
 * agents, projects, concurrency, and webhooks. Auth: HMAC-SHA256 Bearer (ADMIN_AUTH_SECRET).
 */

const log = getLogger("admin-server");

export interface AdminRuntimeConfig {
  nodeEnv: "development" | "production" | "test";
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  maxAgentCycles: number;
  maxRetryAttempts: number;
  pollingIntervalMs: number;
  adminAuthSecret?: string | undefined;
}

export interface AdminPollingStatusSource {
  isRunning(): boolean;
  getIntervals(): {
    intervalMs: number;
  };
}

export interface AdminProviderSummary {
  id: string;
  name: string;
  category: "ticketing" | "review" | "agent" | "runtime";
  enabled: boolean;
  configured: boolean;
  status: "ready" | "disabled" | "incomplete";
  details: readonly string[];
}

export interface AdminServerDependencies {
  stateStore: Pick<StateStore, "getActiveTasks" | "getAllTasks" | "getTask" | "getAgentCycles" | "getAgentCycleEvents" | "getStateTransitions" | "getChangesForTask" | "getChangesForTasks" | "pauseTask" | "resumeTask" | "retryTask" | "abandonTask" | "deleteTask" | "deleteTaskGroup">;
  /** Phase 3: store backing the /api/admin/agents routes. */
  agentStore?: AgentsRouteStore;
  providerAuthService?: ProviderAuthService | undefined;
  /** Phase 3: store backing the /api/admin/projects routes. */
  projectStore?: ProjectsRouteStore;
  integrationStore?: IntegrationStore;
  oAuthAppStore?: OAuthAppStore;
  promptStore?: PromptStore | undefined;
  config: AdminRuntimeConfig;
  polling: AdminPollingStatusSource;
  providers: readonly AdminProviderSummary[] | (() => readonly AdminProviderSummary[]);
  pluginManager?: PluginManager;
  taskControl?: {
    resumeTask(taskId: ReturnType<typeof makeTaskId>): Promise<void>;
    retryTask(taskId: ReturnType<typeof makeTaskId>): Promise<void>;
  };
  /** Called after an integration config update — invalidates cached VCS connectors. */
  onIntegrationUpdated?: (integrationId: string) => void;
  /** Called after a project is created/updated/enabled/disabled/deleted. */
  onProjectChange?: () => void;
  /**
   * Webhook receiver. When provided, mounts `POST /webhooks/:integrationId/:event`
   * (HMAC secret is the auth) and admin routes for rotating the per-integration secret.
   */
  webhooks?: {
    projectStore: ProjectLookupStore;
    orchestrator: WebhookCapableOrchestrator;
    /** Public base URL used to render copy-paste-ready webhook URLs (e.g. https://ve.example.com). */
    publicBaseUrl?: string;
  };
  /** Optional live integration stream runtime state, keyed by integration id. */
  integrationStreams?: {
    getStatus(integrationId: string): unknown | null;
  };
  /**
   * When provided, mounts `GET/PUT /api/admin/concurrency` with live in-memory counters.
   * `max_concurrent` NULL = unlimited.
   */
  concurrency?: {
    /** Persisted global limit (stateStore-backed). */
    getGlobalLimit(): Promise<number | null>;
    setGlobalLimit(value: number | null): Promise<void>;
    /** Live in-memory snapshot from {@link ConcurrencyTracker}. */
    snapshot(): { global: number; perProject: Record<string, number>; perAgent: Record<string, number> };
  };
}

/** Derive provider-specific URLs from active plugin manager integrations. */
function getProviderUrls(pluginManager: PluginManager | undefined): {
  gerritBaseUrl: string | undefined;
  gitlabBaseUrl: string | undefined;
  gitlabToken: string | undefined;
  gitlabProjectId: string | undefined;
  ticketLinkTemplates: Record<string, string> | undefined;
} {
  if (!pluginManager) return { gerritBaseUrl: undefined, gitlabBaseUrl: undefined, gitlabToken: undefined, gitlabProjectId: undefined, ticketLinkTemplates: undefined };
  const parseConfig = (integration: Integration | undefined): Record<string, unknown> | null => {
    if (!integration) return null;
    try {
      const parsed: unknown = JSON.parse(integration.configJson);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch { return null; }
  };
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

  const gerritCandidates = pluginManager.getActiveIntegrationsByType("gerrit");
  const gerritConfig = parseConfig(gerritCandidates[0]);
  const gerritBaseUrl = str(gerritConfig?.["baseUrl"]);

  const gitlabMrCandidates = pluginManager.getActiveIntegrationsByType("gitlab-merge-request");
  const gitlabIssueCandidates = pluginManager.getActiveIntegrationsByType("gitlab-issue");
  const gitlabIntegration = gitlabMrCandidates[0] ?? gitlabIssueCandidates[0];
  const gitlabConfig = parseConfig(gitlabIntegration);
  const gitlabBaseUrl = str(gitlabConfig?.["baseUrl"]);
  const gitlabToken = str(gitlabConfig?.["token"]);
  const gitlabProjectId = str(gitlabConfig?.["projectId"]);

  const redmineCandidates = pluginManager.getActiveIntegrationsByType("redmine");
  const redmineConfig = parseConfig(redmineCandidates[0]);
  const redmineBaseUrl = str(redmineConfig?.["baseUrl"]);
  const ticketLinkTemplates = redmineBaseUrl
    ? { redmine: `${redmineBaseUrl}/issues/{id}` }
    : undefined;

  return { gerritBaseUrl, gitlabBaseUrl, gitlabToken, gitlabProjectId, ticketLinkTemplates };
}

/** Create and return the admin HTTP server with all routes wired up. */
export function createAdminServer(dependencies: AdminServerDependencies): Server {
  return createServer(async (request, response) => {
    try {
      await handleRequest(request, response, dependencies);
    } catch (err: unknown) {
      log.error({ err, method: request.method, url: request.url }, "admin request failed");
      writeJson(response, 500, { error: "Internal server error" });
    }
  });
}

/** Route an incoming admin HTTP request to the appropriate handler. */
async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: AdminServerDependencies
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = requestUrl.pathname;
  const method = request.method ?? "GET";

  // ─── Static assets (public, long-lived cache, no security headers) ─────────
  if (path === "/assets/dashboard.css" && method === "GET") {
    response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600" });
    response.end(adminDashboardCss);
    return;
  }

  // ⚠️ SECURITY: Generate a per-request cryptographic nonce for CSP
  const nonce = randomBytes(16).toString("base64url");
  applySecurityHeaders(response, nonce);

  // ─── Public routes (no auth required) ─────────────────────────────────────

  if (path === "/" || path === "/admin" || path === "/admin/") {
    if (method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed" });
      return;
    }
    const requiresAuth = Boolean(dependencies.config.adminAuthSecret);
    writeHtml(response, 200, renderAdminDashboardHtml({
      requiresAuth,
      authMode: getAdminAuthMode(dependencies.config),
      nonce,
      ...getProviderUrls(dependencies.pluginManager),
    }));
    return;
  }

  // Image proxy — auth via query param ?t= so <img> tags can use it
  if (path === "/api/admin/img-proxy" && method === "GET") {
    const targetUrl = requestUrl.searchParams.get("url") ?? "";
    const queryToken = requestUrl.searchParams.get("t") ?? "";
    const proxyAuthorized = isAuthorizedToken(queryToken, dependencies.config);
    if (!proxyAuthorized) { writeJson(response, 401, { error: "Unauthorized" }); return; }
    const { gitlabBaseUrl, gitlabToken: gitlabTokenVal, gitlabProjectId } = getProviderUrls(dependencies.pluginManager);
    if (!gitlabBaseUrl || !targetUrl.startsWith(gitlabBaseUrl)) {
      writeJson(response, 400, { error: "Invalid proxy target" }); return;
    }
    try {
      const gitlabToken = gitlabTokenVal ?? "";
      const uploadMatch = targetUrl.match(/\/uploads\/([a-f0-9]+)\/([^?#]+)$/);
      const projectId = gitlabProjectId;
      const fetchUrl = (uploadMatch && projectId && gitlabBaseUrl)
        ? `${gitlabBaseUrl}/api/v4/projects/${encodeURIComponent(projectId)}/uploads/${uploadMatch[1]}/${uploadMatch[2]}`
        : targetUrl;
      log.debug({ fetchUrl, hasToken: Boolean(gitlabToken), rewritten: fetchUrl !== targetUrl }, "img-proxy fetch");
      const upstream = await fetch(fetchUrl, gitlabToken
        ? { headers: buildGitLabAuthHeaders(gitlabToken) }
        : undefined);
      const ct = upstream.headers.get("content-type") ?? "application/octet-stream";
      log.debug({ status: upstream.status, ct }, "img-proxy upstream response");
      if (!upstream.ok || ct.startsWith("text/html")) { writeJson(response, 502, { error: "Upstream error" }); return; }
      const buf = Buffer.from(await upstream.arrayBuffer());
      response.writeHead(200, { "content-type": ct, "cache-control": "private, max-age=3600" });
      response.end(buf);
    } catch { writeJson(response, 502, { error: "Proxy fetch failed" }); }
    return;
  }

  // Unauthenticated health check endpoint (for container healthchecks)
  if (path === "/health") {
    if (method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed" });
      return;
    }
    writeJson(response, 200, {
      status: "ok",
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Generic per-integration webhook receiver — HMAC secret is the auth.
  if (isWebhookPath(path)) {
    if (!dependencies.webhooks || !dependencies.integrationStore) {
      writeJson(response, 404, { error: "Webhooks not enabled" });
      return;
    }
    await handleWebhookRequest(request, response, {
      integrationStore: dependencies.integrationStore,
      projectStore: dependencies.webhooks.projectStore,
      orchestrator: dependencies.webhooks.orchestrator,
    });
    return;
  }

  // ─── Auth gate ────────────────────────────────────────────────────────────

  if (!isAuthorized(request, dependencies.config)) {
    response.setHeader("www-authenticate", 'Bearer realm="virtual-engineer-admin"');
    writeJson(response, 401, { error: "Unauthorized" });
    return;
  }

  if (!["GET", "PATCH", "POST", "PUT", "DELETE"].includes(method)) {
    writeJson(response, 405, { error: "Method not allowed" });
    return;
  }

  // ─── Status / Config / Providers (small, stays inline) ────────────────────

  if (path === "/api/admin/status") {
    if (method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed" });
      return;
    }
    const intervals = dependencies.polling.getIntervals();
    writeJson(response, 200, {
      polling: {
        running: dependencies.polling.isRunning(),
        intervalMs: intervals.intervalMs,
      },
      runtime: {
        nodeEnv: dependencies.config.nodeEnv,
        logLevel: dependencies.config.logLevel,
        maxAgentCycles: dependencies.config.maxAgentCycles,
        maxRetryAttempts: dependencies.config.maxRetryAttempts,
      },
    });
    return;
  }

  if (path === "/api/admin/config") {
    if (method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed" });
      return;
    }
    writeJson(response, 200, {
      config: {
        nodeEnv: dependencies.config.nodeEnv,
        logLevel: dependencies.config.logLevel,
        maxAgentCycles: dependencies.config.maxAgentCycles,
        maxRetryAttempts: dependencies.config.maxRetryAttempts,
        pollingIntervalMs: dependencies.config.pollingIntervalMs,
      },
    });
    return;
  }

  if (path === "/api/admin/providers") {
    if (method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed" });
      return;
    }
    const providersList = typeof dependencies.providers === 'function' ? dependencies.providers() : dependencies.providers;
    writeJson(response, 200, {
      providers: providersList.map((provider) => ({
        id: provider.id,
        name: provider.name,
        category: provider.category,
        enabled: provider.enabled,
        configured: provider.configured,
        status: provider.status,
        details: provider.details,
      })),
    });
    return;
  }

  // ─── Modular route dispatch ───────────────────────────────────────────────
  // Each handler returns true if it handled the request, false to continue.

  if (await handleStreamRoutes(request, response, path, method, {
    stateStore: dependencies.stateStore,
  })) return;

  if (await handlePromptsRoute(request, response, path, method, {
    promptStore: dependencies.promptStore,
    agentStore: dependencies.agentStore,
  })) return;

  if (await handleTasksRoute(request, response, path, method, {
    stateStore: dependencies.stateStore,
    taskControl: dependencies.taskControl,
  })) return;

  if (await handleIntegrationRoutes(request, response, path, method, {
    integrationStore: dependencies.integrationStore,
    pluginManager: dependencies.pluginManager,
    oAuthAppStore: dependencies.oAuthAppStore,
    integrationStreams: dependencies.integrationStreams,
    onIntegrationUpdated: dependencies.onIntegrationUpdated,
    adminAuthSecret: dependencies.config.adminAuthSecret,
  })) return;

  if (await handleAgentsRoute(request, response, path, method, {
    agentStore: dependencies.agentStore,
    integrationStore: dependencies.integrationStore,
    oAuthAppStore: dependencies.oAuthAppStore,
    adminAuthSecret: dependencies.config.adminAuthSecret,
    providerAuthService: dependencies.providerAuthService,
  })) return;

  if (await handleProjectsRoute(request, response, path, method, {
    projectStore: dependencies.projectStore,
    integrationStore: dependencies.integrationStore,
    onProjectChange: dependencies.onProjectChange,
  })) return;

  if (await handleConcurrencyRoute(request, response, path, method, {
    concurrency: dependencies.concurrency,
  })) return;

  if (await handleWebhookRoutes(request, response, path, method, {
    integrationStore: dependencies.integrationStore,
    onIntegrationUpdated: dependencies.onIntegrationUpdated,
    webhookPublicBaseUrl: dependencies.webhooks?.publicBaseUrl,
  })) return;

  writeJson(response, 404, { error: "Not found" });
}

// ─── Auth & Security ────────────────────────────────────────────────────────

/** Derive the admin auth mode string from the runtime config. */
function getAdminAuthMode(config: AdminRuntimeConfig): "none" | "hmac" {
  if (config.adminAuthSecret) {
    return "hmac";
  }
  return "none";
}

/** Return true if the request carries a valid HMAC-SHA256 Bearer token. */
function isAuthorized(
  request: IncomingMessage,
  config: AdminRuntimeConfig
): boolean {
  if (!config.adminAuthSecret) {
    return true;
  }

  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }

  const token = authorization.slice("Bearer ".length);

  const parts = token.split(".");
  if (parts.length === 2) {
    const timestampStr = parts[0];
    const providedSignature = parts[1];
    if (!timestampStr || !providedSignature) {
      return false;
    }
    const timestamp = parseInt(timestampStr, 10);

    if (!Number.isInteger(timestamp)) {
      return false;
    }

    // Check if timestamp is recent (within 5 minutes = 300 seconds)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > 300) {
      return false;
    }

    // ⚠️ SECURITY: timingSafeEqual prevents timing attacks.
    const expectedSignature = createHmac("sha256", config.adminAuthSecret)
      .update(timestampStr)
      .digest("hex");

    const expectedBuf = Buffer.from(expectedSignature, "hex");
    const providedBuf = Buffer.from(providedSignature, "hex");
    if (
      expectedBuf.length === providedBuf.length &&
      timingSafeEqual(expectedBuf, providedBuf)
    ) {
      return true;
    }
  }

  return false;
}

/** Return true if the raw token string is valid (used for query-parameter auth on image-proxy routes). */
function isAuthorizedToken(token: string, config: AdminRuntimeConfig): boolean {
  if (!config.adminAuthSecret) return true;
  if (!token) return false;
  const fakeRequest = { headers: { authorization: "Bearer " + token } } as unknown as IncomingMessage;
  return isAuthorized(fakeRequest, config);
}

/** Set security-oriented HTTP response headers on every admin response. */
function applySecurityHeaders(response: ServerResponse, nonce: string): void {
  // ⚠️ SECURITY: Prevent browser caching of sensitive admin responses
  response.setHeader("cache-control", "no-store");
  response.setHeader("pragma", "no-cache");
  // ⚠️ SECURITY: Prevent MIME type sniffing attacks
  response.setHeader("x-content-type-options", "nosniff");
  // ⚠️ SECURITY: Prevent clickjacking
  response.setHeader("x-frame-options", "DENY");
  // ⚠️ SECURITY: Limit Referer header exposure
  response.setHeader("referrer-policy", "no-referrer");
  // ⚠️ SECURITY: Nonce-based CSP — blocks injected scripts without the per-request nonce;
  // style-src 'self' covers the external /assets/dashboard.css (no unsafe-inline)
  response.setHeader(
    "content-security-policy",
    `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'self'; img-src 'self' data:; connect-src 'self'`
  );
}
