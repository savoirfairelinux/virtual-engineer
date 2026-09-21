import type Database from "better-sqlite3";
import {
  TASK_STATES,
  TASK_WORKFLOW_BUCKETS,
  TERMINAL_STATES,
  type TaskState,
  type TaskWorkflowBucket,
} from "../../domain/tasks.js";
import type {
  ProjectId,
  ProjectStatistics,
  ProjectStatisticsBucketCounts,
  ProjectStatisticsCostBucket,
  ProjectStatisticsCurrent,
  ProjectStatisticsExecution,
  ProjectStatisticsPeriod,
  ProjectStatisticsTiming,
  ProjectStatisticsValidation,
  ValidationStatus,
} from "../../interfaces.js";
import type { CostStoreApi } from "./costStore.js";

export interface ProjectStatisticsStoreApi {
  getProjectStatistics(
    projectId: ProjectId,
    options?: { since?: Date; liveConcurrency?: number | null },
  ): Promise<ProjectStatistics>;
}

interface ProjectStatisticsStoreContext {
  raw: Database.Database;
  costStore: CostStoreApi;
}

interface TaskStateRow {
  taskId: string;
  state: string;
}

interface TerminalTransitionRow {
  taskId: string;
  toState: string;
  createdAt: number;
}

interface CycleRow {
  taskId: string;
  cycleNumber: number;
  validationResult: string | null;
}

interface TimingRow {
  createdAt: number;
  terminalAt: number;
}

const TERMINAL_STATE_SQL = [...TERMINAL_STATES].map((state) => `'${state}'`).join(", ");

function createBucketCounts(): ProjectStatisticsBucketCounts {
  return { active: 0, watching: 0, done: 0, failed: 0 };
}

function createStateCounts(): Record<TaskState, number> {
  return Object.fromEntries(TASK_STATES.map((state) => [state, 0])) as Record<TaskState, number>;
}

function bucketForState(state: string): TaskWorkflowBucket {
  const bucket = TASK_WORKFLOW_BUCKETS.get(state as TaskState);
  if (!bucket) throw new Error(`Unclassified task state in project statistics: ${state}`);
  return bucket;
}

function stateForRow(state: string): TaskState {
  if (!TASK_WORKFLOW_BUCKETS.has(state as TaskState)) {
    throw new Error(`Unknown task state in project statistics: ${state}`);
  }
  return state as TaskState;
}

function parseValidationStatus(value: string | null): ValidationStatus | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const status = (parsed as { status?: unknown }).status;
    return status === "passed" || status === "failed" || status === "skipped" ? status : null;
  } catch {
    return null;
  }
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  return lower !== undefined && upper !== undefined ? (lower + upper) / 2 : null;
}

function sinceClause(sinceEpochSeconds: number | null, column: string): {
  sql: string;
  args: number[];
} {
  return sinceEpochSeconds === null
    ? { sql: "", args: [] }
    : { sql: ` AND ${column} >= ?`, args: [sinceEpochSeconds] };
}

function buildCurrent(raw: Database.Database, projectId: ProjectId): ProjectStatisticsCurrent {
  const rows = raw
    .prepare("SELECT task_id AS taskId, state FROM tasks WHERE project_id = ?")
    .all(projectId) as TaskStateRow[];
  const byState = createStateCounts();
  const byBucket = createBucketCounts();
  for (const row of rows) {
    const state = stateForRow(row.state);
    byState[state] += 1;
    byBucket[bucketForState(state)] += 1;
  }
  return { taskCount: rows.length, byState, byBucket };
}

function buildPeriod(
  raw: Database.Database,
  projectId: ProjectId,
  sinceEpochSeconds: number | null,
): ProjectStatisticsPeriod {
  const taskClause = sinceClause(sinceEpochSeconds, "t.created_at");
  const createdRow = raw
    .prepare(`SELECT COUNT(*) AS count FROM tasks t WHERE t.project_id = ?${taskClause.sql}`)
    .get(projectId, ...taskClause.args) as { count: number };
  const terminalClause = sinceClause(sinceEpochSeconds, "st.created_at");
  const transitions = raw
    .prepare(
      `SELECT st.task_id AS taskId, st.to_state AS toState, st.created_at AS createdAt
       FROM state_transitions st
       JOIN tasks t ON t.task_id = st.task_id
       WHERE t.project_id = ? AND st.to_state IN (${TERMINAL_STATE_SQL})${terminalClause.sql}
       ORDER BY st.created_at DESC, st.id DESC`
    )
    .all(projectId, ...terminalClause.args) as TerminalTransitionRow[];

  const latestByTask = new Map<string, TerminalTransitionRow>();
  for (const row of transitions) {
    if (!latestByTask.has(row.taskId)) latestByTask.set(row.taskId, row);
  }
  const terminalByState = createStateCounts();
  const terminalByBucket = createBucketCounts();
  for (const row of latestByTask.values()) {
    const state = stateForRow(row.toState);
    terminalByState[state] += 1;
    terminalByBucket[bucketForState(state)] += 1;
  }
  return {
    tasksCreated: createdRow.count,
    terminalTasks: latestByTask.size,
    terminalByState,
    terminalByBucket,
  };
}

