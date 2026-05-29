import { writeJson } from "./adminRouteUtils.js";
import type { Router } from "./router.js";

export interface ConcurrencyRouteDeps {
  concurrency?: {
    /** Live in-memory run-slot counters keyed by integration id. */
    snapshot(): { global: number; perProject: Record<string, number>; perAgent: Record<string, number> };
  } | undefined;
}

/** Register concurrency routes on the given router. */
export function registerConcurrencyRoutes(router: Router, deps: ConcurrencyRouteDeps): void {
  router.add("GET", "/api/admin/concurrency", async (_req, res, _params) => {
    if (!deps.concurrency) {
      writeJson(res, 501, { error: "Concurrency tracker not available" });
      return;
    }
    writeJson(res, 200, { snapshot: deps.concurrency.snapshot() });
  });
}
