import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getLogger } from "../logger.js";
import { makeTaskId } from "../interfaces.js";
import type { AgentCycle, OAuthApp, OAuthAppStore, IntegrationStore, Prompt, PromptStore, StateStore, StateTransition, Task, Integration } from "../interfaces.js";
import { CODE_SOURCE_INTEGRATION_TYPES, TICKET_SOURCE_INTEGRATION_TYPES } from "../interfaces.js";
import { renderAdminDashboardHtml } from "./dashboard.js";
import type { PluginManager } from "../plugins/pluginManager.js";
import { getAllPluginDescriptors, getPluginCapabilities, getPluginDescriptor } from "../plugins/registry.js";
import { agentLogBus, getTaskEventBuffer } from "../agents/agentEventBus.js";
import { normalizeAgentEvent } from "../agents/agentEventTypes.js";
import type { ProviderAuthService } from "../agents/providerAuthService.js";
import type { AgentLogEvent } from "../interfaces.js";
import { decryptToken } from "../utils/encryption.js";
import { buildGitLabAuthHeaders, normalizeGitLabBaseUrl } from "../utils/gitlabAuth.js";
import { exchangeForSessionToken, fetchAvailableModels } from "../agents/copilotModelsService.js";
import { handleAgentsRoute, type AgentsRouteStore } from "./adminAgentsRoutes.js";
import { handleProjectsRoute, type ProjectsRouteStore } from "./adminProjectsRoutes.js";
import {
  handleWebhookRequest,
  isWebhookPath,
  generateWebhookSecret,
  listSupportedEvents,
  type WebhookCapableOrchestrator,
  type ProjectLookupStore,
} from "../webhooks/webhookServer.js";

/**
 * Admin HTTP server — REST API for orchestrator status, task control, prompts, integrations,
 * agents, projects, concurrency, and webhooks. Auth: HMAC-SHA256 Bearer (ADMIN_AUTH_SECRET).
 */

