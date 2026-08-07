import { writeJson, requireStore } from "./adminRouteUtils.js";
import type { Router } from "./router.js";

export interface ConcurrencyRouteDeps {
  concurrency?: {
    /** Live in-memory run-slot counters keyed by integration id. */
    snapshot(): { global: number; perProject: Record<string, number>; perAgent: Record<string, number> };
  } | undefined;
}

/** Register concurrency routes on the given router. */
export function registerConcurrencyRoutes(router: Router, deps: ConcurrencyRouteDeps): void {
  router.add("GET", "/api/admin/concurrency", (_req, res, _params) => {
    if (!requireStore(deps.concurrency, res, "Concurrency tracker not available")) return Promise.resolve();
    writeJson(res, 200, { snapshot: deps.concurrency.snapshot() });
    return Promise.resolve();
  }, { permission: "concurrency.read" });
}
