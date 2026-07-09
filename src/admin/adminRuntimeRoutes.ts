import { writeJson, readBody } from "./adminRouteUtils.js";
import type { Router } from "./router.js";
import { RUNTIME_IDS, isRuntimeId, type RuntimeId } from "../runtime/runtimeProfile.js";

/** Controller exposing runtime selection + gateway health to the admin API. */
export interface RuntimeController {
  /** The effective global default runtime. */
  getDefaultRuntime(): RuntimeId;
  /** Persist and hot-apply the global default runtime. */
  setDefaultRuntime(id: RuntimeId): Promise<void>;
  /** Runtime ids with a registered runner. */
  listRuntimes(): RuntimeId[];
  /** OpenShell gateway health (undefined when the openshell runtime is not registered). */
  gatewayHealthy(): Promise<boolean | undefined>;
}

export interface RuntimeRouteDeps {
  runtime?: RuntimeController | undefined;
}

/** Register runtime selection + gateway-health routes. */
export function registerRuntimeRoutes(router: Router, deps: RuntimeRouteDeps): void {
  router.add("GET", "/api/admin/runtime", async (_req, res) => {
    if (!deps.runtime) {
      writeJson(res, 501, { error: "Runtime controller not available" });
      return;
    }
    writeJson(res, 200, {
      defaultRuntime: deps.runtime.getDefaultRuntime(),
      available: deps.runtime.listRuntimes(),
      supported: [...RUNTIME_IDS],
      gatewayHealthy: await deps.runtime.gatewayHealthy(),
    });
  });

  router.add("PUT", "/api/admin/runtime", async (req, res) => {
    if (!deps.runtime) {
      writeJson(res, 501, { error: "Runtime controller not available" });
      return;
    }
    const body = await readBody(req);
    const next = body?.["defaultRuntime"];
    if (!isRuntimeId(next)) {
      writeJson(res, 400, { error: `defaultRuntime must be one of: ${RUNTIME_IDS.join(", ")}` });
      return;
    }
    if (!deps.runtime.listRuntimes().includes(next)) {
      writeJson(res, 400, { error: `runtime '${next}' has no registered runner` });
      return;
    }
    await deps.runtime.setDefaultRuntime(next);
    writeJson(res, 200, { defaultRuntime: deps.runtime.getDefaultRuntime() });
  });
}
