import { writeJson, readBody } from "./adminRouteUtils.js";
import type { Router } from "./router.js";

/** Effective (resolved) workflow settings surfaced to the admin UI. */
export interface EffectiveWorkflowSettings {
  pollingIntervalMs: number;
  maxAgentCycles: number;
  maxRetryAttempts: number;
}

/**
 * A settings patch. Each field is optional; a `null` value clears the persisted
 * override, reverting that setting to its `config.ts` default.
 */
export type WorkflowSettingsPatch = Partial<Record<keyof EffectiveWorkflowSettings, number | null>>;

export interface SettingsController {
  /** Current effective values (persisted overrides merged over config defaults). */
  get(): EffectiveWorkflowSettings;
  /** Persist the provided overrides, hot-apply them, and return the new effective values. */
  update(patch: WorkflowSettingsPatch): Promise<EffectiveWorkflowSettings>;
}

export interface SettingsRouteDeps {
  settings?: SettingsController | undefined;
}

/**
 * Parse a settings value into a positive integer or `null` (which clears the
 * override), otherwise return an error message. `pollingIntervalMs` must also
 * be a whole number of seconds (multiple of 1000ms) to stay consistent with the
 * seconds-based UI editor.
 */
function parseSetting(value: unknown, field: keyof EffectiveWorkflowSettings): number | null | { error: string } {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { error: `${field} must be a number or null` };
  }
  if (!Number.isInteger(value) || value <= 0) {
    return { error: `${field} must be a positive integer` };
  }
  if (field === "pollingIntervalMs" && value % 1000 !== 0) {
    return { error: `${field} must be a multiple of 1000 (whole seconds)` };
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

    const patch: WorkflowSettingsPatch = {};
    const fields: (keyof EffectiveWorkflowSettings)[] = ["pollingIntervalMs", "maxAgentCycles", "maxRetryAttempts"];
    for (const field of fields) {
      if (body[field] === undefined) continue;
      const parsed = parseSetting(body[field], field);
      if (parsed !== null && typeof parsed !== "number") { writeJson(res, 400, parsed); return; }
      patch[field] = parsed;
    }

    if (Object.keys(patch).length === 0) {
      writeJson(res, 400, { error: "No valid settings provided" });
      return;
    }

    const next = await deps.settings.update(patch);
    writeJson(res, 200, { settings: next });
  });
}
