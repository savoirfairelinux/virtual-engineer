import { getLogger } from "../logger.js";
import { nextScheduledBackupAt, resolveBackupSettings } from "../backup/backupSettings.js";
import type { BackupInfo } from "../backup/backupArchive.js";
import type { BackupService } from "../backup/backupService.js";
import type { BackupSettings } from "../state/stores/settingsStore.js";

const log = getLogger("backup-scheduler");
const DEFAULT_CHECK_INTERVAL_MS = 15 * 60 * 1000;

export interface BackupSchedulerDeps {
  backupService: BackupService;
  getSettings: () => Promise<BackupSettings>;
  now?: () => Date;
  checkIntervalMs?: number;
}

export interface BackupScheduler {
  start(): void;
  stop(): Promise<void>;
  applySettings(): void;
  checkDue(): Promise<void>;
  runNow(): Promise<BackupInfo>;
  getNextBackupAt(): Promise<Date | null>;
}

export function createBackupScheduler(deps: BackupSchedulerDeps): BackupScheduler {
  const now = deps.now ?? ((): Date => new Date());
  const checkIntervalMs = deps.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let checkInFlight: Promise<void> | undefined;
  let backupInFlight: Promise<BackupInfo> | undefined;
  let completedRuns = 0;

  async function runNow(): Promise<BackupInfo> {
    if (backupInFlight) return backupInFlight;
    const current = (async (): Promise<BackupInfo> => {
      const settings = resolveBackupSettings(await deps.getSettings());
      const backup = await deps.backupService.createBackup();
      completedRuns += 1;
      await deps.backupService.prune(settings.retentionCount);
      return backup;
    })();
    backupInFlight = current;
    try {
      return await current;
    } finally {
      if (backupInFlight === current) backupInFlight = undefined;
    }
  }

  async function evaluateDue(): Promise<void> {
    if (stopped) return;
    const runCountBeforeCheck = completedRuns;
    const settings = resolveBackupSettings(await deps.getSettings());
    if (!settings.enabled || stopped) return;
    const backups = await deps.backupService.listBackups();
    if (stopped || backupInFlight || completedRuns !== runCountBeforeCheck) return;
    const latest = backups[0]?.createdAt ?? null;
    if (now().getTime() >= nextScheduledBackupAt(latest, settings, now()).getTime()) {
      await runNow();
    }
  }

  function checkDue(): Promise<void> {
    if (checkInFlight) return checkInFlight;
    const current = evaluateDue().catch((error: unknown) => {
      log.error({ err: error }, "scheduled backup check failed");
      throw error;
    });
    checkInFlight = current;
    return current.finally(() => {
      if (checkInFlight === current) checkInFlight = undefined;
    });
  }

  function start(): void {
    if (timer) return;
    stopped = false;
    timer = setInterval(() => {
      void checkDue().catch(() => undefined);
    }, checkIntervalMs);
    timer.unref();
    void checkDue().catch(() => undefined);
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    await Promise.all([
      checkInFlight?.catch(() => undefined),
      backupInFlight?.catch(() => undefined),
    ]);
  }

  function applySettings(): void {
    if (timer) void checkDue().catch(() => undefined);
  }

  async function getNextBackupAt(): Promise<Date | null> {
    const settings = resolveBackupSettings(await deps.getSettings());
    if (!settings.enabled) return null;
    const backups = await deps.backupService.listBackups();
    return nextScheduledBackupAt(backups[0]?.createdAt ?? null, settings, now());
  }

  return { start, stop, applySettings, checkDue, runNow, getNextBackupAt };
}