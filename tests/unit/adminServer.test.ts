import { describe, expect, it, vi } from "vitest";
import { AddressInfo } from "node:net";
import { makeExternalChangeId, makeTaskId, makeTicketId } from "../../src/interfaces.js";
import type { AgentCycle, OAuthAppStore, IntegrationStore, StateStore, StateTransition, Task } from "../../src/interfaces.js";
import { createAdminServer } from "../../src/admin/adminServer.js";
import type { AdminProviderSummary } from "../../src/admin/adminServer.js";
import { registerBuiltinPlugins } from "../../src/plugins/init.js";

registerBuiltinPlugins();

const providerSummaries: readonly AdminProviderSummary[] = [
  {
    id: "redmine",
    name: "Redmine",
    category: "ticketing",
    enabled: true,
    configured: true,
    status: "ready",
    details: ["Polling every 30s", "Admin API key present"],
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    category: "agent",
    enabled: true,
    configured: true,
    status: "ready",
    details: ["Mode: copilot", "GitHub token configured"],
  },
];

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: makeTaskId("task-1"),
    ticketId: makeTicketId("ticket-1"),
    ticketSourceLabel: "redmine",
    ticketTitle: "Add human-readable task labels",
    ticketDescription: "Show the Redmine subject and description in the admin UI.",
    state: "IN_REVIEW",
    taskType: "code-gen",
    externalChangeId: makeExternalChangeId("I123"),
    currentPatchset: 2,
    reviewedPatchset: null,
    cycleCount: 1,
    createdAt: new Date("2026-04-07T09:00:00.000Z"),
    updatedAt: new Date("2026-04-07T10:00:00.000Z"),
    failureReason: null,
    ticketUrl: null,
    reviewUrl: null,
    displayId: null,
    ...overrides,
  };
}

function makeCycle(overrides: Partial<AgentCycle> = {}): AgentCycle {
  return {
    id: 1,
    taskId: makeTaskId("task-1"),
    cycleNumber: 1,
    result: {
      status: "success",
      modifiedFiles: ["src/index.ts"],
      summary: "Updated bootstrap",
      agentLogs: "ok",
      externalChangeId: makeExternalChangeId("I123"),
      commitSha: "abc123",
      metadata: { adapter: "mock" },
    },
    validationResult: null,
    createdAt: new Date("2026-04-07T09:30:00.000Z"),
    ...overrides,
  };
}

function makeTransition(overrides: Partial<StateTransition> = {}): StateTransition {
  return {
    id: 1,
    taskId: makeTaskId("task-1"),
    fromState: "AGENT_RUNNING",
    toState: "IN_REVIEW",
    metadata: { changeUrl: "http://localhost:8080/c/1" },
    createdAt: new Date("2026-04-07T09:31:00.000Z"),
    ...overrides,
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
    deleteTask: async () => undefined,
    deleteTaskGroup: async () => undefined,
    saveAgentCycle: async () => undefined,
    getAgentCycles: async () => [makeCycle()],
    getAgentCycleEvents: async () => [],
    getStateTransitions: async () => [makeTransition()],
    getProcessedCommentIds: async () => new Set(),
    markCommentProcessed: async () => undefined,
    getChangesForTask: async () => [],
    saveChangePerRepository: async () => undefined,
    updateChangePerRepositoryStatus: async () => undefined,
    getTaskRepositoryContext: async () => null,
    isTaskPaused: async () => false,
    ...overrides,
  } as unknown as StateStore;
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

async function readFirstChunk(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Expected response body");
  }

  const { done, value } = await reader.read();
  if (done || !value) {
    throw new Error("Expected SSE payload");
  }

  const chunk = new TextDecoder().decode(value);
  await reader.cancel();
  return chunk;
}

