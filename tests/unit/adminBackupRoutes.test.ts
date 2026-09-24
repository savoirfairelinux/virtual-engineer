import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { createAdminServer } from "../../src/admin/adminServer.js";
import type { BackupAdminController } from "../../src/admin/adminBackupRoutes.js";
import type { BackupInfo } from "../../src/backup/backupArchive.js";
import type { EffectiveBackupSettings } from "../../src/backup/backupSettings.js";
import { registerBuiltinPlugins } from "../../src/plugins/init.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

registerBuiltinPlugins();

const SECRET = "backup-routes-secret-0123456789";
const SAMPLE_BACKUP: BackupInfo = {
  filename: "ve-backup-20260924T030000000Z-a1b2c3d4.tar.gz",
  createdAt: "2026-09-24T03:00:00.000Z",
  sizeBytes: Buffer.byteLength("archive-bytes"),
};

interface SessionResponse {
  token: string;
  user: { id: string; username: string; role: string };
}

function makeController(): BackupAdminController & {
  current: EffectiveBackupSettings;
  updateSettings: ReturnType<typeof vi.fn>;
  runNow: ReturnType<typeof vi.fn>;
  deleteBackup: ReturnType<typeof vi.fn>;
} {
  const current: EffectiveBackupSettings = {
    enabled: false,
    intervalDays: 1,
    timeOfDay: "03:00",
    retentionCount: 7,
  };
  const updateSettings = vi.fn(async (patch) => {
    Object.assign(current, patch);
    return { ...current };
  });
  const runNow = vi.fn(async () => SAMPLE_BACKUP);
  const deleteBackup = vi.fn(async () => true);
  return {
    current,
    getSettings: async () => ({ ...current }),
    updateSettings,
    listBackups: vi.fn(async () => [SAMPLE_BACKUP]),
    runNow,
    deleteBackup,
    openBackup: vi.fn(async () => ({ info: SAMPLE_BACKUP, stream: Readable.from(["archive-bytes"]) })),
    getNextBackupAt: vi.fn(async () => new Date("2026-09-25T03:00:00.000Z")),
  };
}