function buildExecution(
  raw: Database.Database,
  projectId: ProjectId,
  sinceEpochSeconds: number | null,
): ProjectStatisticsExecution {
  const cycleClause = sinceClause(sinceEpochSeconds, "c.created_at");
  const cycles = raw
    .prepare(
      `SELECT c.task_id AS taskId, c.cycle_number AS cycleNumber, c.validation_result AS validationResult
       FROM agent_cycles c
       JOIN tasks t ON t.task_id = c.task_id
       WHERE t.project_id = ?${cycleClause.sql}`
    )
    .all(projectId, ...cycleClause.args) as CycleRow[];
  const taskIds = new Set<string>();
  const retryTaskIds = new Set<string>();
  const validation: ProjectStatisticsValidation = { samples: 0, passed: 0, failed: 0, skipped: 0 };
  for (const cycle of cycles) {
    taskIds.add(cycle.taskId);
    if (cycle.cycleNumber > 1) retryTaskIds.add(cycle.taskId);
    const status = parseValidationStatus(cycle.validationResult);
    if (status !== null) {
      validation.samples += 1;
      validation[status] += 1;
    }
  }
  return {
    cycles: cycles.length,
    tasksWithCycles: taskIds.size,
    retryTasks: retryTaskIds.size,
    averageCyclesPerTask: taskIds.size === 0 ? null : cycles.length / taskIds.size,
    validation,
  };
}

function buildTiming(
  raw: Database.Database,
  projectId: ProjectId,
  sinceEpochSeconds: number | null,
): ProjectStatisticsTiming {
  const terminalClause = sinceClause(sinceEpochSeconds, "st.created_at");
  const rows = raw
    .prepare(
      `SELECT t.created_at AS createdAt, MIN(st.created_at) AS terminalAt
       FROM tasks t
       JOIN state_transitions st ON st.task_id = t.task_id
       WHERE t.project_id = ? AND st.to_state IN (${TERMINAL_STATE_SQL})${terminalClause.sql}
       GROUP BY t.task_id, t.created_at`
    )
    .all(projectId, ...terminalClause.args) as TimingRow[];
  const durations = rows
    .map((row) => row.terminalAt - row.createdAt)
    .filter((duration) => Number.isFinite(duration) && duration >= 0);
  if (durations.length === 0) {
    return { samples: 0, averageSeconds: null, medianSeconds: null };
  }
  return {
    samples: durations.length,
    averageSeconds: durations.reduce((sum, duration) => sum + duration, 0) / durations.length,
    medianSeconds: median(durations),
  };
}

export function createProjectStatisticsStore(
  context: ProjectStatisticsStoreContext,
): ProjectStatisticsStoreApi {
  const { raw, costStore } = context;

  async function getProjectStatistics(
    projectId: ProjectId,
    options?: { since?: Date; liveConcurrency?: number | null },
  ): Promise<ProjectStatistics> {
    const sinceEpochSeconds = options?.since === undefined
      ? null
      : Math.floor(options.since.getTime() / 1000);
    const costOptions = options?.since === undefined
      ? { projectId }
      : { since: options.since, projectId };
    const [costSummary, modelSummary] = await Promise.all([
      costStore.getCostSummary(costOptions),
      costStore.getModelUsageSummary(costOptions),
    ]);
    const byBucket: ProjectStatisticsCostBucket[] = costSummary.perProject.map(({ projectId: _projectId, projectName: _projectName, ...bucket }) => bucket);
    return {
      projectId,
      sinceEpochSeconds,
      current: buildCurrent(raw, projectId),
      period: buildPeriod(raw, projectId, sinceEpochSeconds),
      execution: buildExecution(raw, projectId, sinceEpochSeconds),
      cost: {
        totalUsd: costSummary.totalUsd,
        totalAiCredits: costSummary.totalAiCredits,
        totalPremiumRequests: costSummary.totalPremiumRequests,
        totalRuns: costSummary.totalRuns,
        totalTokens: costSummary.totalTokens,
        totalRunsWithTokens: costSummary.totalRunsWithTokens,
        byBucket,
      },
      models: modelSummary.byModel,
      timing: buildTiming(raw, projectId, sinceEpochSeconds),
      liveConcurrency: options?.liveConcurrency === undefined || options.liveConcurrency === null
        ? null
        : { active: Math.max(0, options.liveConcurrency) },
    };
  }

  return { getProjectStatistics };
}