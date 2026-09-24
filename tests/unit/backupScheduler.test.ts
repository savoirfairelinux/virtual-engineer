import { describe, it, expect, vi } from "vitest";
import { Readable } from "node:stream";
import { createBackupScheduler } from "../../src/runtime/backupScheduler.js";
import type { BackupInfo } from "../../src/backup/backupArchive.js";
import type { BackupService } from "../../src/backup/backupService.js";
import type { BackupSettings } from "../../src/state/stores/settingsStore.js";

const backup: BackupInfo = {
  filename: "ve-backup-20260924T030000000Z-a1b2c3d4.tar.gz",
  createdAt: "2026-09-24T03:00:00.000Z",
  sizeBytes: 2048,
};

function makeSettings(enabled = true): BackupSettings {
  return { enabled, intervalDays: 1, timeOfDay: "03:00", retentionCount: 7 };
}

function makeService(backups: BackupInfo[] = []): BackupService {
  return {
    createBackup: vi.fn(async () => backup),
    listBackups: vi.fn(async () => backups),
    deleteBackup: vi.fn(async () => true),
    prune: vi.fn(async () => []),
    openBackup: vi.fn(async () => ({ info: backup, stream: Readable.from([]) })),
  };
}

describe("backup scheduler", () => {
  it("creates the first backup once the configured UTC time has passed", async () => {
    const backupService = makeService();
    const scheduler = createBackupScheduler({
      backupService,
      getSettings: async () => makeSettings(),
      now: () => new Date("2026-09-24T03:01:00.000Z"),
    });

    await scheduler.checkDue();

    expect(backupService.createBackup).toHaveBeenCalledTimes(1);
    expect(backupService.prune).toHaveBeenCalledWith(7);
  });

  it("waits until the configured UTC time when no backup exists", async () => {
    const backupService = makeService();
    const scheduler = createBackupScheduler({
      backupService,
      getSettings: async () => makeSettings(),
      now: () => new Date("2026-09-24T02:59:00.000Z"),
    });

    await scheduler.checkDue();

    expect(backupService.createBackup).not.toHaveBeenCalled();
  });

  it("runs when the interval reaches the configured time", async () => {
    const backupService = makeService([{
      ...backup,
      createdAt: "2026-09-23T03:01:00.000Z",
    }]);
    const scheduler = createBackupScheduler({
      backupService,
      getSettings: async () => makeSettings(),
      now: () => new Date("2026-09-24T03:00:00.000Z"),
    });

    await scheduler.checkDue();

    expect(backupService.createBackup).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent manual backup requests", async () => {
    const backupService = makeService();
    let finishBackup: ((value: BackupInfo) => void) | undefined;
    backupService.createBackup = vi.fn(() => new Promise<BackupInfo>((resolve) => {
      finishBackup = resolve;
    }));
    const scheduler = createBackupScheduler({
      backupService,
      getSettings: async () => makeSettings(false),
      now: () => new Date("2026-09-24T03:00:00.000Z"),
    });

    const first = scheduler.runNow();
    const second = scheduler.runNow();
    await Promise.resolve();
    expect(backupService.createBackup).toHaveBeenCalledTimes(1);
    finishBackup?.(backup);

    await expect(Promise.all([first, second])).resolves.toEqual([backup, backup]);
    expect(backupService.prune).toHaveBeenCalledTimes(1);
  });
});