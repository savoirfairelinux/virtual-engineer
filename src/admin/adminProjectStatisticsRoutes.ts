import { getLogger } from "../logger.js";
import { makeProjectId, type ProjectId, type ProjectRecord, type StateStore } from "../interfaces.js";
import { getAuthContext } from "./authContext.js";
import { requireStore, writeJson } from "./adminRouteUtils.js";
import type { Router } from "./router.js";

const log = getLogger("admin-project-statistics");

interface ProjectStatisticsStateStore {
  getProjectStatistics?(
    this: void,
    projectId: ProjectId,
    options?: { since?: Date; liveConcurrency?: number | null },
  ): ReturnType<StateStore["getProjectStatistics"]>;
}

export interface ProjectStatisticsRouteDeps {
  stateStore?: ProjectStatisticsStateStore | undefined;
  projectStore?: { getProjectById(id: ProjectId): Promise<ProjectRecord | null> } | undefined;
  concurrency?: {
    snapshot(): { perProject: Record<string, number> };
  } | undefined;
}

function periodFromRequest(req: import("node:http").IncomingMessage): Date | undefined {
  const daysParam = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("days");
  if (daysParam === null) return undefined;
  const days = Number(daysParam);
  if (days !== 1 && days !== 7 && days !== 30) return undefined;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export function registerProjectStatisticsRoutes(
  router: Router,
  deps: ProjectStatisticsRouteDeps,
): void {
  router.add("GET", "/api/admin/projects/:id/statistics", async (req, res, params) => {
    if (!requireStore(deps.projectStore, res, "Project store not available")) return;
    const projectId = makeProjectId(params["id"] ?? "");
    const project = await deps.projectStore.getProjectById(projectId);
    if (!project) {
      writeJson(res, 404, { error: "Project not found" });
      return;
    }

    const auth = getAuthContext(req);
    if (!auth || (auth.role !== "admin" && project.ownerUserId !== auth.userId)) {
      writeJson(res, 403, { error: "forbidden", permission: "project.statistics.read" });
      return;
    }
    const getProjectStatistics = deps.stateStore?.getProjectStatistics;
    if (!requireStore(getProjectStatistics, res, "Project statistics store not available")) return;

    try {
      const since = periodFromRequest(req);
      const options: { since?: Date; liveConcurrency?: number | null } = {};
      if (since !== undefined) options.since = since;
      if (deps.concurrency !== undefined) {
        options.liveConcurrency = deps.concurrency.snapshot().perProject[project.id] ?? 0;
      }
      const statistics = await getProjectStatistics(
        project.id,
        Object.keys(options).length > 0 ? options : undefined,
      );
      writeJson(res, 200, statistics);
    } catch (err: unknown) {
      log.error({ err, projectId: project.id }, "project statistics route failed");
      writeJson(res, 500, { error: "Failed to compute project statistics" });
    }
  }, { permission: "project.statistics.read", resourceParam: "id" });
}