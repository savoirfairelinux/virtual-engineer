import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { getLogger } from "../logger.js";
import type { OAuthAppStore, IntegrationStore, PromptStore, StateStore, Integration, DomainCapability } from "../interfaces.js";
import { renderAdminDashboardHtml } from "./dashboard.js";
import { registerOverviewRoutes } from "./adminOverviewRoutes.js";
import type { PluginManager } from "../plugins/pluginManager.js";
import type { ProviderAuthService } from "../agents/providerAuthService.js";
import { type AgentsRouteStore, registerAgentRoutes } from "./adminAgentsRoutes.js";
import { type ProjectsRouteStore, registerProjectRoutes } from "./adminProjectsRoutes.js";
import {
  handleWebhookRequest,
  isWebhookPath,
  type WebhookCapableOrchestrator,
  type ProjectLookupStore,
} from "../webhooks/webhookServer.js";
import { buildGitLabAuthHeaders, rewriteGitLabUploadUrl } from "../utils/gitlabAuth.js";
import { writeJson, writeHtml } from "./adminRouteUtils.js";
import { registerTaskRoutes } from "./adminTaskRoutes.js";
import { registerPromptRoutes } from "./adminPromptRoutes.js";
import { registerStreamRoutes } from "./adminStreamRoutes.js";
import { registerConcurrencyRoutes } from "./adminConcurrencyRoutes.js";
import { registerSettingsRoutes, type SettingsController } from "./adminSettingsRoutes.js";
import { registerWebhookRoutes } from "./adminWebhookRoutes.js";
import { registerIntegrationRoutes } from "./adminIntegrationRoutes.js";
import { registerAuthRoutes, type AuthRouteAuditStore, type AuthRouteUserStore } from "./adminAuthRoutes.js";
import { registerAuditRoutes, type AuditReadStore } from "./adminAuditRoutes.js";
import { registerPolicyRoutes, type PolicyRoutesStore } from "./adminPoliciesRoutes.js";
import { createAdminAuthService, type AdminAuthService, type AdminAuthStateStore } from "./adminAuthService.js";
import { getAuthContext, setAuthContext, getEffectivePermissions, setEffectivePermissions } from "./authContext.js";
import { makeTaskId } from "../interfaces.js";
import { Router, defaultRoleForMethod, roleSatisfies, type RouteMeta, type RouteParams } from "./router.js";
import { buildEffectivePermissions, can, accessibleResourceIds, type EffectivePermissions } from "./authorization/policyEngine.js";
import { bindDefaultPolicyForRole, type DefaultPolicyBinderStore } from "./authorization/seedPolicies.js";
import type { AuthContext } from "./adminAuthService.js";
import type { PolicyRule, UserRole } from "../interfaces.js";

export { getAuthContext } from "./authContext.js";
export type { AuthContext } from "./adminAuthService.js";

// process.cwd() is the project root in both dev (tsx src/) and prod (node dist/src/index.js).
const DIST_UI_DIR = resolve(process.cwd(), "dist/admin-ui");

const MIME_MAP: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf":  "font/ttf",
  ".json": "application/json",
  ".map":  "application/json",
};

/**
 * Admin HTTP server — REST API for orchestrator status, task control, prompts, integrations,
 * agents, projects, concurrency, and webhooks.
 * Auth: DB-backed session tokens (user accounts); ADMIN_AUTH_SECRET is used only for
 * OAuth token encryption at rest.
 */

const log = getLogger("admin-server");

export interface AdminRuntimeConfig {
  nodeEnv: "development" | "production" | "test";
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  maxAgentCycles: number;
  maxRetryAttempts: number;
  pollingIntervalMs: number;
  adminAuthSecret?: string | undefined;
  /** Mirror of `ADMIN_TRUST_PROXY`. When true, IP is read from X-Forwarded-For. */
  adminTrustProxy?: boolean | undefined;
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
  /** Domain capabilities this provider fulfils (empty for runtime entries). */
  domainCapabilities: DomainCapability[];
  /**
   * Event-intake mechanisms per domain capability, e.g.
   * `{ issue_tracking: ["polling", "webhook"], code_review: ["stream"] }`.
   */
  intake: Partial<Record<DomainCapability, Array<"polling" | "webhook" | "stream">>>;
  enabled: boolean;
  configured: boolean;
  status: "ready" | "disabled" | "incomplete";
  details: readonly string[];
}

