/**
 * Phase 6 — Orchestrator concurrency gating tests.
 *
 * Verifies that the orchestrator integrates with the in-memory
 * {@link ConcurrencyTracker} so that:
 *  - `startTaskForProject` is short-circuited when limits are reached,
 *  - terminal transitions release the slot (try/finally),
 *  - exceptions still release,
 *  - legacy tasks (no projectId) are not gated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import { Orchestrator, type ProjectModeDeps } from "../../src/orchestrator/orchestrator.js";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { createConcurrencyTracker, type ConcurrencyTracker } from "../../src/orchestrator/concurrencyTracker.js";
import type { ProjectRecord, TicketId } from "../../src/interfaces.js";

function tempDb(): string {
  return join(tmpdir(), `ve-orch-conc-${randomUUID()}.db`);
}

const mockWorkspace = {
  createWorkspace: vi.fn(async (taskId: string) => ({
    taskId,
    hostWorkspacePath: "/tmp/x",
    containerId: "c",
    volumeName: "v",
  })),
  cloneRepo: vi.fn(async () => ({ success: false, error: "boom" })), // force FAILED
  runAgent: vi.fn(),
  destroyWorkspace: vi.fn(async () => undefined),
};

function buildOrchestrator(
  store: SqliteStateStore,
  tracker: ConcurrencyTracker | undefined
): Orchestrator {
  const projectMode: ProjectModeDeps = {
    projectStore: {
      getProjectById: (id) => store.getProjectById(id),
      listProjectPushTargets: (id) => store.listProjectPushTargets(id),
      getProjectTicketSource: (id) => store.getProjectTicketSource(id),
      getProjectReviewConfig: (id) => store.getProjectReviewConfig(id),
      getAgentById: (id) => store.getAgentById(id),
    },
    pluginManager: {
      getConnectorForIntegration: <T,>() => null as T | null,
    },
    ...(tracker !== undefined ? { concurrencyTracker: tracker } : {}),
  };
  return new Orchestrator(
    {
      maxAgentCycles: 3,
      maxRetryAttempts: 5,
      agentTimeoutMs: 1000,
      gitAuthorName: "VE",
      gitAuthorEmail: "ve@x",
      agentContainerImage: "img",
    },
    store,
    mockWorkspace as never,
    undefined,
    store,
    projectMode
  );
}

async function seedProjectAndAgent(store: SqliteStateStore, opts: {
  agentMax?: number;
  projectMax?: number;
} = {}): Promise<ProjectRecord> {
  const agent = await store.createAgent({
    name: "A",
    type: "coding",
    modelConfigJson: "{}",
    maxConcurrent: opts.agentMax ?? 5,
    enabled: true,
  });
  return store.createProject({
    name: "P",
    type: "coding",
    agentId: agent.id,
    maxConcurrent: opts.projectMax ?? 5,
    enabled: true,
  });
}

describe("Orchestrator — Phase 6 concurrency gating", () => {
  let store: SqliteStateStore;
  let dbPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    dbPath = tempDb();
    store = await SqliteStateStore.create(dbPath);
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dbPath, { force: true });
  });

  it("startTaskForProject defers when per-project limit is reached and does not create a task row", async () => {
    const project = await seedProjectAndAgent(store, { projectMax: 1 });
    const tracker = createConcurrencyTracker({
      projectStore: { getProjectById: (id) => store.getProjectById(id) },
      agentStore: { getAgentById: (id) => store.getAgentById(id) },
      globalLimitProvider: async () => null,
    });
    // Saturate the project's slot externally.
    expect(await tracker.acquire(project.id, project.agentId)).toBe(true);

    const orch = buildOrchestrator(store, tracker);
    await orch.startTaskForProject(
      { id: "ticket-1", subject: "x", description: "" },
      project,
      "redmine:int-1"
    );

    const existing = await store.getTaskByTicketId("ticket-1" as TicketId);
    expect(existing).toBeNull();
    // Snapshot still shows the externally-acquired slot, untouched.
    expect(tracker.snapshot().perProject[project.id]).toBe(1);
  });

  it("startTaskForProject acquires and the slot is released after a FAILED workflow", async () => {
    const project = await seedProjectAndAgent(store, { projectMax: 1 });
    const tracker = createConcurrencyTracker({
      projectStore: { getProjectById: (id) => store.getProjectById(id) },
      agentStore: { getAgentById: (id) => store.getAgentById(id) },
      globalLimitProvider: async () => null,
    });
    const orch = buildOrchestrator(store, tracker);

    // cloneRepo mock returns failure → workflow ends in FAILED via handleFatalError.
    await orch.startTaskForProject(
      { id: "ticket-2", subject: "x", description: "" },
      project,
      "redmine:int-1"
    );

    const task = await store.getTaskByTicketId("ticket-2" as TicketId);
    expect(task).not.toBeNull();
    expect(task!.state).toBe("FAILED");
    // Slot was acquired during the run, then released on FAILED transition.
    expect(tracker.snapshot()).toEqual({ global: 0, perProject: {}, perAgent: {} });
  });

  it("acquires up to the limit then defers further startTaskForProject calls", async () => {
    const project = await seedProjectAndAgent(store, { projectMax: 1, agentMax: 1 });
    const tracker = createConcurrencyTracker({
      projectStore: { getProjectById: (id) => store.getProjectById(id) },
      agentStore: { getAgentById: (id) => store.getAgentById(id) },
      globalLimitProvider: async () => null,
    });
    const orch = buildOrchestrator(store, tracker);

    // First task runs to FAILED and releases its slot. We simulate "concurrent"
    // pressure by externally holding a slot before the second call.
    expect(await tracker.acquire(project.id, project.agentId)).toBe(true);
    await orch.startTaskForProject(
      { id: "blocked-1", subject: "x", description: "" },
      project,
      "redmine:int-1"
    );
    expect(await store.getTaskByTicketId("blocked-1" as TicketId)).toBeNull();

    // Release the slot and retry: now the task should be created.
    tracker.release(project.id, project.agentId);
    await orch.startTaskForProject(
      { id: "ok-1", subject: "x", description: "" },
      project,
      "redmine:int-1"
    );
    const task = await store.getTaskByTicketId("ok-1" as TicketId);
    expect(task).not.toBeNull();
    expect(task!.state).toBe("FAILED"); // workflow runs through to terminal
    // After FAILED, slot is released.
    expect(tracker.snapshot().perProject[project.id]).toBeFalsy();
  });

  it("orchestrator without a tracker performs no gating (backward compat)", async () => {
    const project = await seedProjectAndAgent(store, { projectMax: 1 });
    const orch = buildOrchestrator(store, undefined);

    await orch.startTaskForProject(
      { id: "nogate-1", subject: "x", description: "" },
      project,
      "redmine:int-1"
    );
    const task = await store.getTaskByTicketId("nogate-1" as TicketId);
    expect(task).not.toBeNull();
    expect(task!.state).toBe("FAILED");
  });

  it("ABANDONED terminal release works the same as FAILED", async () => {
    const project = await seedProjectAndAgent(store, { projectMax: 2 });
    const tracker = createConcurrencyTracker({
      projectStore: { getProjectById: (id) => store.getProjectById(id) },
      agentStore: { getAgentById: (id) => store.getAgentById(id) },
      globalLimitProvider: async () => null,
    });
    const orch = buildOrchestrator(store, tracker);

    // Manually seed a project-mode task and pre-populate the held-slot map
    // (mimicking what `startTaskForProject` would have done if its workflow
    // had not yet completed).
    const taskId = `task-${randomUUID()}`;
    const task = await store.createTask(
      taskId as never,
      "ab-1" as TicketId,
      "x",
      "",
      "redmine:int-1",
      undefined
    );
    await store.setTaskProjectId(task.taskId, project.id);
    expect(await tracker.acquire(project.id, project.agentId)).toBe(true);
    (orch as unknown as { heldSlots: Map<string, unknown> }).heldSlots.set(task.taskId, { projectId: project.id, agentId: project.agentId });

    // Move task to ABANDONED then run the workflow — the finally block must
    // detect the terminal state and release the slot.
    await store.transition(task.taskId, "CONTEXT_BUILDING");
    await store.transition(task.taskId, "AGENT_RUNNING");
    await store.transition(task.taskId, "ABANDONED");
    const refreshed = await store.getTask(task.taskId);
    await (orch as unknown as { runWorkflow: (t: unknown) => Promise<void> }).runWorkflow(refreshed!);
    expect(tracker.snapshot()).toEqual({ global: 0, perProject: {}, perAgent: {} });
  });
});
