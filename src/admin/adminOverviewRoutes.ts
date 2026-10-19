import { statSync } from "node:fs";
import { getLogger } from "../logger.js";
import { csvCell, parseCalendarDate, writeJson } from "./adminRouteUtils.js";
import type { Router } from "./router.js";
import type {
  Task,
  AgentCycle,
  CostSummary,
  CostSummaryProject,
  CycleCostTokens,
  CycleSummaryOptions,
  ModelUsageEntry,
  ModelUsageProject,
  ModelUsageSummary,
  ProjectId,
  ProjectRecord,
  ReviewVoteCounts,
  ReviewVoteOptions,
  TaskId,
} from "../interfaces.js";
import { makeProjectId, makeTaskId, TASK_WORKFLOW_BUCKETS } from "../interfaces.js";
import type { AdminRuntimeConfig } from "./adminServer.js";
import { deduplicateByTicket, filterTasksByReadAccess } from "./adminTaskRoutes.js";
import { getAuthContext, getEffectivePermissions, requestCanAccessResource } from "./authContext.js";

const log = getLogger("admin-overview");

export interface OverviewRouteStore {
  getAllTasks(): Promise<Task[]>;
  getAgentCycles(taskId: ReturnType<typeof makeTaskId>): Promise<AgentCycle[]>;
  getReviewVoteCounts?(taskIds: TaskId[], since?: Date, options?: ReviewVoteOptions): Promise<ReviewVoteCounts>;
  getCurrentStateEnteredAt?(taskIds: TaskId[]): Promise<Map<TaskId, Date>>;
  getCostSummary(options?: CycleSummaryOptions): Promise<CostSummary>;
  getModelUsageSummary(options?: CycleSummaryOptions): Promise<ModelUsageSummary>;
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

type TaskOutcome = "completed" | "failed" | "abandoned";

/** Terminal outcome shown on the dashboard; ABANDONED is deliberate, not a failure needing attention. */
function taskOutcome(task: Task): TaskOutcome | null {
  if (task.state === "ABANDONED") return "abandoned";
  const bucket = TASK_WORKFLOW_BUCKETS.get(task.state);
  if (bucket === "done") return "completed";
  if (bucket === "failed") return "failed";
  return null;
}

/**
 * Resolve when each terminal task reached its outcome. `updatedAt` also moves on
 * unrelated writes (project unbinding, push-ref updates), so the latest
 * transition into the current state is preferred when the store provides it.
 */
async function resolveOutcomeTimes(tasks: Task[], store: OverviewRouteStore): Promise<(task: Task) => number> {
  const terminalIds = tasks.filter((task) => taskOutcome(task) !== null).map((task) => task.taskId);
  const entered = store.getCurrentStateEnteredAt && terminalIds.length > 0
    ? await store.getCurrentStateEnteredAt(terminalIds)
    : new Map<TaskId, Date>();
  return (task) => (entered.get(task.taskId) ?? task.updatedAt).getTime();
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

/** Parse an optional trailing-period `?days=<n>` query parameter; omitted or invalid means all-time. */
function parseSinceDays(reqUrl: string | undefined): Date | undefined {
  const daysParam = new URL(reqUrl ?? "/", "http://127.0.0.1").searchParams.get("days");
  if (daysParam === null) return undefined;
  const days = Number(daysParam);
  return Number.isFinite(days) && days > 0
    ? new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    : undefined;
}

/** Count review votes from review-task agent cycles created after `since` (all-time when omitted). */
async function computeReviewVotes(
  tasks: Task[],
  store: OverviewRouteStore,
  since?: Date,
  options?: ReviewVoteOptions,
): Promise<ReviewVoteCounts> {
  const sinceMs = since?.getTime() ?? Number.NEGATIVE_INFINITY;
  const votes = { plus2: 0, plus1: 0, minus1: 0, minus2: 0 };

  const reviewTasks = tasks.filter(
    (t) => t.taskType === "code-review" && (options?.inclusiveSince ? t.updatedAt.getTime() >= sinceMs : t.updatedAt.getTime() > sinceMs)
  );

  if (store.getReviewVoteCounts) {
    const ids = reviewTasks.map((task) => task.taskId);
    return options === undefined ? store.getReviewVoteCounts(ids, since) : store.getReviewVoteCounts(ids, since, options);
  }

  // Compatibility for stores without aggregate support (e.g. admin test doubles).
  for (const task of reviewTasks) {
    try {
      const cycles = await store.getAgentCycles(task.taskId);
      for (const cycle of cycles) {
        const createdAt = cycle.createdAt.getTime();
        if (options?.inclusiveSince ? createdAt < sinceMs : createdAt <= sinceMs) continue;
        if (options?.before !== undefined && createdAt >= options.before.getTime()) continue;
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

type AnalyticsDimensions = Partial<Record<
  "period" | "windowStart" | "windowEnd" | "projectId" | "projectName" |
  "modelId" | "workflowBucket" | "taskState" | "coverage", string
>>;

function analyticsCsv(
  tasks: Task[], currentTasks: Task[], outcomeTime: (task: Task) => number, cost: CostSummary, models: ModelUsageSummary, votes: ReviewVoteCounts,
  now: number, since: Date | undefined, period: string,
  options: ReviewVoteOptions & { selectedProjects?: boolean } = {},
): string {
  const generatedAt = new Date(now).toISOString();
  const end = options.before?.getTime() ?? now;
  const windowEnd = new Date(end).toISOString();
  const totalScope = options.selectedProjects ? "selected_projects" : "instance";
  const rows: string[][] = [[
    "section", "scope", "period", "generated_at_utc", "window_start_utc", "window_end_utc",
    "project_id", "project_name", "model_id", "workflow_bucket", "task_state", "metric", "value", "unit", "coverage",
  ]];
  function add(
    section: string, scope: string, metric: string, value: number | null,
    unit = "count", dimensions: AnalyticsDimensions = {},
  ): void {
    const current = dimensions.period === "current";
    rows.push([
      section, scope, dimensions.period ?? period, generatedAt,
      current ? "" : dimensions.windowStart ?? since?.toISOString() ?? "",
      current ? "" : dimensions.windowEnd ?? windowEnd,
      dimensions.projectId ?? "", dimensions.projectName ?? "", dimensions.modelId ?? "",
      dimensions.workflowBucket ?? "", dimensions.taskState ?? "", metric,
      value === null ? "" : String(value), unit, dimensions.coverage ?? "",
    ]);
  }
  function usage(
    section: string, scope: string, runs: number, measured: number,
    tokens: CycleCostTokens, usd: number, dimensions: AnalyticsDimensions = {},
  ): void {
    add(section, scope, "runs", runs, "count", dimensions);
    add(section, scope, "runs_with_tokens", measured, "count", dimensions);
    add(section, scope, "usd", usd, "USD", dimensions);
    const coverage = measured === 0 ? "unreported" : measured < runs ? "partial" : "reported";
    const metrics = {
      input_tokens: tokens.input, output_tokens: tokens.output,
      cache_read_tokens: tokens.cached, cache_write_tokens: tokens.cacheWrite,
      processed_tokens: tokens.input + tokens.cached + tokens.cacheWrite + tokens.output,
    };
    for (const [metric, value] of Object.entries(metrics)) {
      add(section, scope, metric, measured === 0 ? null : value, "tokens", { ...dimensions, coverage });
    }
  }

  const inWindow = (time: number): boolean => {
    const afterStart = options.inclusiveSince ? time >= (since?.getTime() ?? -Infinity) : time > (since?.getTime() ?? -Infinity);
    const beforeEnd = options.before === undefined ? time <= end : time < end;
    return afterStart && beforeEnd;
  };
  for (const bucket of ["active", "watching"] as const) {
    add("task_summary", totalScope, bucket,
      currentTasks.filter((task) => TASK_WORKFLOW_BUCKETS.get(task.state) === bucket).length, "tasks", { period: "current" });
  }
  for (const outcome of ["completed", "failed", "abandoned"] as const) {
    add("task_summary", totalScope, outcome,
      currentTasks.filter((task) => taskOutcome(task) === outcome && inWindow(outcomeTime(task))).length, "tasks");
  }
  const distribution: Record<string, readonly Task["state"][]> = {
    running: ["AGENT_RUNNING", "FEEDBACK_PROCESSING", "CLOSING", "REVIEW_RUNNING", "REVIEW_COMMENTING"],
    watching: ["IN_REVIEW", "REVIEW_WATCHING"], completed: ["MERGED", "DONE", "REVIEW_DONE"],
    queued: ["DETECTED", "CONTEXT_BUILDING", "RETRY_CYCLE", "REVIEW_PENDING"],
    failed: ["FAILED", "REVIEW_FAILED"], abandoned: ["ABANDONED"],
  };
  add("task_distribution", totalScope, "total", currentTasks.length, "tasks", { period: "current" });
  for (const [category, states] of Object.entries(distribution)) {
    add("task_distribution", "category", category,
      currentTasks.filter((task) => states.includes(task.state)).length, "tasks", { period: "current" });
    for (const state of states) {
      add("task_distribution", "state", "tasks", currentTasks.filter((task) => task.state === state).length,
        "tasks", { period: "current", taskState: state });
    }
  }

  const updates = tasks.map((task) => task.updatedAt.getTime())
    .filter((updatedAt) => (options.before === undefined ? updatedAt <= end : updatedAt < end) && updatedAt >= (since?.getTime() ?? -Infinity));
  add("throughput", totalScope, "updated_tasks", updates.length, "tasks");
  if (since !== undefined || updates.length > 0) {
    const start = since?.getTime() ?? updates.reduce((earliest, updatedAt) => Math.min(earliest, updatedAt), end - 1000);
    for (let index = 0; index < NUM_TICKS; index++) {
      const windowStart = start + Math.floor(index * (end - start) / NUM_TICKS);
      const windowEnd = start + Math.floor((index + 1) * (end - start) / NUM_TICKS);
      const count = updates.filter((updatedAt) => updatedAt >= windowStart &&
        (updatedAt < windowEnd || (index === NUM_TICKS - 1 && updatedAt === windowEnd))).length;
      add("throughput", "bin", "updated_tasks", count, "tasks", {
        windowStart: new Date(windowStart).toISOString(),
        windowEnd: new Date(windowEnd).toISOString(),
      });
    }
  }
  for (const score of ["plus2", "plus1", "minus1", "minus2"] as const) {
    add("review_votes", totalScope, score, votes[score], "votes");
  }

  usage("ai_cost", totalScope, cost.totalRuns, cost.totalRunsWithTokens, cost.totalTokens, cost.totalUsd);
  add("ai_cost", totalScope, "ai_credits", cost.totalAiCredits, "credits");
  add("ai_cost", totalScope, "premium_requests", cost.totalPremiumRequests, "requests");
  for (const project of cost.perProject) {
    const dimensions = { projectId: project.projectId ?? "", projectName: project.projectName ?? "", workflowBucket: project.workflowBucket };
    usage("ai_cost", "project", project.runCount, project.runCountWithTokens, project.tokens, project.usd, dimensions);
    add("ai_cost", "project", "ai_credits", project.aiCredits, "credits", dimensions);
    add("ai_cost", "project", "premium_requests", project.premiumRequests, "requests", dimensions);
  }

  const visibleModels = models.byModel.filter((model) => model.workflowBucket !== "failed");
  const modelRuns = visibleModels.reduce((total, model) => total + model.runCount, 0);
  usage("model_usage", totalScope, modelRuns,
    visibleModels.reduce((total, model) => total + model.runCountWithTokens, 0), sumTokens(visibleModels),
    visibleModels.reduce((total, model) => total + model.usd, 0));
  function modelRows(entries: ModelUsageEntry[], scope: string, dimensions: AnalyticsDimensions): void {
    const visible = entries.filter((model) => model.workflowBucket !== "failed");
    const runs = visible.reduce((total, model) => total + model.runCount, 0);
    for (const model of visible) {
      const modelDimensions = { ...dimensions, modelId: model.modelId ?? "", workflowBucket: model.workflowBucket };
      usage("model_usage", scope, model.runCount, model.runCountWithTokens, model.tokens, model.usd, modelDimensions);
      add("model_usage", scope, "run_percentage", runs === 0 ? 0 : model.runCount / runs * 100, "percent", modelDimensions);
    }
  }
  modelRows(visibleModels, "model", {});
  for (const project of models.perProject.filter((project) => project.workflowBucket !== "failed")) {
    modelRows(project.models, "project_model", { projectId: project.projectId ?? "", projectName: project.projectName ?? "" });
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function registerOverviewRoutes(router: Router, deps: OverviewRouteDeps): void {
  router.add("GET", "/api/admin/overview/export.csv", async (req, res) => {
    if (getAuthContext(req)?.role !== "admin") {
      writeJson(res, 403, { error: "forbidden" });
      return;
    }
    const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
    const values = query.getAll("days");
    const days = values[0];
    if (values.length > 1 || (days !== undefined && days !== "1" && days !== "7" && days !== "30")) {
      writeJson(res, 400, { error: "days must be 1, 7, or 30; omit it for all time" });
      return;
    }
    const from = query.get("from");
    const to = query.get("to");
    const custom = from !== null || to !== null;
    const startDate = from === null ? null : parseCalendarDate(from, false);
    const endDate = to === null ? null : parseCalendarDate(to, true);
    if (query.getAll("from").length > 1 || query.getAll("to").length > 1 ||
        (custom && (days !== undefined || startDate === null || endDate === null || startDate >= endDate))) {
      writeJson(res, 400, { error: "Use valid from/to calendar dates in order, without days" });
      return;
    }
    const rawIds = query.getAll("projectId");
    if (rawIds.length > 100 || rawIds.some((id) => id.trim().length === 0)) {
      writeJson(res, 400, { error: "Select between 1 and 100 valid projects, or omit projectId for all projects" });
      return;
    }
    const projectIds = rawIds.length === 0 ? undefined : [...new Set(rawIds)].map(makeProjectId);
    try {
      if (projectIds !== undefined) {
        if (!deps.projectStore) {
          writeJson(res, 501, { error: "Project store not available" });
          return;
        }
        const known = new Set((await deps.projectStore.listProjects()).map((project) => project.id));
        if (projectIds.some((id) => !known.has(id))) {
          writeJson(res, 400, { error: "Unknown project selected" });
          return;
        }
      }
      const now = Date.now();
      const since = startDate ?? (days === undefined ? undefined : new Date(now - Number(days) * 86_400_000));
      const before = endDate ?? undefined;
      const period = custom ? "custom" : days === undefined ? "all" : days === "1" ? "24h" : `${days}d`;
      const aggregateOptions: CycleSummaryOptions = {
        ...(since === undefined ? {} : { since }), ...(before === undefined ? {} : { before }),
        ...(projectIds === undefined ? {} : { projectIds }),
      };
      const options = Object.keys(aggregateOptions).length === 0 ? undefined : aggregateOptions;
      const [allTasks, cost, models] = await Promise.all([
        deps.stateStore.getAllTasks(),
        deps.stateStore.getCostSummary(options),
        deps.stateStore.getModelUsageSummary(options),
      ]);
      const selected = projectIds === undefined ? undefined : new Set(projectIds);
      const tasks = selected === undefined ? allTasks : allTasks.filter((task) => task.projectId != null && selected.has(task.projectId));
      const voteOptions = custom ? { before, inclusiveSince: true } : undefined;
      const votes = await computeReviewVotes(tasks, deps.stateStore, since, voteOptions);
      const currentTasks = deduplicateByTicket(tasks);
      const outcomeTime = await resolveOutcomeTimes(currentTasks, deps.stateStore);
      const csv = analyticsCsv(tasks, currentTasks, outcomeTime, cost, models, votes, now, since, period, { ...voteOptions, selectedProjects: selected !== undefined });
      const suffix = custom ? `${from}_${to}` : period;
      res.statusCode = 200;
      res.setHeader("content-type", "text/csv; charset=utf-8");
      res.setHeader("content-disposition", `attachment; filename="general-view-analytics-${suffix}.csv"`);
      res.setHeader("cache-control", "no-store");
      res.end(csv);
    } catch (err: unknown) {
      log.error({ err }, "analytics export failed");
      writeJson(res, 500, { error: "Failed to export analytics" });
    }
  }, { permission: "overview.read" });

  router.add("GET", "/api/admin/overview", async (req, res, _params) => {
    try {
      const allTasks = await deps.stateStore.getAllTasks();
      const tasks = deps.projectStore
        ? await filterTasksByReadAccess(req, allTasks, deps.projectStore)
        : allTasks;
      // Counters follow the task list: one row per ticket/change, so a superseded
      // FAILED attempt is not reported once a newer attempt exists.
      const currentTasks = deps.projectStore
        ? await filterTasksByReadAccess(req, deduplicateByTicket(allTasks), deps.projectStore)
        : deduplicateByTicket(allTasks);
      const outcomeTime = await resolveOutcomeTimes(currentTasks, deps.stateStore);
      const now = Date.now();
      const sevenDaysAgo = now - SEVEN_DAYS_MS;
      const recentOutcome = (outcome: TaskOutcome): number => currentTasks
        .filter((t) => taskOutcome(t) === outcome && outcomeTime(t) > sevenDaysAgo).length;

      const stats = {
        activeTasks:      currentTasks.filter((t) => TASK_WORKFLOW_BUCKETS.get(t.state) === "active").length,
        watchingTasks:    currentTasks.filter((t) => TASK_WORKFLOW_BUCKETS.get(t.state) === "watching").length,
        completedLast7d:  recentOutcome("completed"),
        failedLast7d:     recentOutcome("failed"),
        abandonedLast7d:  recentOutcome("abandoned"),
        activeProviders:  0, // populated separately via /api/admin/providers
      };

      const throughput = computeThroughput(tasks, deps.pollingIntervalMs);
      const reviewVotes = await computeReviewVotes(tasks, deps.stateStore, new Date(sevenDaysAgo));

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

  // Review vote breakdown over the caller's readable tasks, optionally scoped
  // to a trailing period via `?days=<n>` (omitted = all-time).
  router.add("GET", "/api/admin/review-votes", async (req, res, _params) => {
    try {
      const allTasks = await deps.stateStore.getAllTasks();
      const tasks = deps.projectStore
        ? await filterTasksByReadAccess(req, allTasks, deps.projectStore)
        : allTasks;
      writeJson(res, 200, await computeReviewVotes(tasks, deps.stateStore, parseSinceDays(req.url)));
    } catch (err) {
      log.error({ err }, "review-votes route failed");
      writeJson(res, 500, { error: "Failed to compute review votes" });
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
