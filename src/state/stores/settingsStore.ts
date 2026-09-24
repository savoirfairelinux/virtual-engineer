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
  agentTimeoutMs: number | null;
  ticketCloseMaxRetries: number | null;
  ticketCloseRetryMinTimeoutMs: number | null;
}

export interface BackupSettings {
  enabled: boolean | null;
  intervalDays: number | null;
  timeOfDay: string | null;
  retentionCount: number | null;
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
  getBackupSettings(): Promise<BackupSettings>;
  updateBackupSettings(patch: Partial<BackupSettings>): Promise<BackupSettings>;
}

interface SettingsStoreContext {
  db: BetterSQLite3Database<typeof schema>;
}

const EMPTY: AppSettings = {
  pollingIntervalMs: null,
  maxAgentCycles: null,
  maxRetryAttempts: null,
  agentTimeoutMs: null,
  ticketCloseMaxRetries: null,
  ticketCloseRetryMinTimeoutMs: null,
};

const EMPTY_BACKUP: BackupSettings = {
  enabled: null,
  intervalDays: null,
  timeOfDay: null,
  retentionCount: null,
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
      agentTimeoutMs: row.agentTimeoutMs ?? null,
      ticketCloseMaxRetries: row.ticketCloseMaxRetries ?? null,
      ticketCloseRetryMinTimeoutMs: row.ticketCloseRetryMinTimeoutMs ?? null,
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
    if (patch.agentTimeoutMs !== undefined) conflictSet["agentTimeoutMs"] = patch.agentTimeoutMs;
    if (patch.ticketCloseMaxRetries !== undefined) conflictSet["ticketCloseMaxRetries"] = patch.ticketCloseMaxRetries;
    if (patch.ticketCloseRetryMinTimeoutMs !== undefined) conflictSet["ticketCloseRetryMinTimeoutMs"] = patch.ticketCloseRetryMinTimeoutMs;

    await db
      .insert(appSettings)
      .values({
        id: "global",
        pollingIntervalMs: patch.pollingIntervalMs ?? null,
        maxAgentCycles: patch.maxAgentCycles ?? null,
        maxRetryAttempts: patch.maxRetryAttempts ?? null,
        agentTimeoutMs: patch.agentTimeoutMs ?? null,
        ticketCloseMaxRetries: patch.ticketCloseMaxRetries ?? null,
        ticketCloseRetryMinTimeoutMs: patch.ticketCloseRetryMinTimeoutMs ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({ target: appSettings.id, set: conflictSet });

    return getAppSettings();
  }

  async function getBackupSettings(): Promise<BackupSettings> {
    const row = await db.query.appSettings.findFirst({ where: eq(appSettings.id, "global") });
    if (!row) return { ...EMPTY_BACKUP };
    return {
      enabled: row.backupEnabled ?? null,
      intervalDays: row.backupIntervalDays ?? null,
      timeOfDay: row.backupTimeOfDay ?? null,
      retentionCount: row.backupRetentionCount ?? null,
    };
  }

  async function updateBackupSettings(patch: Partial<BackupSettings>): Promise<BackupSettings> {
    const now = new Date();
    const conflictSet: Record<string, unknown> = { updatedAt: now };
    if (patch.enabled !== undefined) conflictSet["backupEnabled"] = patch.enabled;
    if (patch.intervalDays !== undefined) conflictSet["backupIntervalDays"] = patch.intervalDays;
    if (patch.timeOfDay !== undefined) conflictSet["backupTimeOfDay"] = patch.timeOfDay;
    if (patch.retentionCount !== undefined) conflictSet["backupRetentionCount"] = patch.retentionCount;

    await db
      .insert(appSettings)
      .values({
        id: "global",
        backupEnabled: patch.enabled ?? null,
        backupIntervalDays: patch.intervalDays ?? null,
        backupTimeOfDay: patch.timeOfDay ?? null,
        backupRetentionCount: patch.retentionCount ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({ target: appSettings.id, set: conflictSet });

    return getBackupSettings();
  }

  return {
    getAppSettings,
    updateAppSettings,
    getBackupSettings,
    updateBackupSettings,
  };
}
