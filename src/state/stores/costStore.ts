import type Database from "better-sqlite3";
import { TASK_WORKFLOW_BUCKETS, type TaskState, type TaskWorkflowBucket } from "../../domain/tasks.js";
import type {
  CostSummary,
  CostSummaryProject,
  CycleCostTokens,
  ModelUsageEntry,
  ModelUsageProject,
  ModelUsageSummary,
} from "../../interfaces.js";

export interface CostStoreApi {
  getCostSummary(options?: { since?: Date }): Promise<CostSummary>;
  getModelUsageSummary(options?: { since?: Date }): Promise<ModelUsageSummary>;
}

interface CostStoreContext {
  raw: Database.Database;
}

/**
 * 1 when a cycle's provider reported token metrics. A cycle with all four
 * columns NULL never reported them (e.g. Cursor), while a reported all-zero
 * event persists four zeroes.
 */
const REPORTED_TOKENS_CASE = `CASE WHEN c.cost_input_tokens IS NOT NULL
                                     OR c.cost_output_tokens IS NOT NULL
                                     OR c.cost_cached_tokens IS NOT NULL
                                     OR c.cost_cache_write_tokens IS NOT NULL
                                THEN 1 ELSE 0 END`;

function workflowBucketForState(state: string): TaskWorkflowBucket {
  const bucket = TASK_WORKFLOW_BUCKETS.get(state as TaskState);
  if (!bucket) throw new Error(`Unclassified task state in cost aggregate: ${state}`);
  return bucket;
}