describe("createAdminServer", () => {
  it("serves global read-only admin status", async () => {
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
      providers: providerSummaries,
    });

    try {
      const baseUrl = await listen(server);
      const response = await fetch(`${baseUrl}/api/admin/status`);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      await expect(response.json()).resolves.toEqual({
        polling: {
          running: true,
          intervalMs: 30_000,
        },
        runtime: {
          nodeEnv: "test",
          logLevel: "info",
          maxAgentCycles: 3,
          maxRetryAttempts: 5,
        },
      });
    } finally {
      await closeServer(server);
    }
  });

  it("lists tasks and returns task details, cycles, transitions, and providers", async () => {
    const task = makeTask();
    const server = createAdminServer({
      stateStore: makeStateStore(),
      config: {
        nodeEnv: "test",
        logLevel: "debug",
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        pollingIntervalMs: 30_000,
      },
      polling: {
        isRunning: () => false,
        getIntervals: () => ({ intervalMs: 30_000 }),
      },
      providers: providerSummaries,
    });

    try {
      const baseUrl = await listen(server);

      const tasksResponse = await fetch(`${baseUrl}/api/admin/tasks`);
      expect(tasksResponse.status).toBe(200);
      await expect(tasksResponse.json()).resolves.toEqual({
        tasks: [
          expect.objectContaining({
            taskId: task.taskId,
            ticketSourceLabel: task.ticketSourceLabel,
            ticketTitle: task.ticketTitle,
            ticketDescription: task.ticketDescription,
          }),
        ],
      });

      const taskResponse = await fetch(`${baseUrl}/api/admin/tasks/${task.taskId}`);
      expect(taskResponse.status).toBe(200);
      await expect(taskResponse.json()).resolves.toEqual({
        task: expect.objectContaining({
          taskId: task.taskId,
          ticketSourceLabel: task.ticketSourceLabel,
          ticketTitle: task.ticketTitle,
          ticketDescription: task.ticketDescription,
        }),
      });

      const cyclesResponse = await fetch(`${baseUrl}/api/admin/tasks/${task.taskId}/cycles`);
      expect(cyclesResponse.status).toBe(200);
      await expect(cyclesResponse.json()).resolves.toEqual({
        cycles: [expect.objectContaining({ cycleNumber: 1 })],
      });

      const transitionsResponse = await fetch(`${baseUrl}/api/admin/tasks/${task.taskId}/transitions`);
      expect(transitionsResponse.status).toBe(200);
      await expect(transitionsResponse.json()).resolves.toEqual({
        transitions: [expect.objectContaining({ toState: "IN_REVIEW" })],
      });

      const providersResponse = await fetch(`${baseUrl}/api/admin/providers`);
      expect(providersResponse.status).toBe(200);
      await expect(providersResponse.json()).resolves.toEqual({
        providers: [
          expect.objectContaining({ id: "redmine", status: "ready" }),
          expect.objectContaining({ id: "copilot", category: "agent" }),
        ],
      });
    } finally {
      await closeServer(server);
    }
  });

  it("prefers the newer retried task when ticket tasks share the same updatedAt", async () => {
    const updatedAt = new Date("2026-04-07T10:00:00.000Z");
    const abandonedTask = makeTask({
      taskId: makeTaskId("task-abandoned"),
      state: "ABANDONED",
      createdAt: new Date("2026-04-07T09:00:00.000Z"),
      updatedAt,
      failureReason: "Agent failed after 3 cycles",
    });
    const retriedTask = makeTask({
      taskId: makeTaskId("task-retried"),
      state: "IN_REVIEW",
      createdAt: new Date("2026-04-07T10:00:00.000Z"),
      updatedAt,
      failureReason: null,
    });

    const server = createAdminServer({
      stateStore: makeStateStore({
        getAllTasks: async () => [abandonedTask, retriedTask],
      }),
      config: {
        nodeEnv: "test",
        logLevel: "debug",
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        pollingIntervalMs: 30_000,
      },
      polling: {
        isRunning: () => false,
        getIntervals: () => ({ intervalMs: 30_000 }),
      },
      providers: providerSummaries,
    });

    try {
      const baseUrl = await listen(server);
      const response = await fetch(`${baseUrl}/api/admin/tasks`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        tasks: [
          expect.objectContaining({
            taskId: retriedTask.taskId,
            state: "IN_REVIEW",
            failureReason: null,
          }),
        ],
      });
    } finally {
      await closeServer(server);
    }
  });

  it("returns 404 for an unknown task", async () => {
    const server = createAdminServer({
      stateStore: makeStateStore({ getTask: async () => null }),
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
      providers: providerSummaries,
    });

    try {
      const baseUrl = await listen(server);
      const response = await fetch(`${baseUrl}/api/admin/tasks/unknown-task`);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Task not found" });
    } finally {
      await closeServer(server);
    }
  });

  it("serves the admin dashboard shell", async () => {
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
      providers: providerSummaries,
    });

    try {
      const baseUrl = await listen(server);
      const response = await fetch(`${baseUrl}/admin`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      await expect(response.text()).resolves.toContain("Virtual Engineer");
    } finally {
      await closeServer(server);
    }
  });

  it("serves the admin dashboard at the root path /", async () => {
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
      providers: providerSummaries,
    });

    try {
      const baseUrl = await listen(server);
      const response = await fetch(baseUrl);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      await expect(response.text()).resolves.toContain("Virtual Engineer");
    } finally {
      await closeServer(server);
    }
  });

  it("protects API endpoints with HMAC-SHA256 authentication", async () => {
    const crypto = await import("crypto");
    const secret = "top-secret";
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto.createHmac("sha256", secret).update(timestamp.toString()).digest("hex");
    const token = `${timestamp}.${signature}`;

    const server = createAdminServer({
      stateStore: makeStateStore(),
      config: {
        nodeEnv: "test",
        logLevel: "info",
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        pollingIntervalMs: 30_000,
        adminAuthSecret: secret,
      },
      polling: {
        isRunning: () => true,
        getIntervals: () => ({ intervalMs: 30_000 }),
      },
      providers: providerSummaries,
    });

    try {
      const baseUrl = await listen(server);

      const unauthorizedResponse = await fetch(`${baseUrl}/api/admin/status`);
      expect(unauthorizedResponse.status).toBe(401);
      expect(unauthorizedResponse.headers.get("www-authenticate")).toContain("Bearer");

      const authorizedResponse = await fetch(`${baseUrl}/api/admin/status`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(authorizedResponse.status).toBe(200);

      const dashboardResponse = await fetch(`${baseUrl}/admin`);
      expect(dashboardResponse.status).toBe(200);
      await expect(dashboardResponse.text()).resolves.toContain("Unlock dashboard");
    } finally {
      await closeServer(server);
    }
  });

  it("allows pause action on a task via PATCH /api/admin/tasks/{taskId}/pause", async () => {
    const task = makeTask();
    const pausedTask = { ...task, state: "PAUSED" as any };
    let pauseTested = false;

    const server = createAdminServer({
      stateStore: makeStateStore({
        pauseTask: async (taskId) => {
          pauseTested = true;
          expect(taskId).toBe(task.taskId);
          return pausedTask;
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
      providers: providerSummaries,
    });

    try {
      const baseUrl = await listen(server);

      const response = await fetch(`${baseUrl}/api/admin/tasks/${task.taskId}/pause`, {
        method: "PATCH",
      });

      expect(response.status).toBe(200);
      expect(pauseTested).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("allows resume action on a task via PATCH /api/admin/tasks/{taskId}/resume", async () => {
    const task = makeTask();
    const resumedTask = { ...task, state: "IN_REVIEW" as const };
    let resumeTested = false;
    let resumeTriggeredTaskId: string | null = null;

    const server = createAdminServer({
      stateStore: makeStateStore({
        resumeTask: async (taskId) => {
          resumeTested = true;
          expect(taskId).toBe(task.taskId);
          return resumedTask;
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
      providers: providerSummaries,
      taskControl: {
        resumeTask: async (taskId) => {
          resumeTriggeredTaskId = taskId;
        },
        retryTask: async () => undefined,
      },
    });

    try {
      const baseUrl = await listen(server);

      const response = await fetch(`${baseUrl}/api/admin/tasks/${task.taskId}/resume`, {
        method: "PATCH",
      });

      expect(response.status).toBe(200);
      expect(resumeTested).toBe(true);
      expect(resumeTriggeredTaskId).toBe(task.taskId);
    } finally {
      await closeServer(server);
    }
  });

  it("allows retry action on a failed task via POST /api/admin/tasks/{taskId}/retry", async () => {
    const task = makeTask({ state: "FAILED" as const });
    const retriedTask = { ...task, state: "DETECTED" as const, cycleCount: 0, failureReason: null };
    let retryTested = false;
    let retryTriggeredTaskId: string | null = null;

    const server = createAdminServer({
      stateStore: makeStateStore({
        retryTask: async (taskId) => {
          retryTested = true;
          expect(taskId).toBe(task.taskId);
          return retriedTask;
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
      providers: providerSummaries,
      taskControl: {
        resumeTask: async () => undefined,
        retryTask: async (taskId) => {
          retryTriggeredTaskId = taskId;
        },
      },
    });

    try {
      const baseUrl = await listen(server);

      const response = await fetch(`${baseUrl}/api/admin/tasks/${task.taskId}/retry`, {
        method: "POST",
      });

      expect(response.status).toBe(200);
      expect(retryTested).toBe(true);
      expect(retryTriggeredTaskId).toBe(task.taskId);
    } finally {
      await closeServer(server);
    }
  });

  it("allows abandon action on a task via POST /api/admin/tasks/{taskId}/abandon", async () => {
    const task = makeTask();
    const abandonedTask = { ...task, state: "ABANDONED" as const };
    let abandonTested = false;

    const server = createAdminServer({
      stateStore: makeStateStore({
        abandonTask: async (taskId) => {
          abandonTested = true;
          expect(taskId).toBe(task.taskId);
          return abandonedTask;
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
      providers: providerSummaries,
    });

    try {
      const baseUrl = await listen(server);

      const response = await fetch(`${baseUrl}/api/admin/tasks/${task.taskId}/abandon`, {
        method: "POST",
      });

      expect(response.status).toBe(200);
      expect(abandonTested).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("allows deleting a terminal-state task via DELETE /api/admin/tasks/{taskId}", async () => {
    const task = makeTask({ state: "ABANDONED" });
    let deleteTested = false;

    const server = createAdminServer({
      stateStore: makeStateStore({
        deleteTaskGroup: async (taskId) => {
          deleteTested = true;
          expect(taskId).toBe(task.taskId);
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
      providers: providerSummaries,
    });

    try {
      const baseUrl = await listen(server);

      const response = await fetch(`${baseUrl}/api/admin/tasks/${task.taskId}`, {
        method: "DELETE",
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { ok: boolean };
      expect(body.ok).toBe(true);
      expect(deleteTested).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("allows deleting a non-terminal-state task (auto-abandons)", async () => {
    const task = makeTask({ state: "AGENT_RUNNING" });
    let deleteTested = false;

    const server = createAdminServer({
      stateStore: makeStateStore({
        deleteTaskGroup: async (taskId) => {
          deleteTested = true;
          expect(taskId).toBe(task.taskId);
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
      providers: providerSummaries,
    });

    try {
      const baseUrl = await listen(server);

      const response = await fetch(`${baseUrl}/api/admin/tasks/${task.taskId}`, {
        method: "DELETE",
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { ok: boolean };
      expect(body.ok).toBe(true);
      expect(deleteTested).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("requires auth for mutating endpoints when authToken is configured", async () => {
    const task = makeTask();
    const server = createAdminServer({
      stateStore: makeStateStore({
        pauseTask: async () => task,
      }),
      config: {
        nodeEnv: "test",
        logLevel: "info",
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        pollingIntervalMs: 30_000,
        adminAuthSecret: "my-secret",
      },
      polling: {
        isRunning: () => true,
        getIntervals: () => ({ intervalMs: 30_000 }),
      },
      providers: providerSummaries,
    });

    try {
      const baseUrl = await listen(server);

      const unauthorizedResponse = await fetch(`${baseUrl}/api/admin/tasks/${task.taskId}/pause`, {
        method: "PATCH",
      });

      expect(unauthorizedResponse.status).toBe(401);
    } finally {
      await closeServer(server);
    }
  });

  it("supports HMAC-SHA256 signature authentication", async () => {
    const crypto = await import("crypto");
    const secret = "my-secret";
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHmac("sha256", secret)
      .update(timestamp.toString())
      .digest("hex");
    const token = `${timestamp}.${signature}`;

    const server = createAdminServer({
      stateStore: makeStateStore(),
      config: {
        nodeEnv: "test",
        logLevel: "info",
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        pollingIntervalMs: 30_000,
        adminAuthSecret: secret,
      },
      polling: {
        isRunning: () => true,
        getIntervals: () => ({ intervalMs: 30_000 }),
      },
      providers: providerSummaries,
    });

    try {
      const baseUrl = await listen(server);

      const responseWithValidSignature = await fetch(`${baseUrl}/api/admin/status`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(responseWithValidSignature.status).toBe(200);

      const responseWithInvalidSignature = await fetch(`${baseUrl}/api/admin/status`, {
        headers: { authorization: `Bearer ${timestamp}.invalidsignature` },
      });
      expect(responseWithInvalidSignature.status).toBe(401);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects HMAC signatures older than 5 minutes", async () => {
    const crypto = await import("crypto");
    const secret = "my-secret";
    const oldTimestamp = Math.floor(Date.now() / 1000) - 400; // 6+ minutes old
    const signature = crypto
      .createHmac("sha256", secret)
      .update(oldTimestamp.toString())
      .digest("hex");
    const token = `${oldTimestamp}.${signature}`;

    const server = createAdminServer({
      stateStore: makeStateStore(),
      config: {
        nodeEnv: "test",
        logLevel: "info",
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        pollingIntervalMs: 30_000,
        adminAuthSecret: secret,
      },
      polling: {
        isRunning: () => true,
        getIntervals: () => ({ intervalMs: 30_000 }),
      },
      providers: providerSummaries,
    });

    try {
      const baseUrl = await listen(server);
      const response = await fetch(`${baseUrl}/api/admin/status`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(401);
    } finally {
      await closeServer(server);
    }
  });

  it("streams logs as Server-Sent Events via GET /api/admin/logs/stream", async () => {
    const task = makeTask();
    const server = createAdminServer({
      stateStore: makeStateStore({
        getTask: async (taskId) => (taskId === task.taskId ? task : null),
        getAgentCycles: async (taskId) => {
          if (taskId !== task.taskId) {
            return [];
          }

          return [makeCycle({
            result: {
              status: "success",
              modifiedFiles: ["src/admin/dashboard.ts"],
              summary: "Restored admin data loading",
              agentLogs: "connected to redmine\npublished gerrit change",
              externalChangeId: makeExternalChangeId("I123"),
              commitSha: "abc123",
              metadata: { adapter: "mock" },
            },
          })];
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
      providers: providerSummaries,
    });

    try {
      const baseUrl = await listen(server);

      const response = await fetch(`${baseUrl}/api/admin/logs/stream?taskId=${encodeURIComponent(task.taskId)}`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("cache-control")).toBe("no-cache");
      await expect(readFirstChunk(response)).resolves.toContain("connected to redmine");
    } finally {
      await closeServer(server);
    }
  });

  it("exposes the auth mode in the dashboard bootstrap", async () => {
    const server = createAdminServer({
      stateStore: makeStateStore(),
      config: {
        nodeEnv: "test",
        logLevel: "info",
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        pollingIntervalMs: 30_000,
        adminAuthSecret: "secret",
      },
      polling: {
        isRunning: () => true,
        getIntervals: () => ({ intervalMs: 30_000 }),
      },
      providers: providerSummaries,
    });

    try {
      const baseUrl = await listen(server);
      const response = await fetch(`${baseUrl}/admin`);

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain('"authMode":"hmac"');
    } finally {
      await closeServer(server);
    }
  });

  it("reflects live provider changes when providers is passed as a factory function", async () => {
    // Bug: providers is accepted only as a static readonly array frozen at boot.
    // When integrations are enabled/disabled at runtime the endpoint always returns stale data.
    // Fix: AdminServerDependencies.providers should also accept () => readonly AdminProviderSummary[]
    // so callers can pass a factory that is evaluated per-request.
    let currentProviders: AdminProviderSummary[] = [
      {
        id: "redmine",
        name: "Redmine",
        category: "ticketing",
        enabled: true,
        configured: true,
        status: "ready",
        details: [],
      },
    ];

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
      providers: () => currentProviders,
    });

    try {
      const baseUrl = await listen(server);

      // First call — 1 provider in the live list
      const before = await fetch(`${baseUrl}/api/admin/providers`);
      expect(before.status).toBe(200);
      const beforeBody = (await before.json()) as { providers: AdminProviderSummary[] };
      expect(beforeBody.providers).toHaveLength(1);
      expect(beforeBody.providers[0]).toMatchObject({ id: "redmine" });

      // Mutate the live provider list to simulate a runtime integration change
      currentProviders = [
        ...currentProviders,
        {
          id: "gitlab",
          name: "GitLab",
          category: "review" as const,
          enabled: true,
          configured: true,
          status: "ready" as const,
          details: [],
        },
      ];

      // Second call — must reflect the updated list without a server restart
      const after = await fetch(`${baseUrl}/api/admin/providers`);
      expect(after.status).toBe(200);
      const afterBody = (await after.json()) as { providers: AdminProviderSummary[] };
      expect(afterBody.providers).toHaveLength(2);
      expect(afterBody.providers[1]).toMatchObject({ id: "gitlab" });
    } finally {
      await closeServer(server);
    }
  });

  it("lists integrations even when legacy rows expose non-Date timestamps", async () => {
    const integrationStore: IntegrationStore = {
      getIntegrations: async () => [{
        id: "gitlab-local",
        type: "gitlab-issue",
        name: "GitLab Local",
        configJson: JSON.stringify({
          baseUrl: "http://localhost:8929",
          projectId: "root/demo-gitlab",
          token: "glpat-secret",
        }),
        enabled: false,
        createdAt: 1776275823 as unknown as Date,
        updatedAt: "2026-04-14 20:15:57" as unknown as Date,
      }],
      getIntegration: async () => null,
      upsertIntegration: async () => {
        throw new Error("not implemented");
      },
      deleteIntegration: async () => undefined,
      setIntegrationEnabled: async () => {
        throw new Error("not implemented");
      },
      countIntegrationReferences: async () => 0,
    };

    const server = createAdminServer({
      stateStore: makeStateStore(),
      integrationStore,
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
      providers: providerSummaries,
    });

    try {
      const baseUrl = await listen(server);
      const response = await fetch(`${baseUrl}/api/admin/integrations`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        integrations: [
          {
            id: "gitlab-local",
            type: "gitlab-issue",
            category: "ticketing",
            capabilities: ["ticketing", "oauth", "discovery"],
            name: "GitLab Local",
            enabled: false,
            active: false,
            config: {
              authMode: "pat",
              baseUrl: "http://localhost:8929",
              projectId: "root/demo-gitlab",
              token: "********",
            },
            createdAt: "2026-04-15T17:57:03.000Z",
            updatedAt: "2026-04-15T00:15:57.000Z",
            discoveredAt: null,
            discoveredResources: null,
            discoverySupported: true,
            streamEventsSupported: false,
          },
        ],
      });
    } finally {
      await closeServer(server);
    }
  });

  it("manages OAuth app registry entries by provider and base URL", async () => {
    const oAuthAppStore: OAuthAppStore = {
      listOAuthApps: async () => [{
        provider: "gitlab",
        baseUrl: "https://gitlab.example.com",
        clientId: "gitlab-client-id",
        createdAt: new Date("2026-05-20T09:00:00.000Z"),
        updatedAt: new Date("2026-05-20T09:05:00.000Z"),
      }],
      getOAuthApp: async (provider: string, baseUrl: string) => provider === "gitlab" && baseUrl === "https://gitlab.example.com"
        ? {
            provider: "gitlab",
            baseUrl: "https://gitlab.example.com",
            clientId: "gitlab-client-id",
            createdAt: new Date("2026-05-20T09:00:00.000Z"),
            updatedAt: new Date("2026-05-20T09:05:00.000Z"),
          }
        : null,
      upsertOAuthApp: async ({ provider, baseUrl, clientId }) => ({
        provider,
        baseUrl,
        clientId,
        createdAt: new Date("2026-05-20T09:00:00.000Z"),
        updatedAt: new Date("2026-05-20T09:05:00.000Z"),
      }),
      deleteOAuthApp: async () => undefined,
    };

    const server = createAdminServer({
      stateStore: makeStateStore(),
      oAuthAppStore,
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
      providers: providerSummaries,
    });

    try {
      const baseUrl = await listen(server);

      const listResponse = await fetch(`${baseUrl}/api/admin/oauth-apps`);
      expect(listResponse.status).toBe(200);
      await expect(listResponse.json()).resolves.toEqual({
        apps: [
          {
            provider: "gitlab",
            baseUrl: "https://gitlab.example.com",
            clientId: "gitlab-client-id",
            createdAt: "2026-05-20T09:00:00.000Z",
            updatedAt: "2026-05-20T09:05:00.000Z",
          },
        ],
      });

      const createResponse = await fetch(`${baseUrl}/api/admin/oauth-apps`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "gitlab", baseUrl: "https://gitlab.example.com/", clientId: "new-client-id" }),
      });
      expect(createResponse.status).toBe(201);
      await expect(createResponse.json()).resolves.toEqual({
        app: {
          provider: "gitlab",
          baseUrl: "https://gitlab.example.com",
          clientId: "new-client-id",
          createdAt: "2026-05-20T09:00:00.000Z",
          updatedAt: "2026-05-20T09:05:00.000Z",
        },
      });

      const resolveResponse = await fetch(`${baseUrl}/api/admin/oauth-apps/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "gitlab", baseUrl: "https://gitlab.example.com/" }),
      });
      expect(resolveResponse.status).toBe(200);
      await expect(resolveResponse.json()).resolves.toEqual({
        app: {
          provider: "gitlab",
          baseUrl: "https://gitlab.example.com",
          clientId: "gitlab-client-id",
          createdAt: "2026-05-20T09:00:00.000Z",
          updatedAt: "2026-05-20T09:05:00.000Z",
        },
      });
    } finally {
      await closeServer(server);
    }
  });

  it("requires an explicit OAuth app store for registry routes", async () => {
    const duckTypedIntegrationStore = {
      getIntegration: async () => null,
      listOAuthApps: async () => [{
        provider: "gitlab",
        baseUrl: "https://gitlab.example.com",
        clientId: "gitlab-client-id",
        createdAt: new Date("2026-05-20T09:00:00.000Z"),
        updatedAt: new Date("2026-05-20T09:05:00.000Z"),
      }],
      getOAuthApp: async () => null,
      upsertOAuthApp: async () => ({
        provider: "gitlab",
        baseUrl: "https://gitlab.example.com",
        clientId: "gitlab-client-id",
        createdAt: new Date("2026-05-20T09:00:00.000Z"),
        updatedAt: new Date("2026-05-20T09:05:00.000Z"),
      }),
      deleteOAuthApp: async () => undefined,
    } as unknown as IntegrationStore;

    const server = createAdminServer({
      stateStore: makeStateStore(),
      integrationStore: duckTypedIntegrationStore,
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
      providers: providerSummaries,
    });

    try {
      const baseUrl = await listen(server);
      const response = await fetch(`${baseUrl}/api/admin/oauth-apps`);

      expect(response.status).toBe(501);
      await expect(response.json()).resolves.toEqual({
        error: "OAuth app registry is not available",
      });
    } finally {
      await closeServer(server);
    }
  });

  it("proxies GitLab uploads with Bearer auth", async () => {
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url.startsWith("http://127.0.0.1:")) {
        return realFetch(input, init);
      }
      return new Response("png-bytes", {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const pluginManager = {
      getActiveIntegrationsByType(type: string) {
        if (type === "gitlab-merge-request") {
          return [{
            id: "gitlab-mr",
            type: "gitlab-merge-request",
            name: "GitLab MR",
            configJson: JSON.stringify({
              baseUrl: "https://gitlab.example.com",
              projectId: "group/repo",
              token: "oauth-token",
            }),
            enabled: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          }];
        }
        return [];
      },
    };

    const server = createAdminServer({
      stateStore: makeStateStore(),
      pluginManager: pluginManager as never,
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
      providers: providerSummaries,
    });

    try {
      const baseUrl = await listen(server);
      const response = await fetch(
        `${baseUrl}/api/admin/img-proxy?url=${encodeURIComponent("https://gitlab.example.com/uploads/abcdef1234567890/image.png")}`
      );

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://gitlab.example.com/api/v4/projects/group%2Frepo/uploads/abcdef1234567890/image.png",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer oauth-token",
          }),
        })
      );
    } finally {
      vi.unstubAllGlobals();
      await closeServer(server);
    }
  });

  it("marks integration activity by exact integration id", async () => {
    const integrationStore: IntegrationStore = {
      getIntegrations: async () => [
        {
          id: "gerrit-a",
          type: "gerrit",
          name: "Gerrit A",
          configJson: JSON.stringify({
            sshHost: "gerrit-a.example.com",
            sshPort: 29418,
            sshUser: "ve",
            sshKeyPath: "/keys/a",
          }),
          enabled: true,
          createdAt: new Date("2026-04-15T10:00:00.000Z"),
          updatedAt: new Date("2026-04-15T10:05:00.000Z"),
        },
        {
          id: "gerrit-b",
          type: "gerrit",
          name: "Gerrit B",
          configJson: JSON.stringify({
            sshHost: "gerrit-b.example.com",
            sshPort: 29418,
            sshUser: "ve",
            sshKeyPath: "/keys/b",
          }),
          enabled: false,
          createdAt: new Date("2026-04-15T11:00:00.000Z"),
          updatedAt: new Date("2026-04-15T11:05:00.000Z"),
        },
      ],
      getIntegration: async () => null,
      upsertIntegration: async () => {
        throw new Error("not implemented");
      },
      deleteIntegration: async () => undefined,
      setIntegrationEnabled: async () => {
        throw new Error("not implemented");
      },
      countIntegrationReferences: async () => 0,
    };

    const pluginManager = {
      isIntegrationActive: (integrationId: string) => integrationId === "gerrit-a",
    } as unknown as import("../../src/plugins/pluginManager.js").PluginManager;

    const server = createAdminServer({
      stateStore: makeStateStore(),
      integrationStore,
      pluginManager,
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
      providers: providerSummaries,
    });

    try {
      const baseUrl = await listen(server);
      const response = await fetch(`${baseUrl}/api/admin/integrations`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        integrations: [
          expect.objectContaining({ id: "gerrit-a", active: true }),
          expect.objectContaining({ id: "gerrit-b", active: false }),
        ],
      });
    } finally {
      await closeServer(server);
    }
  });
});

describe("SSE endpoints", () => {
  it("GET /api/admin/logs/stream sets SSE headers and keeps connection open", async () => {
    const server = createAdminServer({
      stateStore: makeStateStore(),
      config: {
        nodeEnv: "test",
        logLevel: "info",
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        pollingIntervalMs: 30000,
      },
      polling: { isRunning: () => true, getIntervals: () => ({ intervalMs: 30000 }) },
      providers: providerSummaries,
    });
    const base = await listen(server);
    try {
      const ac = new AbortController();
      const response = await fetch(`${base}/api/admin/logs/stream?taskId=task-1`, { signal: ac.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      ac.abort();
    } finally {
      await closeServer(server);
    }
  });

  it("GET /api/admin/logs/stream forwards agentLogBus events for matching taskId", async () => {
    const { agentLogBus: bus } = await import("../../src/agents/copilotAdapter.js");
    const server = createAdminServer({
      stateStore: makeStateStore({ getAgentCycles: async () => [] }),
      config: {
        nodeEnv: "test",
        logLevel: "info",
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        pollingIntervalMs: 30000,
      },
      polling: { isRunning: () => true, getIntervals: () => ({ intervalMs: 30000 }) },
      providers: providerSummaries,
    });
    const base = await listen(server);
    try {
      const ac = new AbortController();
      const response = await fetch(`${base}/api/admin/logs/stream?taskId=task-1`, { signal: ac.signal });
      const reader = response.body?.getReader();

      const event = {
        type: "tool.execution_start",
        timestamp: new Date().toISOString(),
        data: { tool: "readFile" },
        taskId: "task-1",
        cycleNumber: 1,
      };
      // Emit after reader is obtained to ensure subscription is active
      await new Promise((r) => setTimeout(r, 10));
      bus.emit("event", event);

      const { value } = await reader!.read();
      const text = new TextDecoder().decode(value);
      ac.abort();
      expect(text).toContain("tool.execution_start");
      expect(text).toContain("readFile");
    } finally {
      await closeServer(server);
    }
  });

  it("GET /api/admin/logs/stream serializes live stderr line events", async () => {
    const { agentLogBus: bus } = await import("../../src/agents/copilotAdapter.js");
    const server = createAdminServer({
      stateStore: makeStateStore({ getAgentCycles: async () => [] }),
      config: {
        nodeEnv: "test",
        logLevel: "info",
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        pollingIntervalMs: 30000,
      },
      polling: { isRunning: () => true, getIntervals: () => ({ intervalMs: 30000 }) },
      providers: providerSummaries,
    });
    const base = await listen(server);
    try {
      const ac = new AbortController();
      const response = await fetch(`${base}/api/admin/logs/stream?taskId=task-1`, { signal: ac.signal });
      const reader = response.body?.getReader();

      await new Promise((r) => setTimeout(r, 10));
      bus.emit("event", {
        type: "stderr.line",
        timestamp: new Date().toISOString(),
        data: { line: "worker started" },
        taskId: "task-1",
        cycleNumber: 1,
      });

      const { value } = await reader!.read();
      const text = new TextDecoder().decode(value);
      ac.abort();
      expect(text).toContain("worker started");
    } finally {
      await closeServer(server);
    }
  });

  it("GET /api/admin/logs/stream serializes historical structured agent events", async () => {
    const task = makeTask();
    const server = createAdminServer({
      stateStore: makeStateStore({
        getTask: async (taskId) => (taskId === task.taskId ? task : null),
        getAgentCycles: async () => [makeCycle({
          result: {
            status: "success",
            modifiedFiles: [],
            summary: "Structured-only",
            agentLogs: "",
            agentEvents: [
              {
                type: "tool.execution_start",
                timestamp: "2026-04-07T09:30:00.000Z",
                data: { tool: "readFile" },
                taskId: task.taskId,
                cycleNumber: 1,
              },
            ],
            metadata: { adapter: "copilot-sdk" },
          },
        })],
      }),
      config: {
        nodeEnv: "test",
        logLevel: "info",
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        pollingIntervalMs: 30000,
      },
      polling: { isRunning: () => true, getIntervals: () => ({ intervalMs: 30000 }) },
      providers: providerSummaries,
    });
    const base = await listen(server);
    try {
      const response = await fetch(`${base}/api/admin/logs/stream?taskId=${encodeURIComponent(task.taskId)}`);
      const text = await readFirstChunk(response);
      expect(text).toContain("tool.execution_start");
      expect(text).toContain("readFile");
    } finally {
      await closeServer(server);
    }
  });

  it("GET /api/admin/events/stream sets SSE headers and emits tasks event", async () => {
    const server = createAdminServer({
      stateStore: makeStateStore(),
      config: {
        nodeEnv: "test",
        logLevel: "info",
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        pollingIntervalMs: 30000,
      },
      polling: { isRunning: () => true, getIntervals: () => ({ intervalMs: 30000 }) },
      providers: providerSummaries,
    });
    const base = await listen(server);
    try {
      const ac = new AbortController();
      const response = await fetch(`${base}/api/admin/events/stream`, { signal: ac.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body?.getReader();
      const { value } = await reader!.read();
      const text = new TextDecoder().decode(value);
      ac.abort();
      expect(text).toContain("event: tasks");
    } finally {
      await closeServer(server);
    }
  });
});
