import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { appSettings } from "../schema.js";
import * as schema from "../schema.js";
import type { RuntimeId } from "../../runtime/runtimeProfile.js";

/**
 * Editable workflow settings persisted in the `app_settings` singleton row.
 * Each value is nullable — `null` means "fall back to the `config.ts` default".
 */
export interface AppSettings {
  pollingIntervalMs: number | null;
  maxAgentCycles: number | null;
  maxRetryAttempts: number | null;
  /** Global default agent runtime. `null` = built-in default (`docker`). */
  defaultRuntime: RuntimeId | null;
}

export interface SettingsStoreApi {
  /** Read the persisted workflow settings. Missing row → all fields `null`. */
  getAppSettings(): Promise<AppSettings>;
  /**
   * Upsert the `global` settings row. Only the provided keys are written;
   * omitted keys retain their existing persisted value. Passing an explicit
   * `null` clears a value (reverting to the config default on next boot).
   */
  updateAppSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
}

interface SettingsStoreContext {
  db: BetterSQLite3Database<typeof schema>;
}

const EMPTY: AppSettings = {
  pollingIntervalMs: null,
  maxAgentCycles: null,
  maxRetryAttempts: null,
  defaultRuntime: null,
};

export function createSettingsStore(context: SettingsStoreContext): SettingsStoreApi {
  const { db } = context;

  async function getAppSettings(): Promise<AppSettings> {
    const row = await db.query.appSettings.findFirst({ where: eq(appSettings.id, "global") });
    if (!row) return { ...EMPTY };
    return {
      pollingIntervalMs: row.pollingIntervalMs ?? null,
      maxAgentCycles: row.maxAgentCycles ?? null,
      maxRetryAttempts: row.maxRetryAttempts ?? null,
      defaultRuntime: row.defaultRuntime ?? null,
    };
  }

  async function updateAppSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const now = new Date();

    // Race-safe single upsert: on conflict, only the columns present in `patch`
    // are overwritten so concurrent partial updates to different fields don't
    // clobber each other, and two concurrent first-writes can't collide on the PK.
    const conflictSet: Record<string, unknown> = { updatedAt: now };
    if (patch.pollingIntervalMs !== undefined) conflictSet["pollingIntervalMs"] = patch.pollingIntervalMs;
    if (patch.maxAgentCycles !== undefined) conflictSet["maxAgentCycles"] = patch.maxAgentCycles;
    if (patch.maxRetryAttempts !== undefined) conflictSet["maxRetryAttempts"] = patch.maxRetryAttempts;
    if (patch.defaultRuntime !== undefined) conflictSet["defaultRuntime"] = patch.defaultRuntime;

    await db
      .insert(appSettings)
      .values({
        id: "global",
        pollingIntervalMs: patch.pollingIntervalMs ?? null,
        maxAgentCycles: patch.maxAgentCycles ?? null,
        maxRetryAttempts: patch.maxRetryAttempts ?? null,
        defaultRuntime: patch.defaultRuntime ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({ target: appSettings.id, set: conflictSet });

    return getAppSettings();
  }

  return {
    getAppSettings,
    updateAppSettings,
  };
}