export interface AdminServerDependencies {
  stateStore: Pick<StateStore, "getActiveTasks" | "getAllTasks" | "getTask" | "getAgentCycles" | "getAgentCycleEvents" | "getStateTransitions" | "getChangesForTask" | "getChangesForTasks" | "pauseTask" | "resumeTask" | "retryTask" | "abandonTask" | "deleteTask" | "deleteTaskGroup" | "getCostSummary" | "getModelUsageSummary">;
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
    /** Live in-memory run-slot counters from {@link ConcurrencyTracker}. */
    snapshot(): { global: number; perProject: Record<string, number>; perAgent: Record<string, number> };
  };
  /**
   * When provided, mounts `GET/PUT /api/admin/settings` for editing the runtime
   * workflow settings (polling interval, max cycles, max retries). Changes are
   * persisted and hot-applied by the controller.
   */
  settings?: SettingsController | undefined;
}

/** Derive provider-specific URLs from active plugin manager integrations. */
function getProviderUrls(pluginManager: PluginManager | undefined): {
  gerritBaseUrl: string | undefined;
  gitlabBaseUrl: string | undefined;
  gitlabToken: string | undefined;
  ticketLinkTemplates: Record<string, string> | undefined;
} {
  if (!pluginManager) return { gerritBaseUrl: undefined, gitlabBaseUrl: undefined, gitlabToken: undefined, ticketLinkTemplates: undefined };
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

  const gerritCandidates = pluginManager.getActiveIntegrationsByProvider("gerrit");
  const gerritConfig = parseConfig(gerritCandidates[0]);
  const gerritBaseUrl = str(gerritConfig?.["baseUrl"]);

  const gitlabCandidates = pluginManager.getActiveIntegrationsByProvider("gitlab");
  const gitlabIntegration = gitlabCandidates[0];
  const gitlabConfig = parseConfig(gitlabIntegration);
  const gitlabBaseUrl = str(gitlabConfig?.["baseUrl"]);
  const gitlabToken = str(gitlabConfig?.["token"]);

  const redmineCandidates = pluginManager.getActiveIntegrationsByProvider("redmine");
  const redmineConfig = parseConfig(redmineCandidates[0]);
  const redmineBaseUrl = str(redmineConfig?.["baseUrl"]);
  const ticketLinkTemplates = redmineBaseUrl
    ? { redmine: `${redmineBaseUrl}/issues/{id}` }
    : undefined;

  return { gerritBaseUrl, gitlabBaseUrl, gitlabToken, ticketLinkTemplates };
}

/** Create and return the admin HTTP server with all routes wired up. */
export function createAdminServer(dependencies: AdminServerDependencies): Server {
  const authRuntime = createAuthRuntime(dependencies);
  const router = buildApiRouter(dependencies, authRuntime);
  return createServer(async (request, response) => {
    try {
      await handleRequest(request, response, dependencies, router, authRuntime);
    } catch (err: unknown) {
      log.error({ err, method: request.method, url: request.url }, "admin request failed");
      writeJson(response, 500, { error: "Internal server error" });
    }
  });
}

// ─── Session auth runtime ────────────────────────────────────────────────────

/** Combined user-store surface needed for session auth + user management. */
type AdminUserCapableStore = AdminAuthStateStore & AuthRouteUserStore;

/**
 * Feature-detect the user-store methods on the injected state store. Mocks in
 * tests (and older embedders) may omit them — session auth is then disabled
 * and the admin API runs fully open (no HMAC fallback; see `handleRequest`'s
 * auth gate).
 */
function extractUserStore(stateStore: unknown): AdminUserCapableStore | null {
  const candidate = stateStore as Partial<AdminUserCapableStore> | null | undefined;
  if (
    candidate &&
    typeof candidate.countUsers === "function" &&
    typeof candidate.getUserByUsername === "function" &&
    typeof candidate.createSession === "function"
  ) {
    return candidate as AdminUserCapableStore;
  }
  return null;
}

