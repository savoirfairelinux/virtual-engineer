import { statSync } from "node:fs";
import { getLogger } from "../logger.js";
import { writeJson } from "./adminRouteUtils.js";
import type { Router } from "./router.js";
import type {
  Task,
  AgentCycle,
  CostSummary,
  CostSummaryProject,
  CycleCostTokens,
  ModelUsageEntry,
  ModelUsageProject,
  ModelUsageSummary,
  ProjectId,
  ProjectRecord,
} from "../interfaces.js";
import { makeTaskId, TASK_WORKFLOW_BUCKETS } from "../interfaces.js";
import type { AdminRuntimeConfig } from "./adminServer.js";
import { filterTasksByReadAccess } from "./adminTaskRoutes.js";
import { getEffectivePermissions, requestCanAccessResource } from "./authContext.js";

const log = getLogger("admin-overview");

export interface OverviewRouteStore {
  getAllTasks(): Promise<Task[]>;
  getAgentCycles(taskId: ReturnType<typeof makeTaskId>): Promise<AgentCycle[]>;
  getCostSummary(options?: { since?: Date }): Promise<CostSummary>;
  getModelUsageSummary(options?: { since?: Date }): Promise<ModelUsageSummary>;
}

export interface OverviewRouteDeps {
  stateStore: OverviewRouteStore;
  projectStore?: {
    getProjectById(id: ProjectId): Promise<ProjectRecord | null>;
    listProjects(): Promise<ProjectRecord[]>;
  } | undefined;
  config: AdminRuntimeConfig;
  databasePath: string;
  pollingIntervalMs: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const NUM_TICKS = 14;

function sumTokens(items: readonly { tokens: CycleCostTokens }[]): CycleCostTokens {
  return items.reduce<CycleCostTokens>((total, item) => ({
    input: total.input + item.tokens.input,
    output: total.output + item.tokens.output,
    cached: total.cached + item.tokens.cached,
    cacheWrite: total.cacheWrite + item.tokens.cacheWrite,
  }), { input: 0, output: 0, cached: 0, cacheWrite: 0 });
}

async function readableProjectIds(
  req: import("node:http").IncomingMessage,
  projectStore: NonNullable<OverviewRouteDeps["projectStore"]>
): Promise<Set<string>> {
  const projects = await projectStore.listProjects();
  return new Set(projects
    .filter((project) => requestCanAccessResource(req, "project.read", {
      type: "project",
      id: project.id,
      ownerUserId: project.ownerUserId ?? null,
    }))
    .map((project) => project.id));
}

function filterCostSummary(summary: CostSummary, projectIds: ReadonlySet<string>): CostSummary {
  const perProject = summary.perProject.filter(
    (entry): entry is CostSummaryProject => entry.projectId !== null && projectIds.has(entry.projectId)
  );
  return {
    totalUsd: perProject.reduce((total, entry) => total + entry.usd, 0),
    totalAiCredits: perProject.reduce((total, entry) => total + entry.aiCredits, 0),
    totalPremiumRequests: perProject.reduce((total, entry) => total + entry.premiumRequests, 0),
    totalRuns: perProject.reduce((total, entry) => total + entry.runCount, 0),
    totalTokens: sumTokens(perProject),
    totalRunsWithTokens: perProject.reduce((total, entry) => total + entry.runCountWithTokens, 0),
    perProject,
    sinceEpochSeconds: summary.sinceEpochSeconds,
  };
}

function filterModelUsageSummary(
  summary: ModelUsageSummary,
  projectIds: ReadonlySet<string>
): ModelUsageSummary {
  const perProject = summary.perProject.filter(
    (entry): entry is ModelUsageProject => entry.projectId !== null && projectIds.has(entry.projectId)
  );
  const aggregated = new Map<string, ModelUsageEntry>();
  for (const project of perProject) {
    for (const model of project.models) {
      const key = `${model.modelId ?? ""}\u0000${model.workflowBucket}`;
      const existing = aggregated.get(key);
      aggregated.set(key, existing ? {
        ...existing,
        runCount: existing.runCount + model.runCount,
        usd: existing.usd + model.usd,
        tokens: sumTokens([existing, model]),
        runCountWithTokens: existing.runCountWithTokens + model.runCountWithTokens,
      } : { ...model });
    }
  }
  const byModel = [...aggregated.values()].sort((left, right) => right.runCount - left.runCount);
  return {
    byModel,
    perProject,
    totalRuns: byModel.reduce((total, entry) => total + entry.runCount, 0),
    totalUsd: byModel.reduce((total, entry) => total + entry.usd, 0),
    totalTokens: sumTokens(byModel),
    sinceEpochSeconds: summary.sinceEpochSeconds,
  };
}

/** Compute throughput: count of tasks updated in each of the last N polling-interval windows. */
function computeThroughput(tasks: Task[], pollingIntervalMs: number): number[] {
  const now = Date.now();
  const bins = Array.from({ length: NUM_TICKS }, () => 0);
  const totalMs = NUM_TICKS * pollingIntervalMs;
  for (const t of tasks) {
    const age = now - t.updatedAt.getTime();
    if (age < 0 || age >= totalMs) continue;
    const bin = NUM_TICKS - 1 - Math.floor(age / pollingIntervalMs);
    if (bin >= 0 && bin < NUM_TICKS) bins[bin] = (bins[bin] ?? 0) + 1;
  }
  return bins;
}

/** Extract review vote counts from the last 7 days of agent cycles. */
async function computeReviewVotes(
  tasks: Task[],
  store: OverviewRouteStore
): Promise<{ plus2: number; plus1: number; minus1: number; minus2: number }> {
  const sevenDaysAgo = Date.now() - SEVEN_DAYS_MS;
  const votes = { plus2: 0, plus1: 0, minus1: 0, minus2: 0 };

  const reviewTasks = tasks.filter(
    (t) => t.taskType === "code-review" && t.updatedAt.getTime() > sevenDaysAgo
  );

  for (const task of reviewTasks.slice(0, 20)) {
    try {
      const cycles = await store.getAgentCycles(task.taskId);
      for (const cycle of cycles) {
        const score = cycle.result.metadata?.["score"];
        if (typeof score === "number") {
          if (score >= 2) votes.plus2++;
          else if (score === 1) votes.plus1++;
          else if (score === -1) votes.minus1++;
          else if (score <= -2) votes.minus2++;
        }
      }
    } catch (err) {
      log.debug({ err, taskId: task.taskId }, "failed to get cycles for vote stats");
    }
  }

  return votes;
}

export function registerOverviewRoutes(router: Router, deps: OverviewRouteDeps): void {
  router.add("GET", "/api/admin/overview", async (req, res, _params) => {
    try {
      const allTasks = await deps.stateStore.getAllTasks();
      const tasks = deps.projectStore
        ? await filterTasksByReadAccess(req, allTasks, deps.projectStore)
        : allTasks;
      const now = Date.now();
      const sevenDaysAgo = now - SEVEN_DAYS_MS;

      const stats = {
        activeTasks:      tasks.filter((t) => TASK_WORKFLOW_BUCKETS.get(t.state) === "active").length,
        watchingTasks:    tasks.filter((t) => TASK_WORKFLOW_BUCKETS.get(t.state) === "watching").length,
        completedLast7d:  tasks.filter((t) => TASK_WORKFLOW_BUCKETS.get(t.state) === "done" && t.updatedAt.getTime() > sevenDaysAgo).length,
        failedLast7d:     tasks.filter((t) => TASK_WORKFLOW_BUCKETS.get(t.state) === "failed" && t.updatedAt.getTime() > sevenDaysAgo).length,
        activeProviders:  0, // populated separately via /api/admin/providers
      };

      const throughput = computeThroughput(tasks, deps.pollingIntervalMs);
      const reviewVotes = await computeReviewVotes(tasks, deps.stateStore);

      let dbSize = "—";
      try {
        const s = statSync(deps.databasePath);
        dbSize = formatBytes(s.size);
      } catch { /* DB path not accessible */ }

      const runtime = {
        environment:     deps.config.nodeEnv,
        version:         "—",
        uptime:          formatUptime(process.uptime()),
        dbSize,
        maxCycles:       deps.config.maxAgentCycles,
        maxRetries:      deps.config.maxRetryAttempts,
        pollingInterval: `${deps.pollingIntervalMs / 1000}s`,
        logLevel:        deps.config.logLevel,
      };

      writeJson(res, 200, { stats, throughput, reviewVotes, runtime });
    } catch (err) {
      log.error({ err }, "overview route failed");
      writeJson(res, 500, { error: "Failed to compute overview" });
    }
  }, { permission: "overview.read" });

  // Aggregated AI cost: per-project breakdown + instance total, optionally
  // scoped to a trailing period via `?days=<n>` (omitted = all-time).
  router.add("GET", "/api/admin/cost-summary", async (req, res, _params) => {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const daysParam = requestUrl.searchParams.get("days");
      let since: Date | undefined;
      if (daysParam !== null) {
        const days = Number(daysParam);
        if (Number.isFinite(days) && days > 0) {
          since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        }
      }
      const summary = await deps.stateStore.getCostSummary(since ? { since } : undefined);
      const visible = deps.projectStore && getEffectivePermissions(req)?.isSuperuser !== true
        ? filterCostSummary(summary, await readableProjectIds(req, deps.projectStore))
        : summary;
      writeJson(res, 200, visible);
    } catch (err) {
      log.error({ err }, "cost-summary route failed");
      writeJson(res, 500, { error: "Failed to compute cost summary" });
    }
  }, { permission: "overview.read" });

  // Model usage distribution (run count + cost), global and per project,
  // optionally scoped to a trailing period via `?days=<n>`.
  router.add("GET", "/api/admin/model-usage", async (req, res, _params) => {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const daysParam = requestUrl.searchParams.get("days");
      let since: Date | undefined;
      if (daysParam !== null) {
        const days = Number(daysParam);
        if (Number.isFinite(days) && days > 0) {
          since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        }
      }
      const summary = await deps.stateStore.getModelUsageSummary(since ? { since } : undefined);
      const visible = deps.projectStore && getEffectivePermissions(req)?.isSuperuser !== true
        ? filterModelUsageSummary(summary, await readableProjectIds(req, deps.projectStore))
        : summary;
      writeJson(res, 200, visible);
    } catch (err) {
      log.error({ err }, "model-usage route failed");
      writeJson(res, 500, { error: "Failed to compute model usage" });
    }
  }, { permission: "overview.read" });
}
