import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { writeJson, readBody, requireStore } from "./adminRouteUtils.js";
import type { AuditCapableStore } from "./adminAudit.js";
import { recordAudit } from "./adminAudit.js";
import type { Router } from "./router.js";
import { isBackupFilename, type BackupInfo } from "../backup/backupArchive.js";
import type { EffectiveBackupSettings } from "../backup/backupSettings.js";

export interface BackupSettingsPatch {
  enabled?: boolean | null;
  intervalDays?: number | null;
  timeOfDay?: string | null;
  retentionCount?: number | null;
}

export interface BackupAdminController {
  getSettings(): Promise<EffectiveBackupSettings>;
  updateSettings(patch: BackupSettingsPatch): Promise<EffectiveBackupSettings>;
  listBackups(): Promise<BackupInfo[]>;
  runNow(): Promise<BackupInfo>;
  deleteBackup(filename: string): Promise<boolean>;
  openBackup(filename: string): Promise<{ info: BackupInfo; stream: Readable }>;
  getNextBackupAt(): Promise<Date | null>;
}

export interface BackupRoutesDeps {
  backups?: BackupAdminController | undefined;
  auditStore?: AuditCapableStore | undefined;
}

type ParsedSetting = boolean | number | string | null | { error: string };

function parseBackupSetting(field: keyof BackupSettingsPatch, value: unknown): ParsedSetting {
  if (value === null) return null;
  if (field === "enabled") {
    return typeof value === "boolean" ? value : { error: "enabled must be a boolean or null" };
  }
  if (field === "intervalDays" || field === "retentionCount") {
    const maximum = field === "intervalDays" ? 365 : 100;
    const minimum = 1;
    return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
      ? value
      : { error: `${field} must be an integer between ${minimum} and ${maximum}` };
  }
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
    ? value
    : { error: "timeOfDay must be a UTC time in HH:MM format" };
}

export function registerBackupRoutes(router: Router, deps: BackupRoutesDeps): void {
  router.add("GET", "/api/admin/backups/settings", async (_req, res) => {
    if (!requireStore(deps.backups, res, "Backup service not available")) return;
    writeJson(res, 200, { settings: await deps.backups.getSettings() });
  }, { permission: "system.backup.manage" });

  router.add("PUT", "/api/admin/backups/settings", async (req, res) => {
    if (!requireStore(deps.backups, res, "Backup service not available")) return;
    const body = await readBody(req);
    if (!body) {
      writeJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const patch: BackupSettingsPatch = {};
    const fields: (keyof BackupSettingsPatch)[] = ["enabled", "intervalDays", "timeOfDay", "retentionCount"];
    for (const field of fields) {
      if (body[field] === undefined) continue;
      const parsed = parseBackupSetting(field, body[field]);
      if (typeof parsed === "object" && parsed !== null) {
        writeJson(res, 400, parsed);
        return;
      }
      patch[field] = parsed as never;
    }
    if (Object.keys(patch).length === 0) {
      writeJson(res, 400, { error: "No valid backup settings provided" });
      return;
    }

    const settings = await deps.backups.updateSettings(patch);
    recordAudit(deps.auditStore, req, {
      action: "backup.settings_update",
      targetType: "backup",
      details: { settings: patch },
    });
    writeJson(res, 200, { settings });
  }, { permission: "system.backup.manage" });

  router.add("GET", "/api/admin/backups", async (_req, res) => {
    if (!requireStore(deps.backups, res, "Backup service not available")) return;
    const [backups, nextBackupAt] = await Promise.all([
      deps.backups.listBackups(),
      deps.backups.getNextBackupAt(),
    ]);
    writeJson(res, 200, {
      backups,
      nextBackupAt: nextBackupAt?.toISOString() ?? null,
    });
  }, { permission: "system.backup.manage" });

  router.add("POST", "/api/admin/backups", async (req, res) => {
    if (!requireStore(deps.backups, res, "Backup service not available")) return;
    const backup = await deps.backups.runNow();
    recordAudit(deps.auditStore, req, {
      action: "backup.create",
      targetType: "backup",
      targetId: backup.filename,
      details: { sizeBytes: backup.sizeBytes, createdAt: backup.createdAt },
    });
    writeJson(res, 201, { backup });
  }, { permission: "system.backup.manage" });

  router.add("GET", "/api/admin/backups/:filename/download", async (_req, res, params) => {
    if (!requireStore(deps.backups, res, "Backup service not available")) return;
    const filename = params["filename"] ?? "";
    if (!isBackupFilename(filename)) {
      writeJson(res, 400, { error: "Invalid backup filename" });
      return;
    }
    let opened: { info: BackupInfo; stream: Readable };
    try {
      opened = await deps.backups.openBackup(filename);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        writeJson(res, 404, { error: "Backup not found" });
      } else {
        throw error;
      }
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/gzip");
    res.setHeader("content-length", String(opened.info.sizeBytes));
    res.setHeader("content-disposition", `attachment; filename="${opened.info.filename}"`);
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    try {
      await pipeline(opened.stream, res);
    } catch (error) {
      res.destroy(error instanceof Error ? error : undefined);
    }
  }, { permission: "system.backup.manage" });

  router.add("DELETE", "/api/admin/backups/:filename", async (req, res, params) => {
    if (!requireStore(deps.backups, res, "Backup service not available")) return;
    const filename = params["filename"] ?? "";
    if (!isBackupFilename(filename)) {
      writeJson(res, 400, { error: "Invalid backup filename" });
      return;
    }
    const deleted = await deps.backups.deleteBackup(filename);
    if (!deleted) {
      writeJson(res, 404, { error: "Backup not found" });
      return;
    }
    recordAudit(deps.auditStore, req, {
      action: "backup.delete",
      targetType: "backup",
      targetId: filename,
    });
    res.statusCode = 204;
    res.end();
  }, { permission: "system.backup.manage" });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}