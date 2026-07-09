import { writeJson } from "./adminRouteUtils.js";
import type { Router } from "./router.js";
import type { DenialStoreApi } from "../state/stores/denialStore.js";

export interface DenialRouteDeps {
  denialStore?: DenialStoreApi | undefined;
}

/** Register policy-denial audit-log routes. */
export function registerDenialRoutes(router: Router, deps: DenialRouteDeps): void {
  router.add("GET", "/api/admin/runtime/denials", async (req, res) => {
    if (!deps.denialStore) {
      writeJson(res, 501, { error: "Denial store not available" });
      return;
    }
    const url = new URL(req.url ?? "", "http://localhost");
    const taskId = url.searchParams.get("taskId") ?? undefined;
    const projectId = url.searchParams.get("projectId") ?? undefined;
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw && Number.isFinite(Number(limitRaw)) ? Math.min(Math.max(Number(limitRaw), 1), 500) : undefined;
    const denials = await deps.denialStore.listPolicyDenials({
      ...(taskId ? { taskId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(limit ? { limit } : {}),
    });
    writeJson(res, 200, { denials });
  });
}
