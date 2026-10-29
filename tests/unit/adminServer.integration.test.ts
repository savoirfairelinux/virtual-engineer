import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { createAdminServer } from "../../src/admin/adminServer.js";
import { makeExternalChangeId, makeTaskId, makeTicketId } from "../../src/interfaces.js";
import { createBackupService } from "../../src/backup/backupService.js";
import { restoreBackupIfRequested } from "../../src/backup/backupRestore.js";
import { resolveBackupSettings } from "../../src/backup/backupSettings.js";
import { registerBuiltinPlugins } from "../../src/plugins/init.js";
import { decryptToken, isVersionedEncryptedToken } from "../../src/utils/encryption.js";
import { writeTestBackupKeyring } from "./helpers/backupKeyring.js";

async function listen(server: ReturnType<typeof createAdminServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    function handleError(err: Error): void {
      server.off("listening", handleListening);
      reject(err);
    }

    function handleListening(): void {
      server.off("error", handleError);
      resolve();
    }

    server.once("error", handleError);
    server.listen(0, "127.0.0.1", handleListening);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP address");
  }

  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

async function closeServer(server: ReturnType<typeof createAdminServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function startBackupAdmin(
  store: SqliteStateStore,
  databaseDir: string,
  backupDir: string,
  backupKeyringFile: string,
  adminAuthSecret: string,
): Promise<{ server: ReturnType<typeof createAdminServer>; baseUrl: string }> {
  const backupService = createBackupService({
    backupDir,
    backupKeyringFile,
    promptsDir: join(databaseDir, "prompts"),
    stateStore: store,
    adminAuthSecret,
  });
  const server = createAdminServer({
    stateStore: store,
    integrationStore: store,
    backups: {
      getSettings: async () => resolveBackupSettings(await store.getBackupSettings()),
      updateSettings: async (patch) => resolveBackupSettings(await store.updateBackupSettings(patch)),
      listBackups: () => backupService.listBackups(),
      runNow: () => backupService.createBackup(),
      deleteBackup: (filename) => backupService.deleteBackup(filename),
      openBackup: (filename) => backupService.openBackup(filename),
      getNextBackupAt: async () => null,
    },
    config: {
      nodeEnv: "test",
      logLevel: "error",
      maxAgentCycles: 3,
      maxRetryAttempts: 5,
      pollingIntervalMs: 30_000,
      adminAuthSecret,
    },
    polling: { isRunning: () => false, getIntervals: () => ({ intervalMs: 30_000 }) },
    providers: [],
  });
  return { server, baseUrl: await listen(server) };
}

describe("createAdminServer integration", () => {
  it("serves persisted SQLite task data end-to-end", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ve-admin-server-"));
    const databasePath = join(tempDir, "state.db");
    const stateStore = await SqliteStateStore.create(databasePath);
    const taskId = makeTaskId(randomUUID());
    const ticketId = makeTicketId("redmine-42");

    try {
      await stateStore.createTask(taskId, ticketId);
      await stateStore.transition(taskId, "CONTEXT_BUILDING", { source: "integration-test" });
      await stateStore.transition(taskId, "AGENT_RUNNING", { cycle: 1 });
      await stateStore.transition(taskId, "IN_REVIEW", { reviewer: "gerrit" });
      await stateStore.updateExternalChangeId(taskId, makeExternalChangeId("Iintegration"), 3);
      await stateStore.saveAgentCycle(taskId, 1, {
        status: "running",
        modifiedFiles: [],
        summary: "",
        agentLogs: "",
        metadata: {},
      });

      const server = createAdminServer({
        stateStore,
        allowUnauthenticatedAdmin: true,
        config: {
          nodeEnv: "test",
          logLevel: "info",
          maxAgentCycles: 3,
          maxRetryAttempts: 5,
          pollingIntervalMs: 30_000,
        },
        polling: {
          isRunning: () => true,
          getIntervals: () => ({ intervalMs: 30_000 }),
        },
        providers: [
          {
            id: "redmine",
            name: "Redmine",
            category: "ticketing",
            domainCapabilities: ["issue_tracking"],
            intake: { issue_tracking: ["polling", "webhook"] },
            enabled: true,
            configured: true,
            status: "ready",
            details: ["polling enabled"],
          },
        ],
      });

      try {
        const baseUrl = await listen(server);

        const tasksResponse = await fetch(`${baseUrl}/api/admin/tasks`);
        expect(tasksResponse.status).toBe(200);
        await expect(tasksResponse.json()).resolves.toEqual({
          tasks: [expect.objectContaining({ taskId, ticketId, state: "IN_REVIEW", ticketUrl: null, reviewUrl: null })],
        });

        const transitionsResponse = await fetch(`${baseUrl}/api/admin/tasks/${taskId}/transitions`);
        expect(transitionsResponse.status).toBe(200);
        await expect(transitionsResponse.json()).resolves.toEqual({
          transitions: [
            expect.objectContaining({ toState: "CONTEXT_BUILDING" }),
            expect.objectContaining({ toState: "AGENT_RUNNING" }),
            expect.objectContaining({ toState: "IN_REVIEW" }),
          ],
        });

        const cyclesResponse = await fetch(`${baseUrl}/api/admin/tasks/${taskId}/cycles`);
        expect(cyclesResponse.status).toBe(200);
        const runningBody = await cyclesResponse.json() as { cycles: Array<{ id: number; result: { status: string } }> };
        expect(runningBody).toEqual({
          cycles: [expect.objectContaining({ cycleNumber: 1, result: expect.objectContaining({ status: "running" }) })],
        });

        await stateStore.saveAgentCycle(taskId, 1, {
          status: "success",
          modifiedFiles: ["src/admin/dashboard.ts"],
          summary: "Rendered the dashboard shell",
          agentLogs: "integration log",
          externalChangeId: makeExternalChangeId("Iintegration"),
          commitSha: "deadbeef",
          metadata: { suite: "admin-server.integration" },
        });
        const finalizedResponse = await fetch(`${baseUrl}/api/admin/tasks/${taskId}/cycles`);
        expect(finalizedResponse.status).toBe(200);
        await expect(finalizedResponse.json()).resolves.toEqual({
          cycles: [expect.objectContaining({
            id: runningBody.cycles[0]?.id,
            cycleNumber: 1,
            result: expect.objectContaining({ status: "success" }),
          })],
        });
      } finally {
        await closeServer(server);
      }
    } finally {
      stateStore.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("restores a mocked integration from an encrypted API backup in a new admin instance", async () => {
    registerBuiltinPlugins();
    const tempDir = await mkdtemp(join(tmpdir(), "ve-admin-backup-flow-"));
    const sourceDir = join(tempDir, "source");
    const restoredDir = join(tempDir, "restored");
    const backupDir = join(tempDir, "backups");
    const backupKeyringFile = join(tempDir, "backup-keyring.json");
    const adminAuthSecret = randomBytes(32).toString("hex");
    const integrationId = `mock-gitlab-${randomUUID()}`;
    const mockToken = `fixture-${randomUUID()}`;
    const updatedToken = `updated-${randomUUID()}`;
    const secondIntegrationId = `mock-gitlab-${randomUUID()}`;
    const secondToken = `fixture-${randomUUID()}`;
    const password = "Str0ng-Pass-1x";

    try {
      await mkdir(sourceDir);
      await writeTestBackupKeyring(backupKeyringFile);
      const sourceStore = await SqliteStateStore.create(join(sourceDir, "state.db"));
      let archivePath = "";
      let sourceConfigJson = "";
      try {
        const { server, baseUrl } = await startBackupAdmin(
          sourceStore, sourceDir, backupDir, backupKeyringFile, adminAuthSecret,
        );
        try {
          const setup = await fetch(`${baseUrl}/api/admin/auth/setup`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username: "root", password }),
          });
          expect(setup.status).toBe(201);
          const { token } = await setup.json() as { token: string };
          const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

          const integration = await fetch(`${baseUrl}/api/admin/integrations`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              id: integrationId,
              provider: "gitlab",
              name: "Mock GitLab",
              config: { baseUrl: "https://gitlab-one.invalid", gitlabMode: "self-hosted", token: mockToken },
            }),
          });
          expect(integration.status).toBe(201);
          expect(JSON.stringify(await integration.json())).not.toContain(mockToken);

          const updated = await fetch(`${baseUrl}/api/admin/integrations/${integrationId}`, {
            method: "PUT",
            headers,
            body: JSON.stringify({ name: "Updated mock GitLab", config: { token: updatedToken } }),
          });
          expect(updated.status).toBe(200);
          expect(JSON.stringify(await updated.json())).not.toContain(updatedToken);

          const second = await fetch(`${baseUrl}/api/admin/integrations`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              id: secondIntegrationId,
              provider: "gitlab",
              name: "Second mock GitLab",
              config: { baseUrl: "https://gitlab-two.invalid", gitlabMode: "self-hosted", token: secondToken },
            }),
          });
          expect(second.status).toBe(201);
          expect(JSON.stringify(await second.json())).not.toContain(secondToken);

          const settings = await fetch(`${baseUrl}/api/admin/backups/settings`, {
            method: "PUT",
            headers,
            body: JSON.stringify({ enabled: false, intervalDays: 3, timeOfDay: "01:45", retentionCount: 5 }),
          });
          expect(settings.status).toBe(200);
          const stored = await sourceStore.getIntegration(integrationId);
          expect(stored).toBeDefined();
          sourceConfigJson = stored?.configJson ?? "";
          expect(sourceConfigJson).not.toContain(mockToken);
          expect(sourceConfigJson).not.toContain(updatedToken);
          const storedConfig = JSON.parse(sourceConfigJson) as { token: string };
          expect(isVersionedEncryptedToken(storedConfig.token)).toBe(true);
          expect(decryptToken(storedConfig.token, adminAuthSecret)).toBe(updatedToken);

          const backup = await fetch(`${baseUrl}/api/admin/backups`, { method: "POST", headers });
          expect(backup.status).toBe(201);
          const { backup: created } = await backup.json() as { backup: { filename: string } };
          const download = await fetch(`${baseUrl}/api/admin/backups/${created.filename}/download`, { headers });
          expect(download.status).toBe(200);
          expect(download.headers.get("content-type")).toBe("application/octet-stream");
          const downloadedArchive = Buffer.from(await download.arrayBuffer());
          expect(downloadedArchive.subarray(0, 8).toString("ascii")).toBe("VEBACKUP");
          archivePath = join(tempDir, created.filename);
          await writeFile(archivePath, downloadedArchive, { mode: 0o600 });
        } finally {
          await closeServer(server);
        }
      } finally {
        sourceStore.close();
      }

      const restored = await restoreBackupIfRequested({
        databasePath: join(restoredDir, "state.db"),
        restoreFrom: archivePath,
        backupKeyringFile,
        adminAuthSecret,
        force: false,
      });
      expect(restored?.status).toBe("restored");
      const restoredStore = await SqliteStateStore.create(join(restoredDir, "state.db"));
      try {
        const { server, baseUrl } = await startBackupAdmin(
          restoredStore, restoredDir, join(tempDir, "restored-backups"), backupKeyringFile, adminAuthSecret,
        );
        try {
          const login = await fetch(`${baseUrl}/api/admin/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username: "root", password }),
          });
          expect(login.status).toBe(200);
          const { token } = await login.json() as { token: string };
          const response = await fetch(`${baseUrl}/api/admin/integrations/${integrationId}`, {
            headers: { authorization: `Bearer ${token}` },
          });
          expect(response.status).toBe(200);
          const body = await response.json() as { integration: { name: string; config: { token: string } } };
          expect(body.integration.name).toBe("Updated mock GitLab");
          expect(body.integration.config.token).not.toBe(mockToken);
          expect(body.integration.config.token).not.toBe(updatedToken);
          await expect(restoredStore.getIntegration(integrationId)).resolves.toMatchObject({
            configJson: sourceConfigJson,
          });
          const restoredIntegration = await restoredStore.getIntegration(integrationId);
          const restoredConfig = JSON.parse(restoredIntegration?.configJson ?? "") as { token: string };
          expect(decryptToken(restoredConfig.token, adminAuthSecret)).toBe(updatedToken);
          const second = await fetch(`${baseUrl}/api/admin/integrations/${secondIntegrationId}`, {
            headers: { authorization: `Bearer ${token}` },
          });
          expect(second.status).toBe(200);
          const secondBody = await second.json() as { integration: { name: string; config: { token: string } } };
          expect(secondBody.integration.name).toBe("Second mock GitLab");
          expect(secondBody.integration.config.token).not.toBe(secondToken);
          const settings = await fetch(`${baseUrl}/api/admin/backups/settings`, {
            headers: { authorization: `Bearer ${token}` },
          });
          expect(settings.status).toBe(200);
          await expect(settings.json()).resolves.toMatchObject({
            settings: { enabled: false, intervalDays: 3, timeOfDay: "01:45", retentionCount: 5 },
          });
          await restoredStore.updateAppSettings({ maxAgentCycles: 11 });
        } finally {
          await closeServer(server);
        }
      } finally {
        restoredStore.close();
      }

      await expect(restoreBackupIfRequested({
        databasePath: join(restoredDir, "state.db"),
        restoreFrom: archivePath,
        backupKeyringFile,
        adminAuthSecret,
        force: false,
      })).resolves.toMatchObject({ status: "already-restored" });
      const restartedStore = await SqliteStateStore.create(join(restoredDir, "state.db"));
      try {
        const { server, baseUrl } = await startBackupAdmin(
          restartedStore, restoredDir, join(tempDir, "restored-backups"), backupKeyringFile, adminAuthSecret,
        );
        try {
          const login = await fetch(`${baseUrl}/api/admin/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username: "root", password }),
          });
          expect(login.status).toBe(200);
          const { token } = await login.json() as { token: string };
          const response = await fetch(`${baseUrl}/api/admin/integrations`, {
            headers: { authorization: `Bearer ${token}` },
          });
          expect(response.status).toBe(200);
          const { integrations } = await response.json() as { integrations: Array<{ id: string }> };
          expect(integrations.map((integration) => integration.id)).toEqual(
            expect.arrayContaining([integrationId, secondIntegrationId]),
          );
          await expect(restartedStore.getAppSettings()).resolves.toMatchObject({ maxAgentCycles: 11 });
        } finally {
          await closeServer(server);
        }
      } finally {
        restartedStore.close();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
