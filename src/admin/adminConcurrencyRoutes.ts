import { writeJson, requireStore } from "./adminRouteUtils.js";
import type { AgentRecord, ProjectRecord } from "../interfaces.js";
import { requestCanAccessResource } from "./authContext.js";
import type { Router } from "./router.js";

export interface ConcurrencyRouteDeps {
  concurrency?: {
    /** Live in-memory run-slot counters keyed by integration id. */
    snapshot(): { global: number; perProject: Record<string, number>; perAgent: Record<string, number> };
  } | undefined;
  projectStore?: { listProjects(): Promise<ProjectRecord[]> } | undefined;
  agentStore?: { listAgents(): Promise<AgentRecord[]> } | undefined;
}

/** Register concurrency routes on the given router. */
export function registerConcurrencyRoutes(router: Router, deps: ConcurrencyRouteDeps): void {
  router.add("GET", "/api/admin/concurrency", async (req, res, _params) => {
    if (!requireStore(deps.concurrency, res, "Concurrency tracker not available")) return Promise.resolve();
    const snapshot = deps.concurrency.snapshot();
    if (!deps.projectStore || !deps.agentStore) {
      writeJson(res, 200, { snapshot });
      return;
    }
    const [projects, agents] = await Promise.all([
      deps.projectStore.listProjects(),
      deps.agentStore.listAgents(),
    ]);
    const readableProjectIds = new Set<string>(projects
      .filter((project) => requestCanAccessResource(req, "project.read", {
        type: "project",
        id: project.id,
        ownerUserId: project.ownerUserId ?? null,
      }))
      .map((project) => project.id));
    const readableAgentIds = new Set<string>(agents
      .filter((agent) => requestCanAccessResource(req, "agent.read", {
        type: "agent",
        id: agent.id,
        ownerUserId: agent.ownerUserId ?? null,
      }))
      .map((agent) => agent.id));
    const perProject = Object.fromEntries(
      Object.entries(snapshot.perProject).filter(([id]) => readableProjectIds.has(id))
    );
    const perAgent = Object.fromEntries(
      Object.entries(snapshot.perAgent).filter(([id]) => readableAgentIds.has(id))
    );
    writeJson(res, 200, {
      snapshot: {
        global: Object.values(perProject).reduce((total, count) => total + count, 0),
        perProject,
        perAgent,
      },
    });
  }, { permission: "concurrency.read" });
}
