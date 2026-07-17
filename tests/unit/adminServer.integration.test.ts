import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { createAdminServer } from "../../src/admin/adminServer.js";
import { makeExternalChangeId, makeTaskId, makeTicketId } from "../../src/interfaces.js";

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
});