/** Feature-detect the audit-store append method on the injected state store. */
function extractAuditStore(stateStore: unknown): AuthRouteAuditStore | null {
  const candidate = stateStore as Partial<AuthRouteAuditStore> | null | undefined;
  return candidate && typeof candidate.appendAuditEntry === "function"
    ? (candidate as AuthRouteAuditStore)
    : null;
}

/** Feature-detect the audit-store list method on the injected state store. */
function extractAuditReadStore(stateStore: unknown): AuditReadStore | null {
  const candidate = stateStore as Partial<AuditReadStore> | null | undefined;
  return candidate && typeof candidate.listAuditEntries === "function"
    ? (candidate as AuditReadStore)
    : null;
}

/** PBAC rule-resolution surface used to build a user's effective permissions. */
interface PbacRuleStore {
  getEffectivePolicyRulesForUser(userId: string): Promise<PolicyRule[]>;
}

/** Feature-detect the PBAC rule-resolution method on the injected state store. */
function extractPbacStore(stateStore: unknown): PbacRuleStore | null {
  const candidate = stateStore as Partial<PbacRuleStore> | null | undefined;
  return candidate && typeof candidate.getEffectivePolicyRulesForUser === "function"
    ? (candidate as PbacRuleStore)
    : null;
}

/** Feature-detect the policy-binding surface used to assign role-default policies. */
function extractPolicyBinder(stateStore: unknown): DefaultPolicyBinderStore | null {
  const candidate = stateStore as Partial<DefaultPolicyBinderStore> | null | undefined;
  return candidate &&
    typeof candidate.listPolicies === "function" &&
    typeof candidate.createBinding === "function"
    ? (candidate as DefaultPolicyBinderStore)
    : null;
}

/** Feature-detect the full policy/group management surface for the admin PBAC routes. */
function extractPolicyRoutesStore(stateStore: unknown): PolicyRoutesStore | null {
  const candidate = stateStore as Partial<PolicyRoutesStore> | null | undefined;
  return candidate &&
    typeof candidate.listPolicies === "function" &&
    typeof candidate.createGroup === "function" &&
    typeof candidate.setPolicyRules === "function" &&
    typeof candidate.getUserById === "function"
    ? (candidate as PolicyRoutesStore)
    : null;
}

interface AdminAuthRuntime {
  authService: AdminAuthService | null;
  userStore: AdminUserCapableStore | null;
  /** Cached "≥1 user exists" check — false when the store lacks user methods. */
  usersExist(): Promise<boolean>;
  invalidateUsersExistCache(): void;
  /**
   * Resolve a request identity's effective permissions. Returns undefined when
   * PBAC is unavailable (store lacks rule resolution) so the gate falls back to
   * the legacy role check. Superusers (admin role / bootstrap) short-circuit.
   */
  resolvePermissions(ctx: AuthContext): Promise<EffectivePermissions | undefined>;
}

function createAuthRuntime(dependencies: AdminServerDependencies): AdminAuthRuntime {
  const userStore = extractUserStore(dependencies.stateStore);
  const authService = userStore ? createAdminAuthService({ stateStore: userStore }) : null;
  const pbacStore = extractPbacStore(dependencies.stateStore);
  let usersExistCache: boolean | null = null;
  return {
    authService,
    userStore,
    async usersExist(): Promise<boolean> {
      if (!userStore) return false;
      if (usersExistCache === null) {
        usersExistCache = (await userStore.countUsers()) > 0;
      }
      return usersExistCache;
    },
    invalidateUsersExistCache(): void {
      usersExistCache = null;
    },
    async resolvePermissions(ctx: AuthContext): Promise<EffectivePermissions | undefined> {
      if (!pbacStore) return undefined;
      if (ctx.role === "admin" || ctx.userId === null) {
        return buildEffectivePermissions("admin", []);
      }
      const rules = await pbacStore.getEffectivePolicyRulesForUser(ctx.userId);
      return buildEffectivePermissions(ctx.role, rules);
    },
  };
}