const log = getLogger("admin-server");
const SECRET_MASK = "********";

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
  stateStore: Pick<StateStore, "getActiveTasks" | "getAllTasks" | "getTask" | "getAgentCycles" | "getAgentCycleEvents" | "getStateTransitions" | "pauseTask" | "resumeTask" | "retryTask" | "abandonTask" | "deleteTask" | "deleteTaskGroup">;
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
  applySecurityHeaders(response);

  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = requestUrl.pathname;
  const method = request.method ?? "GET";

  // Public routes (no auth required for these, they're public-friendly)
  if (path === "/" || path === "/admin" || path === "/admin/") {
    if (method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed" });
      return;
    }
    const requiresAuth = Boolean(dependencies.config.adminAuthSecret);
    writeHtml(response, 200, renderAdminDashboardHtml({
      requiresAuth,
      authMode: getAdminAuthMode(dependencies.config),
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
      // GitLab /uploads/ is served by nginx without API auth — rewrite to the authenticated API endpoint
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

  // Public Gerrit webhook endpoint removed: code-review discovery is
  // now webhook-driven (see src/webhooks/ and ReviewOrchestrator).

  // Phase 5 — generic per-integration webhook receiver. Mounted BEFORE the
  // auth gate because the per-integration HMAC secret is the auth. Returns
  // 401 (not 404) for unknown integrations to avoid leaking which IDs exist.
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

  // Auth-protected routes
  if (!isAuthorized(request, dependencies.config)) {
    response.setHeader("www-authenticate", 'Bearer realm="virtual-engineer-admin"');
    writeJson(response, 401, { error: "Unauthorized" });
    return;
  }

  // All API endpoints require GET, PATCH, or POST only
  if (!["GET", "PATCH", "POST", "PUT", "DELETE"].includes(method)) {
    writeJson(response, 405, { error: "Method not allowed" });
    return;
  }

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

  // SSE endpoint for live logs
  if (path === "/api/admin/logs/stream") {
    if (method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed" });
      return;
    }
    const taskIdParam = requestUrl.searchParams.get("taskId");
    let streamEntries: Array<Record<string, unknown>> = [];

    if (taskIdParam) {
      const taskId = makeTaskId(taskIdParam);
      const task = await dependencies.stateStore.getTask(taskId);
      if (!task) {
        writeJson(response, 404, { error: "Task not found" });
        return;
      }

      const cycles = await dependencies.stateStore.getAgentCycles(taskId);
      streamEntries = cycles.flatMap((cycle) => serializeAgentLogEntries(cycle));
    } else {
      streamEntries = [
        { timestamp: new Date().toISOString(), taskId: null, level: "info", message: "Admin API stream started", source: "admin" },
        { timestamp: new Date().toISOString(), taskId: null, level: "info", message: "Listening for live logs...", source: "admin" },
      ];
    }

    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream");
    response.setHeader("cache-control", "no-cache");
    response.setHeader("connection", "keep-alive");
    response.flushHeaders();

    for (const entry of streamEntries) {
      response.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    // Replay buffered live events for the current in-flight cycle so that
    // clients connecting mid-cycle see what they missed.
    if (taskIdParam) {
      const buffered = getTaskEventBuffer(taskIdParam);
      for (const event of buffered) {
        if (response.writable) {
          response.write(`data: ${JSON.stringify(serializeAgentEventEntry(event))}\n\n`);
        }
      }
    }

    // Subscribe to live events filtered by taskId
    const emittedTimestamps = new Set<string>();
    const eventListener = (event: AgentLogEvent): void => {
      if (taskIdParam && event.taskId !== taskIdParam) return;
      if (!response.writable) return;
      // Deduplicate against replayed buffer events using timestamp+type key
      const key = `${event.timestamp}:${event.type}:${String(event.cycleNumber)}`;
      if (emittedTimestamps.has(key)) return;
      emittedTimestamps.add(key);
      response.write(`data: ${JSON.stringify(serializeAgentEventEntry(event))}\n\n`);
    };
    // Seed dedup set from the buffer we already sent
    if (taskIdParam) {
      for (const event of getTaskEventBuffer(taskIdParam)) {
        emittedTimestamps.add(`${event.timestamp}:${event.type}:${String(event.cycleNumber)}`);
      }
    }
    agentLogBus.on("event", eventListener);

    // Heartbeat every 15s to keep connection alive
    const heartbeatLogs = setInterval(() => {
      if (!response.writable) { clearInterval(heartbeatLogs); return; }
      response.write(": heartbeat\n\n");
    }, 15_000);

    // Clean up on client disconnect
    response.on("close", () => {
      agentLogBus.off("event", eventListener);
      clearInterval(heartbeatLogs);
    });

    // Do NOT call response.end() — keep connection open
    return;
  }

  // SSE endpoint for global events (tasks, providers)
  if (path === "/api/admin/events/stream") {
    if (method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed" });
      return;
    }

    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream");
    response.setHeader("cache-control", "no-cache");
    response.setHeader("connection", "keep-alive");
    response.flushHeaders();

    const sendTasks = async (): Promise<void> => {
      if (!response.writable) return;
      try {
        const allTasks = await dependencies.stateStore.getAllTasks();
        const sorted = deduplicateByTicket(allTasks)
          .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
        response.write(`event: tasks\ndata: ${JSON.stringify(sorted)}\n\n`);
      } catch { /* ignore */ }
    };

    // Send initial tasks immediately
    await sendTasks();

    // Poll tasks every 5s
    const taskTimer = setInterval(() => void sendTasks(), 5_000);

    // Heartbeat every 15s
    const heartbeatGlobal = setInterval(() => {
      if (!response.writable) { clearInterval(heartbeatGlobal); return; }
      response.write(": heartbeat\n\n");
    }, 15_000);

    // Clean up on disconnect
    response.on("close", () => {
      clearInterval(taskTimer);
      clearInterval(heartbeatGlobal);
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

  if (path === "/api/admin/prompts") {
    if (!dependencies.promptStore) {
      writeJson(response, 501, { error: "Prompt store not available" });
      return;
    }

    if (method === "GET") {
      const prompts = await dependencies.promptStore.getPrompts();
      writeJson(response, 200, {
        prompts: prompts.map(serializePrompt),
      });
      return;
    }

    if (method === "POST") {
      const body = await readBody(request);
      const label = body?.["label"];
      const content = body?.["content"];

      if (typeof label !== "string" || label.trim().length === 0) {
        writeJson(response, 400, { error: "Prompt label must be provided as a non-empty string" });
        return;
      }

      if (typeof content !== "string" || content.trim().length === 0) {
        writeJson(response, 400, { error: "Prompt content must be provided as a non-empty string" });
        return;
      }

      try {
        const prompt = await dependencies.promptStore.createPrompt(label, content);
        log.info({ promptId: prompt.id, label }, "new prompt created via admin API");
        writeJson(response, 201, { prompt: serializePrompt(prompt) });
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        if (msg.includes("already exists")) {
          writeJson(response, 409, { error: msg });
          return;
        }
        if (msg.includes("Invalid prompt id")) {
          writeJson(response, 400, { error: msg });
          return;
        }
        throw err;
      }
    }

    writeJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const promptUsageMatch = /^\/api\/admin\/prompts\/([^/]+)\/usage$/.exec(path);
  if (promptUsageMatch) {
    if (!dependencies.promptStore) {
      writeJson(response, 501, { error: "Prompt store not available" });
      return;
    }
    if (method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed" });
      return;
    }

    const promptId = decodeURIComponent(promptUsageMatch[1] ?? "");
    const prompt = await dependencies.promptStore.getPrompt(promptId);
    if (!prompt) {
      writeJson(response, 404, { error: "Prompt not found" });
      return;
    }

    const agents = dependencies.agentStore ? await dependencies.agentStore.listAgents() : [];
    const usedBy = agents
      .filter((a) => a.systemPromptId === promptId || a.instructionsPromptId === promptId)
      .map((a) => ({ id: a.id, name: a.name }));
    writeJson(response, 200, { promptId, agents: usedBy });
    return;
  }

  const promptMatch = /^\/api\/admin\/prompts\/([^/]+)$/.exec(path);
  if (promptMatch) {
    if (!dependencies.promptStore) {
      writeJson(response, 501, { error: "Prompt store not available" });
      return;
    }

    const promptId = decodeURIComponent(promptMatch[1] ?? "");

    if (method === "GET") {
      const prompt = await dependencies.promptStore.getPrompt(promptId);
      if (!prompt) {
        writeJson(response, 404, { error: "Prompt not found" });
        return;
      }

      writeJson(response, 200, { prompt: serializePrompt(prompt) });
      return;
    }

    if (method === "PUT") {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(promptId)) {
        writeJson(response, 404, { error: "Prompt not found" });
        return;
      }

      const existing = await dependencies.promptStore.getPrompt(promptId);
      if (!existing) {
        writeJson(response, 404, { error: "Prompt not found" });
        return;
      }

      const body = await readBody(request);
      if (!body || typeof body["content"] !== "string") {
        writeJson(response, 400, { error: "Prompt content must be provided as a string" });
        return;
      }

      const newContent = body["content"] as string;
      const prompt = await dependencies.promptStore.upsertPrompt(promptId, newContent);
      log.warn(
        { promptId, prevLength: existing.content.length, newLength: newContent.length },
        "prompt updated via admin API"
      );
      writeJson(response, 200, { prompt: serializePrompt(prompt) });
      return;
    }

    if (method === "DELETE") {
      try {
        await dependencies.promptStore.deletePrompt(promptId);
        log.info({ promptId }, "prompt deleted via admin API");
        writeJson(response, 204, {});
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        if (msg.includes("system prompt") || msg.includes("built-in")) {
          writeJson(response, 409, { error: msg });
          return;
        }
        if (msg.includes("not found")) {
          writeJson(response, 404, { error: msg });
          return;
        }
        throw err;
      }
    }

    writeJson(response, 405, { error: "Method not allowed" });
    return;
  }

  if (path === "/api/admin/tasks") {
    if (method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed" });
      return;
    }
    const tasks = await dependencies.stateStore.getAllTasks();
    writeJson(response, 200, {
      tasks: deduplicateByTicket(tasks)
        .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
        .map(serializeTask),
    });
    return;
  }

  const taskMatch = /^\/api\/admin\/tasks\/([^/]+)$/.exec(path);
  if (taskMatch) {
    if (method === "DELETE") {
      const taskId = makeTaskId(decodeURIComponent(taskMatch[1] ?? ""));
      try {
        const taskToDelete = await dependencies.stateStore.getTask(taskId);
        if (!taskToDelete) {
          writeJson(response, 404, { error: "Task not found" });
          return;
        }
        // deleteTaskGroup removes all sibling tasks sharing the same ticketId
        // (and, for code-review tasks, the same gerritChangeId). This is
        // modular — no caller awareness of task type required.
        await dependencies.stateStore.deleteTaskGroup(taskId);
        writeJson(response, 200, { ok: true });
      } catch (err: unknown) {
        log.warn({ err }, "delete task failed");
        const msg = err instanceof Error ? err.message : "Operation failed";
        const status = msg.includes("non-terminal") ? 409 : 400;
        writeJson(response, status, { error: msg });
      }
      return;
    }
    if (method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed" });
      return;
    }
    const taskId = makeTaskId(decodeURIComponent(taskMatch[1] ?? ""));
    const task = await dependencies.stateStore.getTask(taskId);
    if (!task) {
      writeJson(response, 404, { error: "Task not found" });
      return;
    }

    writeJson(response, 200, { task: serializeTask(task) });
    return;
  }

  const cyclesMatch = /^\/api\/admin\/tasks\/([^/]+)\/cycles$/.exec(path);
  if (cyclesMatch) {
    if (method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed" });
      return;
    }
    const taskId = makeTaskId(decodeURIComponent(cyclesMatch[1] ?? ""));
    const task = await dependencies.stateStore.getTask(taskId);
    if (!task) {
      writeJson(response, 404, { error: "Task not found" });
      return;
    }

    const cycles = await dependencies.stateStore.getAgentCycles(taskId);
    writeJson(response, 200, { cycles: cycles.map(serializeCycle) });
    return;
  }

  const transitionsMatch = /^\/api\/admin\/tasks\/([^/]+)\/transitions$/.exec(path);
  if (transitionsMatch) {
    if (method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed" });
      return;
    }
    const taskId = makeTaskId(decodeURIComponent(transitionsMatch[1] ?? ""));
    const task = await dependencies.stateStore.getTask(taskId);
    if (!task) {
      writeJson(response, 404, { error: "Task not found" });
      return;
    }

    const transitions = await dependencies.stateStore.getStateTransitions(taskId);
    writeJson(response, 200, { transitions: transitions.map(serializeTransition) });
    return;
  }

  // Task action endpoints
  const pauseMatch = /^\/api\/admin\/tasks\/([^/]+)\/pause$/.exec(path);
  if (pauseMatch && method === "PATCH") {
    const taskId = makeTaskId(decodeURIComponent(pauseMatch[1] ?? ""));
    try {
      const task = await dependencies.stateStore.pauseTask(taskId);
      writeJson(response, 200, { task: serializeTask(task) });
    } catch (err: unknown) {
      log.warn({ err }, "pause task failed");
      writeJson(response, 400, { error: "Operation failed" });
    }
    return;
  }

  const resumeMatch = /^\/api\/admin\/tasks\/([^/]+)\/resume$/.exec(path);
  if (resumeMatch && method === "PATCH") {
    const taskId = makeTaskId(decodeURIComponent(resumeMatch[1] ?? ""));
    try {
      const task = await dependencies.stateStore.resumeTask(taskId);
      void dependencies.taskControl?.resumeTask(taskId).catch((err: unknown) => {
        log.error({ err, taskId }, "resume task workflow trigger failed");
      });
      writeJson(response, 200, { task: serializeTask(task) });
    } catch (err: unknown) {
      log.warn({ err }, "resume task failed");
      writeJson(response, 400, { error: "Operation failed" });
    }
    return;
  }

  const retryMatch = /^\/api\/admin\/tasks\/([^/]+)\/retry$/.exec(path);
  if (retryMatch && method === "POST") {
    const taskId = makeTaskId(decodeURIComponent(retryMatch[1] ?? ""));
    try {
      const task = await dependencies.stateStore.retryTask(taskId);
      void dependencies.taskControl?.retryTask(taskId).catch((err: unknown) => {
        log.error({ err, taskId }, "retry task workflow trigger failed");
      });
      writeJson(response, 200, { task: serializeTask(task) });
    } catch (err: unknown) {
      log.warn({ err }, "retry task failed");
      writeJson(response, 400, { error: "Operation failed" });
    }
    return;
  }

  const abandonMatch = /^\/api\/admin\/tasks\/([^/]+)\/abandon$/.exec(path);
  if (abandonMatch && method === "POST") {
    const taskId = makeTaskId(decodeURIComponent(abandonMatch[1] ?? ""));
    try {
      const task = await dependencies.stateStore.abandonTask(taskId);
      writeJson(response, 200, { task: serializeTask(task) });
    } catch (err: unknown) {
      log.warn({ err }, "abandon task failed");
      writeJson(response, 400, { error: "Operation failed" });
    }
    return;
  }

  // ─── Plugin & Integration routes ──────────────────────────────────────────

  if (path === "/api/admin/plugins" && method === "GET") {
    const descriptors = getAllPluginDescriptors();
    writeJson(response, 200, {
      plugins: descriptors.map((d) => ({
        type: d.type,
        name: d.name,
        category: d.category,
        capabilities: getPluginCapabilities(d),
        requiredFields: d.requiredFields,
        ...(d.oauth !== undefined ? { oauth: d.oauth } : {}),
      })),
    });
    return;
  }

  const oAuthAppStore = dependencies.oAuthAppStore;

  if (path === "/api/admin/oauth-apps" && method === "GET") {
    if (!oAuthAppStore) {
      writeJson(response, 501, { error: "OAuth app registry is not available" });
      return;
    }
    const providerParam = requestUrl.searchParams.get("provider") ?? undefined;
    const apps = await oAuthAppStore.listOAuthApps(providerParam);
    writeJson(response, 200, {
      apps: apps.map((app) => serializeOAuthApp(app)),
    });
    return;
  }

  if (path === "/api/admin/oauth-apps" && method === "POST") {
    if (!oAuthAppStore) {
      writeJson(response, 501, { error: "OAuth app registry is not available" });
      return;
    }
    const body = await readBody(request);
    const provider = typeof body?.["provider"] === "string" ? body["provider"] : "gitlab";
    const baseUrl = typeof body?.["baseUrl"] === "string" ? body["baseUrl"] : "";
    const clientId = typeof body?.["clientId"] === "string" ? body["clientId"] : "";
    if (!baseUrl || !clientId) {
      writeJson(response, 400, { error: "Missing required fields: baseUrl, clientId" });
      return;
    }
    const app = await oAuthAppStore.upsertOAuthApp({
      provider,
      baseUrl: normalizeGitLabBaseUrl(baseUrl),
      clientId,
    });
    writeJson(response, 201, { app: serializeOAuthApp(app) });
    return;
  }

  if (path === "/api/admin/oauth-apps" && method === "DELETE") {
    if (!oAuthAppStore) {
      writeJson(response, 501, { error: "OAuth app registry is not available" });
      return;
    }
    const body = await readBody(request);
    const provider = typeof body?.["provider"] === "string" ? body["provider"] : "gitlab";
    const baseUrl = typeof body?.["baseUrl"] === "string" ? body["baseUrl"] : "";
    if (!baseUrl) {
      writeJson(response, 400, { error: "baseUrl is required" });
      return;
    }
    await oAuthAppStore.deleteOAuthApp(provider, normalizeGitLabBaseUrl(baseUrl));
    writeJson(response, 200, { ok: true });
    return;
  }

  if (path === "/api/admin/oauth-apps/resolve" && method === "POST") {
    if (!oAuthAppStore) {
      writeJson(response, 501, { error: "OAuth app registry is not available" });
      return;
    }
    const body = await readBody(request);
    const provider = typeof body?.["provider"] === "string" ? body["provider"] : "gitlab";
    const baseUrl = typeof body?.["baseUrl"] === "string" ? body["baseUrl"] : "";
    if (!baseUrl) {
      writeJson(response, 400, { error: "baseUrl is required" });
      return;
    }
    const normalizedBaseUrl = normalizeGitLabBaseUrl(baseUrl);
    const app = await oAuthAppStore.getOAuthApp(provider, normalizedBaseUrl);
    if (!app) {
      writeJson(response, 404, { error: `No OAuth app is configured for ${provider}:${normalizedBaseUrl}. Ask an administrator to add one in Configuration / OAuth Apps.` });
      return;
    }
    writeJson(response, 200, { app: serializeOAuthApp(app) });
    return;
  }

  if (path === "/api/admin/integrations" && method === "GET") {
    if (!dependencies.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return;
    }
    const list = await dependencies.integrationStore.getIntegrations();
    const pm = dependencies.pluginManager;
    writeJson(response, 200, {
      integrations: list.map((i) => serializeIntegration(i, pm, dependencies.integrationStreams)),
    });
    return;
  }

  if (path === "/api/admin/integrations/by-category" && method === "GET") {
    if (!dependencies.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return;
    }
    const codeSourceTypes = new Set<string>(CODE_SOURCE_INTEGRATION_TYPES);
    const ticketSourceTypes = new Set<string>(TICKET_SOURCE_INTEGRATION_TYPES);
    const list = await dependencies.integrationStore.getIntegrations();
    const codeSources = list.filter((i) => codeSourceTypes.has(i.type));
    const ticketSources = list.filter((i) => ticketSourceTypes.has(i.type));
    writeJson(response, 200, {
      codeSources: codeSources.map((i) => serializeIntegration(i, dependencies.pluginManager, dependencies.integrationStreams)),
      ticketSources: ticketSources.map((i) => serializeIntegration(i, dependencies.pluginManager, dependencies.integrationStreams)),
    });
    return;
  }

  if (path === "/api/admin/integrations" && method === "POST") {
    if (!dependencies.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return;
    }
    const body = await readBody(request);
    if (!body || !body["type"] || !body["name"]) {
      writeJson(response, 400, { error: "Missing required fields: type, name" });
      return;
    }
    const type = body["type"] as Integration["type"];
    const descriptor = getPluginDescriptor(type);
    if (!descriptor) {
      writeJson(response, 400, { error: `Unknown integration type: ${body["type"] as string}` });
      return;
    }
    const validatedConfig = validateIntegrationConfig(
      descriptor.configSchema,
      asRecord(body["config"]),
      type !== "copilot"
    );
    if (!validatedConfig) {
      writeJson(response, 400, { error: type === "copilot" ? `Invalid config for ${type}` : "Invalid integration config" });
      return;
    }
    const id = body["id"] as string || randomId();
    try {
      const integration = await dependencies.integrationStore.upsertIntegration({
        id,
        type,
        name: body["name"] as string,
        configJson: JSON.stringify(validatedConfig),
        enabled: true,
      });
      if (dependencies.pluginManager) {
        try {
          await dependencies.pluginManager.reloadIntegration(id);
        } catch (activationErr: unknown) {
          log.warn({ id, type, err: activationErr }, "integration created but could not be activated at runtime (incomplete config?)");
        }
      }
      writeJson(response, 201, { integration: serializeIntegration(integration, dependencies.pluginManager, dependencies.integrationStreams) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err }, "create integration failed");
      writeJson(response, 500, { error: msg });
    }
    return;
  }

  if (path === "/api/admin/integrations/test" && method === "POST") {
    if (!dependencies.pluginManager) {
      writeJson(response, 501, { error: "Plugin manager not available" });
      return;
    }

    const body = (await readBody(request)) ?? {};
    const integrationId = typeof body["integrationId"] === "string"
      ? body["integrationId"]
      : undefined;
    const requestedType = typeof body["type"] === "string"
      ? body["type"] as Integration["type"]
      : undefined;
    const config = asRecord(body["config"]);

    try {
      if (integrationId) {
        if (!dependencies.integrationStore) {
          writeJson(response, 501, { error: "Integration store not available" });
          return;
        }

        const existing = await dependencies.integrationStore.getIntegration(integrationId);
        if (!existing) {
          writeJson(response, 404, { error: "Integration not found" });
          return;
        }

        if (requestedType !== undefined && requestedType !== existing.type) {
          writeJson(response, 400, { error: "Changing integration type is not supported" });
          return;
        }

        const result = await dependencies.pluginManager.testConnectionConfig(
          existing.type,
          mergeIntegrationConfig(existing, config)
        );

        // Persist discovered models on successful test
        if (result.success && Array.isArray(result.models) && result.models.length > 0) {
          if (typeof dependencies.integrationStore.setIntegrationDiscoveredResources === "function") {
            await dependencies.integrationStore.setIntegrationDiscoveredResources(
              integrationId,
              JSON.stringify({ models: result.models })
            );
          }
        }

        writeJson(response, 200, result);
        return;
      }

      if (!requestedType) {
        writeJson(response, 400, { error: "Integration type is required" });
        return;
      }

      const result = await dependencies.pluginManager.testConnectionConfig(requestedType, config);
      writeJson(response, 200, result);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn({ integrationId, requestedType, errorMessage }, "config test connection failed");
      writeJson(response, 400, { success: false, error: errorMessage, models: [] });
    }
    return;
  }

  const integrationIdMatch = /^\/api\/admin\/integrations\/([^/]+)$/.exec(path);

  if (integrationIdMatch && method === "PUT") {
    if (!dependencies.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return;
    }
    const id = decodeURIComponent(integrationIdMatch[1] ?? "");
    const existing = await dependencies.integrationStore.getIntegration(id);
    if (!existing) {
      writeJson(response, 404, { error: "Integration not found" });
      return;
    }
    const body = await readBody(request);
    if (!body) {
      writeJson(response, 400, { error: "Request body required" });
      return;
    }
    const requestedType = body["type"] as Integration["type"] | undefined;
    if (requestedType !== undefined && requestedType !== existing.type) {
      writeJson(response, 400, { error: "Changing integration type is not supported" });
      return;
    }

    const nextType = existing.type;
    const descriptor = getPluginDescriptor(nextType);
    if (!descriptor) {
      writeJson(response, 400, { error: `Unknown integration type: ${nextType}` });
      return;
    }
    const nextConfig = body["config"];
    const mergedConfig = nextConfig === undefined
      ? getStoredIntegrationConfig(existing)
      : mergeIntegrationConfig(existing, asRecord(nextConfig));
    const validatedConfig = validateIntegrationConfig(descriptor.configSchema, mergedConfig, true);
    if (!validatedConfig) {
      writeJson(response, 400, { error: "Invalid integration config" });
      return;
    }

    try {
      const updated = await dependencies.integrationStore.upsertIntegration({
        id,
        type: nextType,
        name: (body["name"] as string) ?? existing.name,
        configJson: JSON.stringify(validatedConfig),
        enabled: existing.enabled,
      });
      const fullyValidatedConfig = validateIntegrationConfig(descriptor.configSchema, validatedConfig, false);
      let appliedAtRuntime = false;
      if (updated.enabled && dependencies.pluginManager && fullyValidatedConfig) {
        await dependencies.pluginManager.reloadIntegration(id);
        appliedAtRuntime = true;
      }
      // Invalidate any cached per-integration VCS connectors so the next task
      // uses fresh credentials/config.
      dependencies.onIntegrationUpdated?.(id);
      writeJson(response, 200, { 
        integration: serializeIntegration(updated, dependencies.pluginManager, dependencies.integrationStreams),
        appliedAtRuntime
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err }, "update integration failed");
      writeJson(response, 500, { error: msg });
    }
    return;
  }

  if (integrationIdMatch && method === "GET") {
    if (!dependencies.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return;
    }
    const id = decodeURIComponent(integrationIdMatch[1] ?? "");
    const integration = await dependencies.integrationStore.getIntegration(id);
    if (!integration) {
      writeJson(response, 404, { error: "Integration not found" });
      return;
    }
    writeJson(response, 200, { integration: serializeIntegration(integration, dependencies.pluginManager, dependencies.integrationStreams) });
    return;
  }

  if (integrationIdMatch && method === "DELETE") {
    if (!dependencies.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return;
    }
    const id = decodeURIComponent(integrationIdMatch[1] ?? "");
    const existing = await dependencies.integrationStore.getIntegration(id);
    if (!existing) {
      writeJson(response, 404, { error: "Integration not found" });
      return;
    }
    if (dependencies.integrationStore.countIntegrationReferences) {
      const refCount = await dependencies.integrationStore.countIntegrationReferences(id);
      if (refCount > 0) {
        writeJson(response, 409, {
          error: "Conflict",
          message: `Integration "${existing.name}" is still referenced by ${refCount} agent(s) or project relation(s) and cannot be deleted`,
          referenceCount: refCount,
        });
        return;
      }
    }
    try {
      if (existing.enabled && dependencies.pluginManager) {
        await dependencies.pluginManager.disablePlugin(id);
      }
      await dependencies.integrationStore.deleteIntegration(id);
      writeJson(response, 200, { deleted: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err }, "delete integration failed");
      writeJson(response, 500, { error: msg });
    }
    return;
  }

  const enableMatch = /^\/api\/admin\/integrations\/([^/]+)\/enable$/.exec(path);
  if (enableMatch && method === "PATCH") {
    if (!dependencies.pluginManager) {
      writeJson(response, 501, { error: "Plugin manager not available" });
      return;
    }
    const id = decodeURIComponent(enableMatch[1] ?? "");
    try {
      await dependencies.pluginManager.enablePlugin(id);
      const integration = await dependencies.integrationStore?.getIntegration(id);
      writeJson(response, 200, { integration: integration ? serializeIntegration(integration, dependencies.pluginManager, dependencies.integrationStreams) : { id, enabled: true } });
    } catch (err: unknown) {
      log.warn({ err }, "enable plugin failed");
      writeJson(response, 400, { error: "Operation failed" });
    }
    return;
  }

  const disableMatch = /^\/api\/admin\/integrations\/([^/]+)\/disable$/.exec(path);
  if (disableMatch && method === "PATCH") {
    if (!dependencies.pluginManager) {
      writeJson(response, 501, { error: "Plugin manager not available" });
      return;
    }
    const id = decodeURIComponent(disableMatch[1] ?? "");
    try {
      await dependencies.pluginManager.disablePlugin(id);
      const integration = await dependencies.integrationStore?.getIntegration(id);
      writeJson(response, 200, { integration: integration ? serializeIntegration(integration, dependencies.pluginManager, dependencies.integrationStreams) : { id, enabled: false } });
    } catch (err: unknown) {
      log.warn({ err }, "disable plugin failed");
      writeJson(response, 400, { error: "Operation failed" });
    }
    return;
  }

  const testMatch = /^\/api\/admin\/integrations\/([^/]+)\/test$/.exec(path);
  if (testMatch && method === "POST") {
    if (!dependencies.pluginManager) {
      writeJson(response, 501, { error: "Plugin manager not available" });
      return;
    }
    const id = decodeURIComponent(testMatch[1] ?? "");
    try {
      const result = await dependencies.pluginManager.testConnection(id);

      // Persist discovered models on successful test
      if (result.success && Array.isArray(result.models) && result.models.length > 0) {
        if (dependencies.integrationStore && typeof dependencies.integrationStore.setIntegrationDiscoveredResources === "function") {
          await dependencies.integrationStore.setIntegrationDiscoveredResources(
            id,
            JSON.stringify({ models: result.models })
          );
        }
      }

      writeJson(response, 200, result);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn({ id, errorMessage }, "test connection failed");
      writeJson(response, 400, { success: false, error: errorMessage, models: [] });
    }
    return;
  }

  const modelsMatch = /^\/api\/admin\/integrations\/([^/]+)\/models$/.exec(path);
  if (modelsMatch && method === "GET") {
    if (!dependencies.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return;
    }
    const id = decodeURIComponent(modelsMatch[1] ?? "");
    const integration = await dependencies.integrationStore.getIntegration(id);
    if (!integration) {
      writeJson(response, 404, { error: "Integration not found" });
      return;
    }
    if (typeof dependencies.integrationStore.getIntegrationDiscoveredResources === "function") {
      const discovered = await dependencies.integrationStore.getIntegrationDiscoveredResources(id);
      if (discovered.json) {
        try {
          const parsed = JSON.parse(discovered.json) as unknown;
          if (parsed && typeof parsed === "object" && "models" in parsed && Array.isArray((parsed as Record<string, unknown>)["models"])) {
            writeJson(response, 200, { models: (parsed as Record<string, unknown>)["models"] });
            return;
          }
        } catch { /* fallthrough to empty */ }
      }
    }
    writeJson(response, 200, { models: [] });
    return;
  }

  const discoverMatch = /^\/api\/admin\/integrations\/([^/]+)\/discover$/.exec(path);
  if (discoverMatch && method === "POST") {
    if (!dependencies.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return;
    }
    if (typeof dependencies.integrationStore.setIntegrationDiscoveredResources !== "function") {
      writeJson(response, 501, { error: "Integration store does not support discovery persistence" });
      return;
    }

    const id = decodeURIComponent(discoverMatch[1] ?? "");
    const integration = await dependencies.integrationStore.getIntegration(id);
    if (!integration) {
      writeJson(response, 404, { error: "Integration not found" });
      return;
    }

    const descriptor = getPluginDescriptor(integration.type);

    // ── Copilot: model discovery via OAuth token ──────────────────────────
    if (integration.type === "copilot") {
      let parsedCopilotConfig: Record<string, unknown>;
      try {
        parsedCopilotConfig = JSON.parse(integration.configJson) as Record<string, unknown>;
      } catch {
        writeJson(response, 500, { error: "Stored integration config is not valid JSON" });
        return;
      }
      const encryptedToken = typeof parsedCopilotConfig["sessionToken"] === "string"
        ? parsedCopilotConfig["sessionToken"]
        : undefined;
      if (!encryptedToken) {
        writeJson(response, 400, {
          error: "No GitHub OAuth token stored. Connect via OAuth first (AI Adapters → Connect with GitHub).",
        });
        return;
      }
      try {
        const oauthToken = decryptToken(encryptedToken, dependencies.config.adminAuthSecret);
        const sessionToken = await exchangeForSessionToken(oauthToken);
        const models = await fetchAvailableModels(sessionToken);
        const discoveredAt = new Date().toISOString();
        const json = JSON.stringify({ models, discoveredAt });
        await dependencies.integrationStore.setIntegrationDiscoveredResources(id, json);
        writeJson(response, 200, { ok: true, discoveredAt, counts: { models: models.length } });
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn({ id, type: "copilot", errorMessage }, "Copilot model discovery failed");
        writeJson(response, 502, { error: `Model discovery failed: ${errorMessage}` });
      }
      return;
    }
    // ─────────────────────────────────────────────────────────────────────

    if (!descriptor || typeof descriptor.discoverResources !== "function") {
      writeJson(response, 400, {
        error: `Integration type '${integration.type}' does not support resource discovery`,
      });
      return;
    }

    let parsedConfig: unknown;
    try {
      parsedConfig = JSON.parse(integration.configJson);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeJson(response, 500, { error: `Stored integration config is not valid JSON: ${msg}` });
      return;
    }

    try {
      const snapshot = await descriptor.discoverResources(parsedConfig);
      const json = JSON.stringify(snapshot);
      await dependencies.integrationStore.setIntegrationDiscoveredResources(id, json);
      writeJson(response, 200, {
        ok: true,
        discoveredAt: snapshot.discoveredAt,
        counts: {
          ticketProjects: snapshot.ticketProjects?.length ?? 0,
          repositories: snapshot.repositories?.length ?? 0,
        },
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn({ id, type: integration.type, errorMessage }, "resource discovery failed");
      writeJson(response, 502, { error: `Discovery failed: ${errorMessage}` });
    }
    return;
  }

  // ─── Phase 3: Agents and Projects routes (modular dispatch) ───────────────
  if (await handleAgentsRoute(request, response, path, method, {
    agentStore: dependencies.agentStore,
    integrationStore: dependencies.integrationStore,
    oAuthAppStore,
    adminAuthSecret: dependencies.config.adminAuthSecret,
    providerAuthService: dependencies.providerAuthService,
  })) {
    return;
  }
  if (await handleProjectsRoute(request, response, path, method, {
    projectStore: dependencies.projectStore,
    integrationStore: dependencies.integrationStore,
    onProjectChange: dependencies.onProjectChange,
  })) {
    return;
  }

  // ─── Phase 6: Concurrency surfacing ───────────────────────────────────────
  if (path === "/api/admin/concurrency") {
    if (!dependencies.concurrency) {
      writeJson(response, 501, { error: "Concurrency tracker not available" });
      return;
    }
    if (method === "GET") {
      const global = await dependencies.concurrency.getGlobalLimit();
      writeJson(response, 200, {
        global,
        snapshot: dependencies.concurrency.snapshot(),
      });
      return;
    }
    if (method === "PUT") {
      let body: Record<string, unknown> | null;
      try {
        body = await readBody(request);
      } catch {
        writeJson(response, 400, { error: "Invalid JSON body" });
        return;
      }
      const value = body?.["global"];
      let next: number | null;
      if (value === null) {
        next = null;
      } else if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        next = Math.floor(value);
      } else {
        writeJson(response, 400, { error: "global must be a non-negative number or null" });
        return;
      }
      await dependencies.concurrency.setGlobalLimit(next);
      writeJson(response, 200, {
        global: next,
        snapshot: dependencies.concurrency.snapshot(),
      });
      return;
    }
    writeJson(response, 405, { error: "Method not allowed" });
    return;
  }

  // ─── Phase 5: Webhook secret management routes ────────────────────────────
  const rotateSecretMatch = /^\/api\/admin\/integrations\/([^/]+)\/webhook-secret\/rotate$/.exec(path);
  if (rotateSecretMatch && method === "POST") {
    if (!dependencies.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return;
    }
    const id = decodeURIComponent(rotateSecretMatch[1] ?? "");
    const integration = await dependencies.integrationStore.getIntegration(id);
    if (!integration) {
      writeJson(response, 404, { error: "Integration not found" });
      return;
    }
    const newSecret = generateWebhookSecret();
    let parsed: Record<string, unknown>;
    try {
      const obj = JSON.parse(integration.configJson) as unknown;
      parsed = (typeof obj === "object" && obj !== null && !Array.isArray(obj))
        ? (obj as Record<string, unknown>)
        : {};
    } catch {
      parsed = {};
    }
    parsed["webhookSecret"] = newSecret;
    try {
      await dependencies.integrationStore.upsertIntegration({
        id: integration.id,
        type: integration.type,
        name: integration.name,
        configJson: JSON.stringify(parsed),
        enabled: integration.enabled,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ id, err }, "rotate webhook secret failed");
      writeJson(response, 500, { error: msg });
      return;
    }
    dependencies.onIntegrationUpdated?.(id);
    writeJson(response, 200, { secret: newSecret });
    return;
  }

  // ─── Webhook allowed IPs management route ───────────────────────────────────
  const webhookIpsMatch = /^\/api\/admin\/integrations\/([^/]+)\/webhook-allowed-ips$/.exec(path);
  if (webhookIpsMatch && method === "PUT") {
    if (!dependencies.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return;
    }
    const id = decodeURIComponent(webhookIpsMatch[1] ?? "");
    const integration = await dependencies.integrationStore.getIntegration(id);
    if (!integration) {
      writeJson(response, 404, { error: "Integration not found" });
      return;
    }
    const body = await readBody(request);
    if (!body) {
      writeJson(response, 400, { error: "Invalid JSON body" });
      return;
    }
    const { allowedIps } = body as Record<string, unknown>;
    if (!Array.isArray(allowedIps)) {
      writeJson(response, 400, { error: "allowedIps must be an array of IP strings" });
      return;
    }
    for (const ip of allowedIps) {
      if (typeof ip !== "string") {
        writeJson(response, 400, { error: "Each allowed IP must be a string" });
        return;
      }
    }
    let parsed: Record<string, unknown>;
    try {
      const obj = JSON.parse(integration.configJson) as unknown;
      parsed = (typeof obj === "object" && obj !== null && !Array.isArray(obj))
        ? (obj as Record<string, unknown>)
        : {};
    } catch {
      parsed = {};
    }
    parsed["webhookAllowedIps"] = allowedIps;
    try {
      await dependencies.integrationStore.upsertIntegration({
        id: integration.id,
        type: integration.type,
        name: integration.name,
        configJson: JSON.stringify(parsed),
        enabled: integration.enabled,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ id, err }, "update webhook allowed IPs failed");
      writeJson(response, 500, { error: msg });
      return;
    }
    dependencies.onIntegrationUpdated?.(id);
    writeJson(response, 200, { allowedIps });
    return;
  }

  // ─── Webhook allowed IPs GET route ──────────────────────────────────────────
  if (webhookIpsMatch && method === "GET") {
    if (!dependencies.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return;
    }
    const id = decodeURIComponent(webhookIpsMatch[1] ?? "");
    const integration = await dependencies.integrationStore.getIntegration(id);
    if (!integration) {
      writeJson(response, 404, { error: "Integration not found" });
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      const obj = JSON.parse(integration.configJson) as unknown;
      parsed = (typeof obj === "object" && obj !== null && !Array.isArray(obj))
        ? (obj as Record<string, unknown>)
        : {};
    } catch {
      parsed = {};
    }
    const allowedIps = Array.isArray(parsed["webhookAllowedIps"]) ? parsed["webhookAllowedIps"] : [];
    writeJson(response, 200, { allowedIps });
    return;
  }

  const webhookInfoMatch = /^\/api\/admin\/integrations\/([^/]+)\/webhook-info$/.exec(path);
  if (webhookInfoMatch && method === "GET") {
    if (!dependencies.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return;
    }
    const id = decodeURIComponent(webhookInfoMatch[1] ?? "");
    const integration = await dependencies.integrationStore.getIntegration(id);
    if (!integration) {
      writeJson(response, 404, { error: "Integration not found" });
      return;
    }
    let secretConfigured = false;
    try {
      const obj = JSON.parse(integration.configJson) as unknown;
      if (typeof obj === "object" && obj !== null) {
        const v = (obj as Record<string, unknown>)["webhookSecret"];
        secretConfigured = typeof v === "string" && v.length > 0;
      }
    } catch { /* secretConfigured stays false */ }

    const events = listSupportedEvents(integration.type);
    const hostHeader = request.headers.host ?? "127.0.0.1";
    const base = dependencies.webhooks?.publicBaseUrl ?? `http://${hostHeader}`;
    const sample = events[0] ?? "<event>";
    writeJson(response, 200, {
      integrationId: integration.id,
      integrationType: integration.type,
      url: `${base.replace(/\/$/, "")}/webhooks/${encodeURIComponent(integration.id)}/${encodeURIComponent(sample)}`,
      urlTemplate: `${base.replace(/\/$/, "")}/webhooks/${encodeURIComponent(integration.id)}/:event`,
      events,
      secretConfigured,
    });
    return;
  }

  writeJson(response, 404, { error: "Not found" });
}

/** Returns true if task b is a strictly newer candidate than task a. */
function pickLatest(a: Task | undefined, b: Task): boolean {
  if (!a) return true;
  if (b.updatedAt.getTime() > a.updatedAt.getTime()) return true;
  if (b.updatedAt.getTime() === a.updatedAt.getTime() && b.createdAt.getTime() > a.createdAt.getTime()) return true;
  return false;
}

/** Deduplicate tasks, keeping the most-recent per ticketId and per externalChangeId. */
function deduplicateByTicket(tasks: Task[]): Task[] {
  // First pass: keep the most-recently-updated task per ticketId.
  const byTicket = new Map<string, Task>();
  for (const task of tasks) {
    if (pickLatest(byTicket.get(task.ticketId), task)) {
      byTicket.set(task.ticketId, task);
    }
  }

  // Second pass: for tasks with an external change ID (e.g. Gerrit's Change-Id),
  // further deduplicate by that ID. This handles the case where the same
  // underlying change produced tasks with different ticketIds (e.g. after an
  // integration was recreated). The check is data-driven — any review system
  // that populates gerritChangeId gets the same behaviour.
  const byChangeId = new Map<string, Task>();
  for (const task of byTicket.values()) {
    if (!task.externalChangeId) continue;
    if (pickLatest(byChangeId.get(task.externalChangeId), task)) {
      byChangeId.set(task.externalChangeId, task);
    }
  }

  return Array.from(byTicket.values()).filter((task) => {
    if (task.externalChangeId) {
      return byChangeId.get(task.externalChangeId) === task;
    }
    return true;
  });
}

/** Serialize a Task to the admin API response shape. */
function serializeTask(task: Task): Record<string, unknown> {
  return {
    taskId: task.taskId,
    taskType: task.taskType,
    ticketId: task.ticketId,
    ticketSourceLabel: task.ticketSourceLabel,
    ticketTitle: task.ticketTitle,
    ticketDescription: task.ticketDescription,
    state: task.state,
    gerritChangeId: task.externalChangeId,
    currentPatchset: task.currentPatchset,
    reviewedPatchset: task.reviewedPatchset,
    cycleCount: task.cycleCount,
    failureReason: task.failureReason,
    ticketUrl: task.ticketUrl,
    reviewUrl: task.reviewUrl,
    displayId: task.displayId ?? task.ticketId,
    createdAt: toIsoTimestamp(task.createdAt),
    updatedAt: toIsoTimestamp(task.updatedAt),
  };
}

/** Serialize an AgentCycle to the admin API response shape. */
function serializeCycle(cycle: AgentCycle): Record<string, unknown> {
  return {
    id: cycle.id,
    taskId: cycle.taskId,
    cycleNumber: cycle.cycleNumber,
    result: cycle.result,
    validationResult: cycle.validationResult,
    createdAt: toIsoTimestamp(cycle.createdAt),
  };
}

/** Serialize a StateTransition to the admin API response shape. */
function serializeTransition(transition: StateTransition): Record<string, unknown> {
  return {
    id: transition.id,
    taskId: transition.taskId,
    fromState: transition.fromState,
    toState: transition.toState,
    metadata: transition.metadata,
    createdAt: toIsoTimestamp(transition.createdAt),
  };
}

/** Serialize a Prompt to the admin API response shape. */
function serializePrompt(prompt: Prompt): Record<string, unknown> {
  return {
    id: prompt.id,
    label: prompt.label,
    content: prompt.content,
    promptType: prompt.promptType,
    updatedAt: toIsoTimestamp(prompt.updatedAt),
  };
}


/** Serialize all log entries for an agent cycle into the admin log-stream shape. */
function serializeAgentLogEntries(cycle: AgentCycle): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  const rawLogs = cycle.result.agentLogs.trim();

  if (rawLogs.length > 0) {
    entries.push(
      ...rawLogs
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => ({
          timestamp: toIsoTimestamp(cycle.createdAt),
          taskId: cycle.taskId,
          level: "info",
          message: line,
          source: "agent",
        }))
    );
  }

  if (cycle.result.agentEvents?.length) {
    entries.push(...cycle.result.agentEvents.map((event) => serializeAgentEventEntry(event)));
  }

  return entries;
}

/** Serialize a single AgentLogEvent into the admin log-stream shape. */
function serializeAgentEventEntry(event: AgentLogEvent): Record<string, unknown> {
  const normalized = normalizeAgentEvent(event);
  return {
    timestamp: normalized.timestamp,
    taskId: normalized.taskId,
    level: normalized.level,
    message: normalized.message,
    source: "agent",
    type: normalized.type,
    category: normalized.category,
    cycleNumber: normalized.cycleNumber,
    data: normalized.data,
  };
}

/** Derive the admin auth mode string from the runtime config. */
function getAdminAuthMode(config: AdminRuntimeConfig): "none" | "hmac" {
  if (config.adminAuthSecret) {
    return "hmac";
  }

  return "none";
}

/** Write a JSON response with the given status code. */
function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

/** Write an HTML response with the given status code. */
function writeHtml(response: ServerResponse, statusCode: number, html: string): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(html);
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

  // Check HMAC signature with timestamp
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

    // Verify HMAC signature using constant-time comparison
    // ⚠️ SECURITY: We compare both Buffers and use timingSafeEqual to prevent timing attacks.
    // Regular string comparison (===) would leak information about the expected signature via timing,
    // allowing attackers to brute-force valid signatures byte-by-byte.
    // timingSafeEqual ensures comparison time is independent of where bytes match/differ.
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
  // Simulate Bearer check by reusing the same logic path
  const fakeRequest = { headers: { authorization: "Bearer " + token } } as unknown as IncomingMessage;
  return isAuthorized(fakeRequest, config);
}

/** Set security-oriented HTTP response headers (CSP, no-store, no-sniff, etc.) on every admin response. */
function applySecurityHeaders(response: ServerResponse): void {
  // ⚠️ SECURITY: Prevent browser caching of sensitive admin responses
  response.setHeader("cache-control", "no-store");
  response.setHeader("pragma", "no-cache");

  // ⚠️ SECURITY: Prevent MIME type sniffing attacks (X-Content-Type-Options: nosniff)
  response.setHeader("x-content-type-options", "nosniff");

  // ⚠️ SECURITY: Prevent clickjacking (X-Frame-Options: DENY)
  response.setHeader("x-frame-options", "DENY");

  // ⚠️ SECURITY: Limit Referer header exposure
  response.setHeader("referrer-policy", "no-referrer");

  // ⚠️ SECURITY: Content Security Policy mitigates XSS attacks
  // default-src 'self' blocks all resources except same-origin
  // script-src 'unsafe-inline' needed for dashboard inline scripts
  // style-src 'unsafe-inline' needed for inline CSS
  // img-src allows data: for embedded icons
  // connect-src 'self' only for admin API calls
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
  );
}

/** Serialize an Integration record to the admin API response shape with masked secrets. */
function serializeIntegration(
  integration: Integration,
  pm?: PluginManager,
  integrationStreams?: { getStatus(integrationId: string): unknown | null }
): Record<string, unknown> {
  const descriptor = getPluginDescriptor(integration.type);
  const active = pm ? pm.isIntegrationActive(integration.id) : false;
  const streamEventsSupported = Boolean(descriptor?.streamEvents);
  return {
    id: integration.id,
    type: integration.type,
    category: descriptor?.category ?? null,
    capabilities: descriptor ? getPluginCapabilities(descriptor) : [],
    name: integration.name,
    enabled: integration.enabled,
    active,
    config: maskIntegrationConfig(integration),
    createdAt: toIsoTimestamp(integration.createdAt),
    updatedAt: toIsoTimestamp(integration.updatedAt),
    discoveredAt: integration.discoveredAt ? toIsoTimestamp(integration.discoveredAt) : null,
    discoveredResources: parseDiscoveredResources(integration.discoveredResourcesJson ?? null),
    discoverySupported: typeof descriptor?.discoverResources === "function",
    streamEventsSupported,
    ...(streamEventsSupported
      ? { streamStatus: integrationStreams?.getStatus(integration.id) ?? null }
      : {}),
  };
}

function serializeOAuthApp(app: OAuthApp): Record<string, unknown> {
  return {
    provider: app.provider,
    baseUrl: app.baseUrl,
    clientId: app.clientId,
    createdAt: toIsoTimestamp(app.createdAt),
    updatedAt: toIsoTimestamp(app.updatedAt),
  };
}

/** Parse a discovered-resources JSON string, returning null on failure or empty input. */
function parseDiscoveredResources(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Normalize a legacy timestamp value (Date | string | number) to an ISO-8601 string. */
function toIsoTimestamp(value: Date | string | number): string {
  // Admin API responses must tolerate legacy SQLite rows where timestamp columns
  // were persisted or hydrated as strings/numbers instead of Date objects.
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? new Date(0).toISOString() : value.toISOString();
  }

  if (typeof value === "number") {
    const millis = Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
  }

  const numericValue = Number(value);
  if (!Number.isNaN(numericValue) && value.trim() !== "") {
    return toIsoTimestamp(numericValue);
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

/**
 * Returns the integration's stored config with every `password`-typed field replaced
 * by SECRET_MASK. Safe to send to the browser — the real secret is never exposed.
 * Fields that are empty or absent are left as-is (no masking needed).
 */
function maskIntegrationConfig(integration: Integration): Record<string, unknown> {
  const descriptor = getPluginDescriptor(integration.type);
  const config = getStoredIntegrationConfig(integration);
  if (!descriptor) {
    return config;
  }

  const masked = { ...config };
  for (const secretField of descriptor.requiredFields.filter((field) => field.type === "password")) {
    const currentValue = masked[secretField.key];
    if (currentValue !== undefined && currentValue !== null && String(currentValue).length > 0) {
      masked[secretField.key] = SECRET_MASK;
    }
  }
  // Phase 5: also mask any field whose key contains "secret" (case-insensitive),
  // covering webhookSecret and any future *Secret fields without requiring an
  // explicit `requiredFields` entry per descriptor.
  for (const [key, value] of Object.entries(masked)) {
    if (/secret/i.test(key) && value !== undefined && value !== null && String(value).length > 0) {
      masked[key] = SECRET_MASK;
    }
  }
  if (integration.type === "gerrit") {
    delete masked["webhookSecret"];
    delete masked["webhookAllowedIps"];
  }
  if (
    (integration.type === "gitlab-issue" || integration.type === "gitlab-merge-request") &&
    masked["authMode"] === undefined
  ) {
    masked["authMode"] = "pat";
  }
  return masked;
}

/**
 * Merges `updates` into the integration's existing config while preserving secrets.
 *
 * Secret preservation rule: if an incoming `password`-typed field is absent, empty,
 * or equals SECRET_MASK (i.e. the browser echoed the placeholder back), the
 * original stored value is kept. This prevents a UI edit from accidentally wiping
 * a token that the user didn't intend to change.
 */
function mergeIntegrationConfig(integration: Integration, updates: Record<string, unknown>): Record<string, unknown> {
  const descriptor = getPluginDescriptor(integration.type);
  const existingConfig = getStoredIntegrationConfig(integration);
  const merged: Record<string, unknown> = {
    ...existingConfig,
    ...updates,
  };

  if (!descriptor) {
    return merged;
  }

  for (const secretField of descriptor.requiredFields.filter((field) => field.type === "password")) {
    const incomingValue = updates[secretField.key];
    if (
      incomingValue === undefined ||
      incomingValue === null ||
      incomingValue === "" ||
      incomingValue === SECRET_MASK
    ) {
      if (secretField.key in existingConfig) {
        merged[secretField.key] = existingConfig[secretField.key];
      } else {
        delete merged[secretField.key];
      }
    }
  }

  // Phase 5: same preservation rule for any *secret* field that isn't declared
  // as a requiredField (e.g. webhookSecret). Without this, the masked echo from
  // the dashboard would clobber the stored value.
  for (const key of Object.keys({ ...existingConfig, ...updates })) {
    if (!/secret/i.test(key)) continue;
    if (descriptor.requiredFields.some((f) => f.key === key && f.type === "password")) continue;
    const incomingValue = updates[key];
    if (
      incomingValue === undefined ||
      incomingValue === null ||
      incomingValue === "" ||
      incomingValue === SECRET_MASK
    ) {
      if (key in existingConfig) {
        merged[key] = existingConfig[key];
      } else {
        delete merged[key];
      }
    }
  }

  return merged;
}

/** Parse a config JSON string into a plain record; returns an empty object on failure. */
function parseConfig(configJson: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(configJson));
  } catch {
    return {};
  }
}

/** Return the integration's stored config with schema-unknown keys stripped. */
function getStoredIntegrationConfig(integration: Integration): Record<string, unknown> {
  return stripUnknownIntegrationConfig(integration.type, parseConfig(integration.configJson));
}

/** Remove any config keys not declared in the integration type's Zod schema. */
function stripUnknownIntegrationConfig(
  type: Integration["type"],
  config: Record<string, unknown>
): Record<string, unknown> {
  const descriptor = getPluginDescriptor(type);
  if (!descriptor || !(descriptor.configSchema instanceof z.ZodObject)) {
    return config;
  }

  const allowedKeys = new Set(descriptor.configSchema.keyof().options);
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (allowedKeys.has(key)) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/** Validate a config object against a Zod schema, returning null when validation fails. */
function validateIntegrationConfig(
  schema: z.ZodType<unknown>,
  config: Record<string, unknown>,
  partial: boolean
): Record<string, unknown> | null {
  const validationSchema = schema instanceof z.ZodObject
    ? (partial ? schema.strict().partial() : schema.strict())
    : schema;
  const validation = validationSchema.safeParse(config);
  if (!validation.success) {
    return null;
  }

  return asRecord(validation.data);
}

/** Cast an unknown value to a plain object record; returns an empty object for non-objects. */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

// ⚠️ SECURITY: Limit request body to 512 KB to prevent memory exhaustion attacks.
// Attackers could send gigabyte-sized requests to force OOM kills of the orchestrator.
// This limit also prevents accidental oversized payloads from wasting memory.
const MAX_BODY_BYTES = 512 * 1024; // 512 KB

/** Read and parse the request body as JSON, returning null on error or when body exceeds MAX_BODY_BYTES. */
async function readBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        // ⚠️ SECURITY: Destroy the request socket immediately to terminate the connection
        // and prevent further data transmission. This signals to the client that the body is too large.
        request.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) { resolve(null); return; }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });
    request.on("error", () => resolve(null));
  });
}

/** Generate a random UUID for use as a new integration id. */
function randomId(): string {
  return randomUUID();
}