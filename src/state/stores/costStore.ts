import type Database from "better-sqlite3";
import type {
  CostSummary,
  CostSummaryProject,
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

export function createCostStore(context: CostStoreContext): CostStoreApi {
  const { raw } = context;

  /**
   * Aggregate agent-cycle execution cost across all tasks, broken down per
   * project and totalled instance-wide. Relies solely on the cost_* snapshot
   * columns, which the startup migration (backfillLegacyCycleCosts) backfills
   * for every pre-existing row, so no per-read recompute is needed here.
   */
  async function getCostSummary(options?: { since?: Date }): Promise<CostSummary> {
    const sinceEpochSeconds =
      options?.since !== undefined ? Math.floor(options.since.getTime() / 1000) : null;

    interface Bucket {
      projectId: string | null;
      projectName: string | null;
      usd: number;
      aiCredits: number;
      premiumRequests: number;
      runCount: number;
    }
    const buckets = new Map<string, Bucket>();
    const keyOf = (projectId: string | null): string => projectId ?? "\u0000__unassigned__";
    const bucketFor = (projectId: string | null, projectName: string | null): Bucket => {
      const key = keyOf(projectId);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { projectId, projectName, usd: 0, aiCredits: 0, premiumRequests: 0, runCount: 0 };
        buckets.set(key, bucket);
      } else if (bucket.projectName === null && projectName !== null) {
        bucket.projectName = projectName;
      }
      return bucket;
    };

    const periodClause = sinceEpochSeconds !== null ? "WHERE c.created_at >= ?" : "";
    const periodArgs = sinceEpochSeconds !== null ? [sinceEpochSeconds] : [];

    // SQL aggregation of recorded snapshot costs + run counts per project.
    const aggregateRows = raw
      .prepare(
        `SELECT t.project_id AS projectId, p.name AS projectName,
                SUM(COALESCE(c.cost_usd, 0)) AS usd,
                SUM(COALESCE(c.cost_ai_credits, 0)) AS aiCredits,
                SUM(COALESCE(c.premium_requests, 0)) AS premiumRequests,
                COUNT(*) AS runCount
         FROM agent_cycles c
         JOIN tasks t ON t.task_id = c.task_id
         LEFT JOIN projects p ON p.id = t.project_id
         ${periodClause}
         GROUP BY t.project_id, p.name`
      )
      .all(...periodArgs) as Array<{
        projectId: string | null;
        projectName: string | null;
        usd: number;
        aiCredits: number;
        premiumRequests: number;
        runCount: number;
      }>;
    for (const row of aggregateRows) {
      const bucket = bucketFor(row.projectId, row.projectName);
      bucket.usd += row.usd;
      bucket.aiCredits += row.aiCredits;
      bucket.premiumRequests += row.premiumRequests;
      bucket.runCount += row.runCount;
    }

    const perProject: CostSummaryProject[] = [...buckets.values()]
      .map((b) => ({
        projectId: b.projectId,
        projectName: b.projectName,
        usd: b.usd,
        aiCredits: b.aiCredits,
        premiumRequests: b.premiumRequests,
        runCount: b.runCount,
      }))
      .sort((a, b) => b.usd - a.usd || b.runCount - a.runCount);

    return {
      totalUsd: perProject.reduce((sum, p) => sum + p.usd, 0),
      totalAiCredits: perProject.reduce((sum, p) => sum + p.aiCredits, 0),
      totalPremiumRequests: perProject.reduce((sum, p) => sum + p.premiumRequests, 0),
      totalRuns: perProject.reduce((sum, p) => sum + p.runCount, 0),
      perProject,
      sinceEpochSeconds,
    };
  }

  /**
   * Aggregate AI-model usage (run count + USD) across all agent cycles, both
   * globally and per project. Relies solely on cost_model_id/cost_usd, which
   * the startup migration backfills for every pre-existing row.
   */
  async function getModelUsageSummary(options?: { since?: Date }): Promise<ModelUsageSummary> {
    const sinceEpochSeconds =
      options?.since !== undefined ? Math.floor(options.since.getTime() / 1000) : null;

    interface ModelAgg { runCount: number; usd: number }
    interface ProjectAgg { projectId: string | null; projectName: string | null; models: Map<string, ModelAgg> }

    const projectKey = (projectId: string | null): string => projectId ?? "\u0000__unassigned__";
    const modelKey = (modelId: string | null): string => modelId ?? "\u0000__unknown__";
    const projects = new Map<string, ProjectAgg>();

    const projectAggFor = (projectId: string | null, projectName: string | null): ProjectAgg => {
      const key = projectKey(projectId);
      let agg = projects.get(key);
      if (!agg) {
        agg = { projectId, projectName, models: new Map() };
        projects.set(key, agg);
      } else if (agg.projectName === null && projectName !== null) {
        agg.projectName = projectName;
      }
      return agg;
    };
    const addModel = (
      project: ProjectAgg,
      modelId: string | null,
      runCount: number,
      usd: number
    ): void => {
      const key = modelKey(modelId);
      const existing = project.models.get(key);
      if (existing) {
        existing.runCount += runCount;
        existing.usd += usd;
      } else {
        project.models.set(key, { runCount, usd });
      }
    };

    const periodArgs = sinceEpochSeconds !== null ? [sinceEpochSeconds] : [];

    // SQL aggregation of recorded model snapshots + run counts per project.
    const aggregateRows = raw
      .prepare(
        `SELECT t.project_id AS projectId, p.name AS projectName,
                c.cost_model_id AS modelId,
                COUNT(*) AS runCount,
                SUM(COALESCE(c.cost_usd, 0)) AS usd
         FROM agent_cycles c
         JOIN tasks t ON t.task_id = c.task_id
         LEFT JOIN projects p ON p.id = t.project_id
         ${sinceEpochSeconds !== null ? "WHERE c.created_at >= ?" : ""}
         GROUP BY t.project_id, p.name, c.cost_model_id`
      )
      .all(...periodArgs) as Array<{
        projectId: string | null;
        projectName: string | null;
        modelId: string | null;
        runCount: number;
        usd: number;
      }>;
    for (const row of aggregateRows) {
      const project = projectAggFor(row.projectId, row.projectName);
      addModel(project, row.modelId, row.runCount, row.usd);
    }

    // Build per-project view + fold into the global distribution.
    const globalModels = new Map<string, ModelAgg & { modelId: string | null }>();
    const perProject: ModelUsageProject[] = [];
    for (const project of projects.values()) {
      const models: ModelUsageEntry[] = [];
      for (const [key, agg] of project.models) {
        const modelId = key === "\u0000__unknown__" ? null : key;
        models.push({ modelId, runCount: agg.runCount, usd: agg.usd });
        const g = globalModels.get(key);
        if (g) {
          g.runCount += agg.runCount;
          g.usd += agg.usd;
        } else {
          globalModels.set(key, { modelId, runCount: agg.runCount, usd: agg.usd });
        }
      }
      models.sort((a, b) => b.runCount - a.runCount || b.usd - a.usd);
      perProject.push({ projectId: project.projectId, projectName: project.projectName, models });
    }

    const byModel: ModelUsageEntry[] = [...globalModels.values()]
      .map((m) => ({ modelId: m.modelId, runCount: m.runCount, usd: m.usd }))
      .sort((a, b) => b.runCount - a.runCount || b.usd - a.usd);

    perProject.sort(
      (a, b) =>
        b.models.reduce((s, m) => s + m.runCount, 0) - a.models.reduce((s, m) => s + m.runCount, 0)
    );

    return {
      byModel,
      perProject,
      totalRuns: byModel.reduce((s, m) => s + m.runCount, 0),
      totalUsd: byModel.reduce((s, m) => s + m.usd, 0),
      sinceEpochSeconds,
    };
  }

  return { getCostSummary, getModelUsageSummary };
}
