import { writeJson, readBody } from "./adminRouteUtils.js";
import type { Router } from "./router.js";

/** Effective (resolved) workflow settings surfaced to the admin UI. */
export interface EffectiveWorkflowSettings {
  pollingIntervalMs: number;
  maxAgentCycles: number;
  maxRetryAttempts: number;
}

export interface SettingsController {
  /** Current effective values (persisted overrides merged over config defaults). */
  get(): EffectiveWorkflowSettings;
  /** Persist the provided overrides, hot-apply them, and return the new effective values. */
  update(patch: Partial<EffectiveWorkflowSettings>): Promise<EffectiveWorkflowSettings>;
}

export interface SettingsRouteDeps {
  settings?: SettingsController | undefined;
}

/** Parse a value into a positive integer, or return an error message. */
function parsePositiveInt(value: unknown, field: string): number | { error: string } {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { error: `${field} must be a number` };
  }
  if (!Number.isInteger(value) || value <= 0) {
    return { error: `${field} must be a positive integer` };
  }
  return value;
}

/** Register the editable-workflow-settings routes on the given router. */
export function registerSettingsRoutes(router: Router, deps: SettingsRouteDeps): void {
  router.add("GET", "/api/admin/settings", async (_req, res, _params) => {
    if (!deps.settings) {
      writeJson(res, 501, { error: "Settings controller not available" });
      return;
    }
    writeJson(res, 200, { settings: deps.settings.get() });
  });

  router.add("PUT", "/api/admin/settings", async (req, res, _params) => {
    if (!deps.settings) {
      writeJson(res, 501, { error: "Settings controller not available" });
      return;
    }
    const body = await readBody(req);
    if (!body) {
      writeJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const patch: Partial<EffectiveWorkflowSettings> = {};

    if (body["pollingIntervalMs"] !== undefined) {
      const parsed = parsePositiveInt(body["pollingIntervalMs"], "pollingIntervalMs");
      if (typeof parsed !== "number") { writeJson(res, 400, parsed); return; }
      patch.pollingIntervalMs = parsed;
    }
    if (body["maxAgentCycles"] !== undefined) {
      const parsed = parsePositiveInt(body["maxAgentCycles"], "maxAgentCycles");
      if (typeof parsed !== "number") { writeJson(res, 400, parsed); return; }
      patch.maxAgentCycles = parsed;
    }
    if (body["maxRetryAttempts"] !== undefined) {
      const parsed = parsePositiveInt(body["maxRetryAttempts"], "maxRetryAttempts");
      if (typeof parsed !== "number") { writeJson(res, 400, parsed); return; }
      patch.maxRetryAttempts = parsed;
    }

    if (Object.keys(patch).length === 0) {
      writeJson(res, 400, { error: "No valid settings provided" });
      return;
    }

    const next = await deps.settings.update(patch);
    writeJson(res, 200, { settings: next });
  });
}