export function createCostStore(context: CostStoreContext): CostStoreApi {
  const { raw } = context;

  /**
   * Aggregate agent-cycle execution cost across all tasks, broken down per
   * project and totalled instance-wide. Relies solely on the cost_* snapshot
   * columns, which the startup migration (backfillLegacyCycleCosts) backfills
   * for every pre-existing row, so no per-read recompute is needed here.
   */
  function getCostSummary(options?: { since?: Date }): Promise<CostSummary> {
    const sinceEpochSeconds =
      options?.since !== undefined ? Math.floor(options.since.getTime() / 1000) : null;

    interface Bucket {
      projectId: string | null;
      projectName: string | null;
      workflowBucket: TaskWorkflowBucket;
      usd: number;
      aiCredits: number;
      premiumRequests: number;
      runCount: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      cacheWriteTokens: number;
      runCountWithTokens: number;
    }
    const buckets = new Map<string, Bucket>();
    const keyOf = (projectId: string | null, workflowBucket: TaskWorkflowBucket): string =>
      `${projectId ?? "\u0000__unassigned__"}\u0000${workflowBucket}`;
    const bucketFor = (
      projectId: string | null,
      projectName: string | null,
      workflowBucket: TaskWorkflowBucket,
    ): Bucket => {
      const key = keyOf(projectId, workflowBucket);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          projectId,
          projectName,
          workflowBucket,
          usd: 0,
          aiCredits: 0,
          premiumRequests: 0,
          runCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          runCountWithTokens: 0,
        };
        buckets.set(key, bucket);
      } else if (bucket.projectName === null && projectName !== null) {
        bucket.projectName = projectName;
      }
      return bucket;
    };

    const periodClause = sinceEpochSeconds !== null ? "WHERE c.created_at >= ?" : "";
    const periodArgs = sinceEpochSeconds !== null ? [sinceEpochSeconds] : [];

    // SQL aggregation of recorded snapshot costs + run counts per project and workflow bucket.
    const aggregateRows = raw
      .prepare(
        `SELECT t.project_id AS projectId, p.name AS projectName, t.state AS taskState,
                SUM(COALESCE(c.cost_usd, 0)) AS usd,
                SUM(COALESCE(c.cost_ai_credits, 0)) AS aiCredits,
                SUM(COALESCE(c.premium_requests, 0)) AS premiumRequests,
                COUNT(*) AS runCount,
                SUM(COALESCE(c.cost_input_tokens, 0)) AS inputTokens,
                SUM(COALESCE(c.cost_output_tokens, 0)) AS outputTokens,
                SUM(COALESCE(c.cost_cached_tokens, 0)) AS cachedTokens,
                SUM(COALESCE(c.cost_cache_write_tokens, 0)) AS cacheWriteTokens,
                SUM(${REPORTED_TOKENS_CASE}) AS runCountWithTokens
         FROM agent_cycles c
         JOIN tasks t ON t.task_id = c.task_id
         LEFT JOIN projects p ON p.id = t.project_id
         ${periodClause}
         GROUP BY t.project_id, p.name, t.state`
      )
      .all(...periodArgs) as Array<{
        projectId: string | null;
        projectName: string | null;
        taskState: string;
        usd: number;
        aiCredits: number;
        premiumRequests: number;
        runCount: number;
        inputTokens: number;
        outputTokens: number;
        cachedTokens: number;
        cacheWriteTokens: number;
        runCountWithTokens: number;
      }>;
    for (const row of aggregateRows) {
      const bucket = bucketFor(row.projectId, row.projectName, workflowBucketForState(row.taskState));
      bucket.usd += row.usd;
      bucket.aiCredits += row.aiCredits;
      bucket.premiumRequests += row.premiumRequests;
      bucket.runCount += row.runCount;
      bucket.inputTokens += row.inputTokens;
      bucket.outputTokens += row.outputTokens;
      bucket.cachedTokens += row.cachedTokens;
      bucket.cacheWriteTokens += row.cacheWriteTokens;
      bucket.runCountWithTokens += row.runCountWithTokens;
    }

    const perProject: CostSummaryProject[] = [...buckets.values()]
      .map((b) => ({
        projectId: b.projectId,
        projectName: b.projectName,
        workflowBucket: b.workflowBucket,
        usd: b.usd,
        aiCredits: b.aiCredits,
        premiumRequests: b.premiumRequests,
        runCount: b.runCount,
        tokens: {
          input: b.inputTokens,
          output: b.outputTokens,
          cached: b.cachedTokens,
          cacheWrite: b.cacheWriteTokens,
        },
        runCountWithTokens: b.runCountWithTokens,
      }))
      .sort((a, b) => b.usd - a.usd || b.runCount - a.runCount);

    return Promise.resolve({
      totalUsd: perProject.reduce((sum, p) => sum + p.usd, 0),
      totalAiCredits: perProject.reduce((sum, p) => sum + p.aiCredits, 0),
      totalPremiumRequests: perProject.reduce((sum, p) => sum + p.premiumRequests, 0),
      totalRuns: perProject.reduce((sum, p) => sum + p.runCount, 0),
      totalTokens: {
        input: perProject.reduce((sum, p) => sum + p.tokens.input, 0),
        output: perProject.reduce((sum, p) => sum + p.tokens.output, 0),
        cached: perProject.reduce((sum, p) => sum + p.tokens.cached, 0),
        cacheWrite: perProject.reduce((sum, p) => sum + p.tokens.cacheWrite, 0),
      },
      totalRunsWithTokens: perProject.reduce((sum, p) => sum + p.runCountWithTokens, 0),
      perProject,
      sinceEpochSeconds,
    });
  }

  /**
   * Aggregate AI-model usage (run count + USD) across all agent cycles, both
   * globally and per project. Relies solely on cost_model_id/cost_usd, which
   * the startup migration backfills for every pre-existing row.
   */
  function getModelUsageSummary(options?: { since?: Date }): Promise<ModelUsageSummary> {
    const sinceEpochSeconds =
      options?.since !== undefined ? Math.floor(options.since.getTime() / 1000) : null;

    interface ModelAgg {
      modelId: string | null;
      workflowBucket: TaskWorkflowBucket;
      runCount: number;
      usd: number;
      tokens: CycleCostTokens;
      runCountWithTokens: number;
    }
    interface ProjectAgg {
      projectId: string | null;
      projectName: string | null;
      workflowBucket: TaskWorkflowBucket;
      models: Map<string, ModelAgg>;
    }

    const projectKey = (projectId: string | null, workflowBucket: TaskWorkflowBucket): string =>
      `${projectId ?? "\u0000__unassigned__"}\u0000${workflowBucket}`;
    const modelKey = (modelId: string | null, workflowBucket: TaskWorkflowBucket): string =>
      `${modelId ?? "\u0000__unknown__"}\u0000${workflowBucket}`;
    const projects = new Map<string, ProjectAgg>();

    const projectAggFor = (
      projectId: string | null,
      projectName: string | null,
      workflowBucket: TaskWorkflowBucket,
    ): ProjectAgg => {
      const key = projectKey(projectId, workflowBucket);
      let agg = projects.get(key);
      if (!agg) {
        agg = { projectId, projectName, workflowBucket, models: new Map() };
        projects.set(key, agg);
      } else if (agg.projectName === null && projectName !== null) {
        agg.projectName = projectName;
      }
      return agg;
    };
    const addModel = (
      project: ProjectAgg,
      modelId: string | null,
      workflowBucket: TaskWorkflowBucket,
      runCount: number,
      usd: number,
      tokens: CycleCostTokens,
      runCountWithTokens: number
    ): void => {
      const key = modelKey(modelId, workflowBucket);
      const existing = project.models.get(key);
      if (existing) {
        existing.runCount += runCount;
        existing.usd += usd;
        existing.tokens.input += tokens.input;
        existing.tokens.output += tokens.output;
        existing.tokens.cached += tokens.cached;
        existing.tokens.cacheWrite += tokens.cacheWrite;
        existing.runCountWithTokens += runCountWithTokens;
      } else {
        project.models.set(key, {
          modelId,
          workflowBucket,
          runCount,
          usd,
          tokens: { ...tokens },
          runCountWithTokens,
        });
      }
    };

    const periodArgs = sinceEpochSeconds !== null ? [sinceEpochSeconds] : [];

    // SQL aggregation of recorded model snapshots + run counts per project and workflow bucket.
    const aggregateRows = raw
      .prepare(
        `SELECT t.project_id AS projectId, p.name AS projectName, t.state AS taskState,
                c.cost_model_id AS modelId,
                COUNT(*) AS runCount,
                SUM(COALESCE(c.cost_usd, 0)) AS usd,
                SUM(COALESCE(c.cost_input_tokens, 0)) AS inputTokens,
                SUM(COALESCE(c.cost_output_tokens, 0)) AS outputTokens,
                SUM(COALESCE(c.cost_cached_tokens, 0)) AS cachedTokens,
                SUM(COALESCE(c.cost_cache_write_tokens, 0)) AS cacheWriteTokens,
                SUM(${REPORTED_TOKENS_CASE}) AS runCountWithTokens
         FROM agent_cycles c
         JOIN tasks t ON t.task_id = c.task_id
         LEFT JOIN projects p ON p.id = t.project_id
         ${sinceEpochSeconds !== null ? "WHERE c.created_at >= ?" : ""}
         GROUP BY t.project_id, p.name, t.state, c.cost_model_id`
      )
      .all(...periodArgs) as Array<{
        projectId: string | null;
        projectName: string | null;
        taskState: string;
        modelId: string | null;
        runCount: number;
        usd: number;
        inputTokens: number;
        outputTokens: number;
        cachedTokens: number;
        cacheWriteTokens: number;
        runCountWithTokens: number;
      }>;
    for (const row of aggregateRows) {
      const workflowBucket = workflowBucketForState(row.taskState);
      const project = projectAggFor(row.projectId, row.projectName, workflowBucket);
      addModel(
        project,
        row.modelId,
        workflowBucket,
        row.runCount,
        row.usd,
        {
          input: row.inputTokens,
          output: row.outputTokens,
          cached: row.cachedTokens,
          cacheWrite: row.cacheWriteTokens,
        },
        row.runCountWithTokens
      );
    }

    // Build per-project view + fold into the global distribution.
    const globalModels = new Map<string, ModelAgg & { modelId: string | null }>();
    const perProject: ModelUsageProject[] = [];
    for (const project of projects.values()) {
      const models: ModelUsageEntry[] = [];
      for (const [key, agg] of project.models) {
        models.push({
          modelId: agg.modelId,
          workflowBucket: agg.workflowBucket,
          runCount: agg.runCount,
          usd: agg.usd,
          tokens: { ...agg.tokens },
          runCountWithTokens: agg.runCountWithTokens,
        });
        const g = globalModels.get(key);
        if (g) {
          g.runCount += agg.runCount;
          g.usd += agg.usd;
          g.tokens.input += agg.tokens.input;
          g.tokens.output += agg.tokens.output;
          g.tokens.cached += agg.tokens.cached;
          g.tokens.cacheWrite += agg.tokens.cacheWrite;
          g.runCountWithTokens += agg.runCountWithTokens;
        } else {
          globalModels.set(key, {
            modelId: agg.modelId,
            workflowBucket: agg.workflowBucket,
            runCount: agg.runCount,
            usd: agg.usd,
            tokens: { ...agg.tokens },
            runCountWithTokens: agg.runCountWithTokens,
          });
        }
      }
      models.sort((a, b) => b.runCount - a.runCount || b.usd - a.usd);
      perProject.push({
        projectId: project.projectId,
        projectName: project.projectName,
        workflowBucket: project.workflowBucket,
        models,
      });
    }

    const byModel: ModelUsageEntry[] = [...globalModels.values()]
      .map((m) => ({
        modelId: m.modelId,
        workflowBucket: m.workflowBucket,
        runCount: m.runCount,
        usd: m.usd,
        tokens: { ...m.tokens },
        runCountWithTokens: m.runCountWithTokens,
      }))
      .sort((a, b) => b.runCount - a.runCount || b.usd - a.usd);

    perProject.sort(
      (a, b) =>
        b.models.reduce((s, m) => s + m.runCount, 0) - a.models.reduce((s, m) => s + m.runCount, 0)
    );

    return Promise.resolve({
      byModel,
      perProject,
      totalRuns: byModel.reduce((s, m) => s + m.runCount, 0),
      totalUsd: byModel.reduce((s, m) => s + m.usd, 0),
      totalTokens: {
        input: byModel.reduce((s, m) => s + m.tokens.input, 0),
        output: byModel.reduce((s, m) => s + m.tokens.output, 0),
        cached: byModel.reduce((s, m) => s + m.tokens.cached, 0),
        cacheWrite: byModel.reduce((s, m) => s + m.tokens.cacheWrite, 0),
      },
      sinceEpochSeconds,
    });
  }

  return { getCostSummary, getModelUsageSummary };
}
