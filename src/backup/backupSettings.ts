import type { BackupSettings } from "../state/stores/settingsStore.js";

export interface EffectiveBackupSettings {
  enabled: boolean;
  intervalDays: number;
  timeOfDay: string;
  retentionCount: number;
}

export const DEFAULT_BACKUP_SETTINGS: EffectiveBackupSettings = {
  enabled: false,
  intervalDays: 1,
  timeOfDay: "03:00",
  retentionCount: 7,
};

const TIME_OF_DAY_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function resolveBackupSettings(settings: BackupSettings): EffectiveBackupSettings {
  return {
    enabled: settings.enabled ?? DEFAULT_BACKUP_SETTINGS.enabled,
    intervalDays: isIntegerInRange(settings.intervalDays, 1, 365)
      ? settings.intervalDays
      : DEFAULT_BACKUP_SETTINGS.intervalDays,
    timeOfDay: typeof settings.timeOfDay === "string" && TIME_OF_DAY_PATTERN.test(settings.timeOfDay)
      ? settings.timeOfDay
      : DEFAULT_BACKUP_SETTINGS.timeOfDay,
    retentionCount: isIntegerInRange(settings.retentionCount, 1, 100)
      ? settings.retentionCount
      : DEFAULT_BACKUP_SETTINGS.retentionCount,
  };
}

export function nextScheduledBackupAt(
  lastBackupAt: string | null,
  settings: EffectiveBackupSettings,
  now: Date
): Date {
  const [hourText, minuteText] = settings.timeOfDay.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const anchor = lastBackupAt === null ? now : new Date(lastBackupAt);
  const daysToAdd = lastBackupAt === null ? 0 : settings.intervalDays;
  const dueAt = new Date(Date.UTC(
    anchor.getUTCFullYear(),
    anchor.getUTCMonth(),
    anchor.getUTCDate() + daysToAdd,
    hour,
    minute,
  ));

  if (lastBackupAt === null && dueAt.getTime() < now.getTime()) return now;
  return dueAt;
}

function isIntegerInRange(value: number | null, minimum: number, maximum: number): value is number {
  return value !== null && Number.isInteger(value) && value >= minimum && value <= maximum;
}