/** Build the declarative API router for all /api/admin/* routes. */
function buildApiRouter(dependencies: AdminServerDependencies, authRuntime: AdminAuthRuntime): Router {
  const router = new Router();
  const policyBinder = extractPolicyBinder(dependencies.stateStore);

  // Status / Config / Providers
  router.add("GET", "/api/admin/status", async (_req, res, _params) => {
    const intervals = dependencies.polling.getIntervals();
    writeJson(res, 200, {
      polling: { running: dependencies.polling.isRunning(), intervalMs: intervals.intervalMs },
      runtime: {
        nodeEnv: dependencies.config.nodeEnv,
        logLevel: dependencies.config.logLevel,
        maxAgentCycles: dependencies.config.maxAgentCycles,
        maxRetryAttempts: dependencies.config.maxRetryAttempts,
      },
    });
  }, { role: "viewer" });

  router.add("GET", "/api/admin/config", async (_req, res, _params) => {
    writeJson(res, 200, {
      config: {
        nodeEnv: dependencies.config.nodeEnv,
        logLevel: dependencies.config.logLevel,
        maxAgentCycles: dependencies.config.maxAgentCycles,
        maxRetryAttempts: dependencies.config.maxRetryAttempts,
        pollingIntervalMs: dependencies.config.pollingIntervalMs,
      },
    });
  }, { role: "viewer" });

  router.add("GET", "/api/admin/providers", async (_req, res, _params) => {
    const providersList = typeof dependencies.providers === "function" ? dependencies.providers() : dependencies.providers;
    writeJson(res, 200, {
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
  });

  registerStreamRoutes(router, { stateStore: dependencies.stateStore });
  const auditStore = extractAuditStore(dependencies.stateStore) ?? undefined;
  registerAuthRoutes(router, {
    userStore: authRuntime.userStore ?? undefined,
    auditStore,
    authService: authRuntime.authService ?? undefined,
    onUsersChanged: () => authRuntime.invalidateUsersExistCache(),
    ...(policyBinder
      ? { onUserCreated: (userId: string, role: UserRole): Promise<void> => bindDefaultPolicyForRole(policyBinder, userId, role) }
      : {}),
    trustProxy: dependencies.config.adminTrustProxy,
  });
  registerAuditRoutes(router, { auditStore: extractAuditReadStore(dependencies.stateStore) ?? undefined });
  registerPolicyRoutes(router, { policyStore: extractPolicyRoutesStore(dependencies.stateStore) ?? undefined, auditStore });
  registerPromptRoutes(router, { promptStore: dependencies.promptStore, agentStore: dependencies.agentStore, auditStore });
  registerTaskRoutes(router, { stateStore: dependencies.stateStore, taskControl: dependencies.taskControl, auditStore });
  registerIntegrationRoutes(router, {
    integrationStore: dependencies.integrationStore,
    pluginManager: dependencies.pluginManager,
    oAuthAppStore: dependencies.oAuthAppStore,
    auditStore,
    integrationStreams: dependencies.integrationStreams,
    onIntegrationUpdated: dependencies.onIntegrationUpdated,
    adminAuthSecret: dependencies.config.adminAuthSecret,
  });
  registerAgentRoutes(router, {
    agentStore: dependencies.agentStore,
    integrationStore: dependencies.integrationStore,
    oAuthAppStore: dependencies.oAuthAppStore,
    auditStore,
    adminAuthSecret: dependencies.config.adminAuthSecret,
    providerAuthService: dependencies.providerAuthService,
  });
  registerProjectRoutes(router, {
    projectStore: dependencies.projectStore,
    integrationStore: dependencies.integrationStore,
    auditStore,
    onProjectChange: dependencies.onProjectChange,
    taskControl: dependencies.taskControl,
  });
  registerConcurrencyRoutes(router, { concurrency: dependencies.concurrency });
  registerSettingsRoutes(router, { settings: dependencies.settings });
  registerWebhookRoutes(router, {
    integrationStore: dependencies.integrationStore,
    auditStore,
    onIntegrationUpdated: dependencies.onIntegrationUpdated,
    webhookPublicBaseUrl: dependencies.webhooks?.publicBaseUrl,
  });
  registerOverviewRoutes(router, {
    stateStore: dependencies.stateStore,
    config: dependencies.config,
    databasePath: process.env["DATABASE_PATH"] ?? "./data/virtual-engineer.db",
    pollingIntervalMs: dependencies.config.pollingIntervalMs,
  });

  return router;
}

/** Route an incoming admin HTTP request to the appropriate handler. */
async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: AdminServerDependencies,
  router: Router,
  authRuntime: AdminAuthRuntime
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = requestUrl.pathname;
  const method = request.method ?? "GET";

  // ─── React admin UI static files (hashed → long-lived cache) ───────────────
  if (method === "GET" && path.startsWith("/admin-ui/")) {
    // ⚠️ SECURITY: Prevent path traversal — resolve and ensure it stays inside DIST_UI_DIR
    const relative = path.slice("/admin-ui/".length);
    const absolute = join(DIST_UI_DIR, relative);
    const realDist = resolve(DIST_UI_DIR);
    if (!absolute.startsWith(realDist + "/") && absolute !== realDist) {
      writeJson(response, 403, { error: "Forbidden" });
      return;
    }
    if (!existsSync(absolute)) {
      writeJson(response, 404, { error: "Not found" });
      return;
    }
    try {
      const buf = readFileSync(absolute);
      const ext = extname(absolute).toLowerCase();
      const contentType = MIME_MAP[ext] ?? "application/octet-stream";
      // Hashed assets get long cache; others short.
      const isHashed = /\.[a-f0-9]{8,}\./.test(relative);
      response.writeHead(200, {
        "content-type": contentType,
        "cache-control": isHashed ? "public, max-age=31536000, immutable" : "public, max-age=60",
        "x-content-type-options": "nosniff",
      });
      response.end(buf);
    } catch {
      writeJson(response, 500, { error: "Failed to read file" });
    }
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
    // Auth is required when the user store is available (session-based).
    // Without a user store (legacy embedders), the admin API is fully open.
    const requiresAuth = authRuntime.authService !== null;
    writeHtml(response, 200, renderAdminDashboardHtml({
      requiresAuth,
      nonce,
      ...getProviderUrls(dependencies.pluginManager),
    }));
    return;
  }

  // Image proxy — auth via query param ?t= so <img> tags can use it
  if (path === "/api/admin/img-proxy" && method === "GET") {
    const targetUrl = requestUrl.searchParams.get("url") ?? "";
    const queryToken = requestUrl.searchParams.get("t") ?? "";
    const proxyAuthorized = authRuntime.authService && (await authRuntime.usersExist())
      ? (await authRuntime.authService.validateSession(queryToken)) !== null
      : true; // bootstrap mode (no users yet): open
    if (!proxyAuthorized) { writeJson(response, 401, { error: "Unauthorized" }); return; }
    const { gitlabBaseUrl, gitlabToken: gitlabTokenVal } = getProviderUrls(dependencies.pluginManager);
    if (!gitlabBaseUrl || !targetUrl.startsWith(gitlabBaseUrl)) {
      writeJson(response, 400, { error: "Invalid proxy target" }); return;
    }
    try {
      const gitlabToken = gitlabTokenVal ?? "";
      const fetchUrl = rewriteGitLabUploadUrl(targetUrl, gitlabBaseUrl);
      log.debug({ fetchUrl, hasToken: Boolean(gitlabToken) }, "img-proxy fetch");
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

  // Public auth endpoints — no credentials required.
  const isPublicAuthRoute =
    (method === "GET" && path === "/api/admin/auth/setup-status") ||
    (method === "POST" && path === "/api/admin/auth/login");

  if (!isPublicAuthRoute) {
    if (method === "POST" && path === "/api/admin/auth/setup") {
      // Bootstrap: setup is unauthenticated; the route handler enforces zero users exist.
      setAuthContext(request, { userId: null, username: "bootstrap", role: "admin" });
    } else if (authRuntime.authService && (await authRuntime.usersExist())) {
      // ≥1 user exists → only DB-backed session tokens are accepted.
      const token = extractBearerToken(request);
      const context = token ? await authRuntime.authService.validateSession(token) : null;
      if (!context) {
        sendUnauthorized(response);
        return;
      }
      setAuthContext(request, context);
    } else {
      // Bootstrap mode (no users yet, or no user store) — all admin routes open.
      if (!authRuntime.userStore) {
        log.warn("Admin user store is unavailable; admin API is running without authentication");
      }
      setAuthContext(request, { userId: null, username: "bootstrap", role: "admin" });
    }
  }

  if (!["GET", "PATCH", "POST", "PUT", "DELETE"].includes(method)) {
    writeJson(response, 405, { error: "Method not allowed" });
    return;
  }

  // Resolve the request's PBAC permissions once and cache them for the gate and
  // for scope-aware list handlers. Undefined when PBAC is unavailable.
  const authedContext = getAuthContext(request);
  if (authedContext) {
    const perms = await authRuntime.resolvePermissions(authedContext);
    if (perms) setEffectivePermissions(request, perms);
  }

  // ─── Authorization gate (PBAC permission, or legacy role fallback) ──────────

  const matched = router.match(method, path);
  if (matched) {
    const context = getAuthContext(request);
    if (context) {
      const meta = matched.meta;
      const perms = getEffectivePermissions(request);
      if (meta.permission && perms) {
        if (meta.collection) {
          // Collection routes authorize on any grant (scoped or global); the
          // handler filters the response to accessible ids.
          if (accessibleResourceIds(perms, meta.permission) === null) {
            writeJson(response, 403, { error: "forbidden", permission: meta.permission });
            return;
          }
        } else {
          const resourceId = await resolveScopeResourceId(meta, matched.params, dependencies.stateStore);
          if (!can(perms, meta.permission, resourceId)) {
            writeJson(response, 403, { error: "forbidden", permission: meta.permission });
            return;
          }
        }
      } else {
        const requiredRole = meta.role ?? defaultRoleForMethod(method);
        if (!roleSatisfies(context.role, requiredRole)) {
          writeJson(response, 403, { error: "forbidden", requiredRole });
          return;
        }
      }
    }
  }

  // ─── Modular route dispatch ───────────────────────────────────────────────

  if (await router.dispatch(request, response, path, method)) return;

  writeJson(response, 404, { error: "Not found" });
}

// ─── Auth & Security ────────────────────────────────────────────────────────

/** Send a 401 with the WWW-Authenticate challenge header. */
function sendUnauthorized(response: ServerResponse): void {
  response.setHeader("www-authenticate", 'Bearer realm="virtual-engineer-admin"');
  writeJson(response, 401, { error: "Unauthorized" });
}

/** Extract the raw Bearer token from the Authorization header, if any. */
function extractBearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Resolve the resource id a scoped permission check applies to.
 *
 * - Returns `undefined` for a global permission (no `resourceParam`) — the gate
 *   then requires an unscoped (all-resources) grant.
 * - For `task.*` permissions, resolves the owning **project** id (tasks inherit
 *   their project's scope); returns null for orphaned/unknown tasks.
 * - Otherwise returns the raw path-parameter value (project/integration/agent/prompt id).
 */
async function resolveScopeResourceId(
  meta: RouteMeta,
  params: RouteParams,
  stateStore: AdminServerDependencies["stateStore"]
): Promise<string | null | undefined> {
  if (!meta.resourceParam) return undefined;
  const raw = params[meta.resourceParam];
  if (!raw) return null;
  if (meta.permission?.startsWith("task.")) {
    try {
      const task = await stateStore.getTask(makeTaskId(raw));
      return task?.projectId ?? null;
    } catch {
      return null;
    }
  }
  return raw;
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
  // style-src 'self' covers Vite CSS assets served from /admin-ui/assets/ (no unsafe-inline)
  response.setHeader(
    "content-security-policy",
    `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'`
  );
}
