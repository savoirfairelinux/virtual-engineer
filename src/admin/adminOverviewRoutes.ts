import { statSync } from "node:fs";
import { getLogger } from "../logger.js";
import { writeJson } from "./adminRouteUtils.js";
import type { Router } from "./router.js";
import type { Task, AgentCycle } from "../interfaces.js";
import { makeTaskId } from "../interfaces.js";
import type { AdminRuntimeConfig } from "./adminServer.js";

const log = getLogger("admin-overview");

export interface OverviewRouteStore {
  getAllTasks(): Promise<Task[]>;
  getAgentCycles(taskId: ReturnType<typeof makeTaskId>): Promise<AgentCycle[]>;
}

export interface OverviewRouteDeps {
  stateStore: OverviewRouteStore;
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

const ACTIVE_STATES = new Set([
  "AGENT_RUNNING", "CONTEXT_BUILDING", "FEEDBACK_PROCESSING",
  "RETRY_CYCLE", "REVIEW_RUNNING", "REVIEW_COMMENTING", "CLOSING",
]);

const WATCHING_STATES = new Set(["REVIEW_WATCHING", "IN_REVIEW", "REVIEW_PENDING"]);
const DONE_STATES = new Set(["DONE", "MERGED", "REVIEW_DONE"]);
const FAILED_STATES = new Set(["FAILED", "REVIEW_FAILED"]);

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const NUM_TICKS = 14;

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
  router.add("GET", "/api/admin/overview", async (_req, res, _params) => {
    try {
      const [tasks] = await Promise.all([deps.stateStore.getAllTasks()]);
      const now = Date.now();
      const sevenDaysAgo = now - SEVEN_DAYS_MS;

      const stats = {
        activeTasks:      tasks.filter((t) => ACTIVE_STATES.has(t.state)).length,
        watchingTasks:    tasks.filter((t) => WATCHING_STATES.has(t.state)).length,
        completedLast7d:  tasks.filter((t) => DONE_STATES.has(t.state) && t.updatedAt.getTime() > sevenDaysAgo).length,
        failedLast7d:     tasks.filter((t) => FAILED_STATES.has(t.state) && t.updatedAt.getTime() > sevenDaysAgo).length,
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
  });
}