describe("Admin API — backup routes", () => {
  let store: SqliteStateStore;
  let server: ReturnType<typeof createAdminServer>;
  let baseUrl: string;
  let adminToken: string;
  let backups: ReturnType<typeof makeController>;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDatabasePath("ve-admin-backups"));
    backups = makeController();
    server = createAdminServer({
      stateStore: store,
      integrationStore: store,
      promptStore: store,
      agentStore: store,
      projectStore: store,
      backups,
      config: {
        nodeEnv: "test",
        logLevel: "error",
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        pollingIntervalMs: 30_000,
        adminAuthSecret: SECRET,
      },
      polling: { isRunning: () => false, getIntervals: () => ({ intervalMs: 30_000 }) },
      providers: [],
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    const setup = await fetch(`${baseUrl}/api/admin/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "Str0ng-Pass-1x" }),
    });
    expect(setup.status).toBe(201);
    adminToken = ((await setup.json()) as SessionResponse).token;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  });

  it("returns settings and the backup inventory to an admin", async () => {
    const response = await fetch(`${baseUrl}/api/admin/backups`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      backups: [SAMPLE_BACKUP],
      nextBackupAt: "2026-09-25T03:00:00.000Z",
    });

    const settings = await fetch(`${baseUrl}/api/admin/backups/settings`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(settings.status).toBe(200);
    await expect(settings.json()).resolves.toEqual({ settings: backups.current });
  });

  it("validates and updates backup settings", async () => {
    const response = await fetch(`${baseUrl}/api/admin/backups/settings`, {
      method: "PUT",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, intervalDays: 5, timeOfDay: "03:30", retentionCount: 12 }),
    });
    expect(response.status).toBe(200);
    expect(backups.updateSettings).toHaveBeenCalledWith({
      enabled: true,
      intervalDays: 5,
      timeOfDay: "03:30",
      retentionCount: 12,
    });

    const invalid = await fetch(`${baseUrl}/api/admin/backups/settings`, {
      method: "PUT",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ intervalDays: 0 }),
    });
    expect(invalid.status).toBe(400);
  });

  it("runs a backup, downloads it, deletes it, and audits mutations", async () => {
    const run = await fetch(`${baseUrl}/api/admin/backups`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(run.status).toBe(201);
    await expect(run.json()).resolves.toEqual({ backup: SAMPLE_BACKUP });

    const download = await fetch(`${baseUrl}/api/admin/backups/${SAMPLE_BACKUP.filename}/download`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain(SAMPLE_BACKUP.filename);
    await expect(download.text()).resolves.toBe("archive-bytes");

    const deleted = await fetch(`${baseUrl}/api/admin/backups/${SAMPLE_BACKUP.filename}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(deleted.status).toBe(204);
    expect(backups.deleteBackup).toHaveBeenCalledWith(SAMPLE_BACKUP.filename);

    for (const action of ["backup.create", "backup.delete"]) {
      const audit = await waitForAudit(store, action);
      expect(audit).toHaveLength(1);
    }
  });

  it("streams backups through a single-use token scoped to the archive filename", async () => {
    const tokenResponse = await fetch(`${baseUrl}/api/admin/backups/${SAMPLE_BACKUP.filename}/download-token`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(tokenResponse.status).toBe(200);
    expect(tokenResponse.headers.get("cache-control")).toContain("no-store");
    const { token } = await tokenResponse.json() as { token: string };
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const downloadUrl = `/api/admin/backups/${encodeURIComponent(SAMPLE_BACKUP.filename)}/download?t=${token}`;

    const mismatched = await fetch(new URL(
      `/api/admin/backups/ve-backup-20260924T030000000Z-c3d4e5f6.tar.gz/download?t=${token}`,
      baseUrl,
    ));
    expect(mismatched.status).toBe(401);

    const download = await fetch(new URL(downloadUrl, baseUrl));
    expect(download.status).toBe(401);

    const secondTokenResponse = await fetch(`${baseUrl}/api/admin/backups/${SAMPLE_BACKUP.filename}/download-token`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const secondToken = await secondTokenResponse.json() as { token: string };
    const secondDownloadUrl = `/api/admin/backups/${encodeURIComponent(SAMPLE_BACKUP.filename)}/download?t=${secondToken.token}`;
    const streamed = await fetch(new URL(secondDownloadUrl, baseUrl));
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-disposition")).toContain(SAMPLE_BACKUP.filename);
    await expect(streamed.text()).resolves.toBe("archive-bytes");

    const reused = await fetch(new URL(secondDownloadUrl, baseUrl));
    expect(reused.status).toBe(401);
  });

  it("rejects invalid backup names before download or deletion", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(`${baseUrl}/api/admin/backups/%2e%2e%2fsecrets/download`, {
        method,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(backups.openBackup).not.toHaveBeenCalled();
    expect(backups.deleteBackup).not.toHaveBeenCalled();
  });

  it("denies backup access to an operator without the dedicated permission", async () => {
    const create = await fetch(`${baseUrl}/api/admin/users`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ username: "ops", password: "Str0ng-Pass-1x", role: "operator" }),
    });
    expect(create.status).toBe(201);
    const login = await fetch(`${baseUrl}/api/admin/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ops", password: "Str0ng-Pass-1x" }),
    });
    const operatorToken = ((await login.json()) as SessionResponse).token;

    const response = await fetch(`${baseUrl}/api/admin/backups`, {
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(response.status).toBe(403);

    const tokenResponse = await fetch(
      `${baseUrl}/api/admin/backups/${SAMPLE_BACKUP.filename}/download-token`,
      { method: "POST", headers: { authorization: `Bearer ${operatorToken}` } },
    );
    expect(tokenResponse.status).toBe(403);
    expect(backups.listBackups).not.toHaveBeenCalled();
  });
});

async function waitForAudit(store: SqliteStateStore, action: string): Promise<unknown[]> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await store.listAuditEntries({ action });
    if (result.entries.length > 0) return result.entries;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return (await store.listAuditEntries({ action })).entries;
}