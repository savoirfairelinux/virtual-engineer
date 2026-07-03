import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { appSettings } from "../schema.js";
import * as schema from "../schema.js";

/**
 * Editable workflow settings persisted in the `app_settings` singleton row.
 * Each value is nullable — `null` means "fall back to the `config.ts` default".
 */
export interface AppSettings {
  pollingIntervalMs: number | null;
  maxAgentCycles: number | null;
  maxRetryAttempts: number | null;
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
    };
  }

  async function updateAppSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const now = new Date();
    const existing = await getAppSettings();
    const next: AppSettings = {
      pollingIntervalMs: patch.pollingIntervalMs !== undefined ? patch.pollingIntervalMs : existing.pollingIntervalMs,
      maxAgentCycles: patch.maxAgentCycles !== undefined ? patch.maxAgentCycles : existing.maxAgentCycles,
      maxRetryAttempts: patch.maxRetryAttempts !== undefined ? patch.maxRetryAttempts : existing.maxRetryAttempts,
    };

    const row = await db.query.appSettings.findFirst({ where: eq(appSettings.id, "global") });
    if (row) {
      await db
        .update(appSettings)
        .set({
          pollingIntervalMs: next.pollingIntervalMs,
          maxAgentCycles: next.maxAgentCycles,
          maxRetryAttempts: next.maxRetryAttempts,
          updatedAt: now,
        })
        .where(eq(appSettings.id, "global"));
    } else {
      await db.insert(appSettings).values({
        id: "global",
        pollingIntervalMs: next.pollingIntervalMs,
        maxAgentCycles: next.maxAgentCycles,
        maxRetryAttempts: next.maxRetryAttempts,
        updatedAt: now,
      });
    }
    return next;
  }

  return {
    getAppSettings,
    updateAppSettings,
  };
}
