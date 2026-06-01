import { describe, expect, it } from "vitest";
import { AddressInfo } from "node:net";
import { createAdminServer } from "../../src/admin/adminServer.js";
import { makeTaskId, makeTicketId } from "../../src/interfaces.js";
import type { Integration, StateStore, Task } from "../../src/interfaces.js";
import { registerBuiltinPlugins } from "../../src/plugins/init.js";

function makeTask(): Task {
  return {
    taskId: makeTaskId("task-behavior-1"),
    ticketId: makeTicketId("ticket-behavior-1"),
    ticketSourceLabel: "redmine",
    ticketTitle: "Behavior ticket",
    ticketDescription: "Ticket used for admin server behavior tests",
    state: "IN_REVIEW",
    taskType: "code-gen",
    externalChangeId: null,
    currentPatchset: 0,
    reviewedPatchset: null,
    cycleCount: 0,
    createdAt: new Date("2026-04-07T09:00:00.000Z"),
    updatedAt: new Date("2026-04-07T09:00:00.000Z"),
    failureReason: null,
    ticketUrl: null,
    reviewUrl: null,
    displayId: null,
  };
}

function makeStateStore(overrides: Partial<StateStore> = {}): StateStore {
  const task = makeTask();

  return {
    createTask: async () => task,
    getTask: async () => task,
    getTaskByTicketId: async () => task,
    getActiveTasks: async () => [task],
    getAllTasks: async () => [task],
    getFailedAttemptCount: async () => 0,
    transition: async () => task,
    updateGerritChangeId: async () => undefined,
    incrementCycle: async () => 1,
    setFailureReason: async () => undefined,
    pauseTask: async () => task,
    resumeTask: async () => task,
    retryTask: async () => task,
    abandonTask: async () => task,
    saveAgentCycle: async () => undefined,
    getAgentCycles: async () => [],
    getStateTransitions: async () => [],
    getProcessedCommentIds: async () => new Set(),
      markCommentProcessed: async () => undefined,
      getAgentCycleEvents: async () => [],
      getChangesForTask: async () => [],
      saveChangePerRepository: async () => undefined,
      updateChangePerRepositoryStatus: async () => undefined,
      orphanExcessChanges: async () => 0,
      getTaskRepositoryContext: async () => null,
      isTaskPaused: async () => false,        deleteTask: async () => undefined,
        deleteTaskGroup: async () => undefined,    ...overrides,
  } as unknown as StateStore;
}

function makeIntegrationStore(overrides: Partial<Record<"getIntegration" | "getIntegrations", unknown>> = {}) {
  const integration: Integration = {
    id: "gerrit-1",
    type: "gerrit",
    name: "Gerrit Primary",
    configJson: JSON.stringify({ sshHost: "gerrit.example.com", sshUser: "ve", sshPort: 29418, sshKeyPath: "/tmp/id_rsa" }),
    enabled: true,
    createdAt: new Date("2026-04-07T09:00:00.000Z"),
    updatedAt: new Date("2026-04-07T09:00:00.000Z"),
  };

  return {
    getIntegrations: async () => [integration],
    getIntegration: async (id: string) => (id === integration.id ? integration : null),
    ...overrides,
  } as unknown;
}

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

describe("createAdminServer behavior", () => {
  it("returns 405 for unsupported methods", async () => {
    const server = createAdminServer({
      stateStore: makeStateStore(),
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
      providers: [],
    });

    try {
      const baseUrl = await listen(server);
      const response = await fetch(`${baseUrl}/api/admin/status`, { method: "POST" });
      expect(response.status).toBe(405);
      await expect(response.json()).resolves.toEqual({ error: "Method not allowed" });
    } finally {
      await closeServer(server);
    }
  });

  it("returns 404 for unknown routes", async () => {
    const server = createAdminServer({
      stateStore: makeStateStore(),
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
      providers: [],
    });

    try {
      const baseUrl = await listen(server);
      const response = await fetch(`${baseUrl}/api/admin/does-not-exist`);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Not found" });
    } finally {
      await closeServer(server);
    }
  });

  it("returns 500 when the backing store throws", async () => {
    const server = createAdminServer({
      stateStore: makeStateStore({
        getAllTasks: async () => {
          throw new Error("boom");
        },
      }),
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
      providers: [],
    });

    try {
      const baseUrl = await listen(server);
      const response = await fetch(`${baseUrl}/api/admin/tasks`);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Internal server error" });
    } finally {
      await closeServer(server);
    }
  });

  it("includes Gerrit stream status in integration responses", async () => {
    registerBuiltinPlugins();

    const server = createAdminServer({
      stateStore: makeStateStore(),
      integrationStore: makeIntegrationStore() as never,
      pluginManager: {
        isIntegrationActive: () => true,
      } as never,
      integrationStreams: {
        getStatus: () => ({
          state: "connected",
          reconnectCount: 2,
          lastEventType: "comment-added",
          lastEventAt: "2026-04-07T09:00:00.000Z",
          lastError: null,
        }),
      },
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
      providers: [],
    });

    try {
      const baseUrl = await listen(server);
      const response = await fetch(`${baseUrl}/api/admin/integrations/gerrit-1`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        integration: {
          id: "gerrit-1",
          streamStatus: {
            state: "connected",
            reconnectCount: 2,
            lastEventType: "comment-added",
          },
        },
      });
    } finally {
      await closeServer(server);
    }
  });
});
