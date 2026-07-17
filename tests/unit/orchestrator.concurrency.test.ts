/**
 * Phase 6 — Orchestrator concurrency gating tests.
 *
 * Verifies that the orchestrator integrates with the in-memory
 * {@link ConcurrencyTracker} so that:
 *  - tasks are created even when a run slot is temporarily unavailable,
 *  - AGENT_RUNNING retries can resume once a run slot is free,
 *  - run slots are released after cycle completion,
 *  - legacy tasks (no projectId) are not gated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { Orchestrator, type ProjectModeDeps } from "../../src/orchestrator/orchestrator.js";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { createConcurrencyTracker, type ConcurrencyTracker } from "../../src/orchestrator/concurrencyTracker.js";
import type { ProjectRecord, Task, TicketId } from "../../src/interfaces.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

function tempDb(): string {
  return tempDatabasePath("ve-orch-conc");
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
    enabled: true,
  });
}

describe("Orchestrator — Phase 6 concurrency gating", () => {
  let store: SqliteStateStore;

  beforeEach(async () => {
    vi.clearAllMocks();
    store = await SqliteStateStore.create(tempDb());
  });

  afterEach(() => {
    store.close();
  });

  it("startTaskForProject still creates the task when tracker already has activity", async () => {
    const project = await seedProjectAndAgent(store, { agentMax: 1 });
    const tracker = createConcurrencyTracker({
      agentStore: { getAgentById: (id) => store.getAgentById(id) },
    });
    // Saturate the integration slot externally.
    expect(await tracker.acquire(project.id, project.agentId)).toBe(true);

    const orch = buildOrchestrator(store, tracker);
    await orch.startTaskForProject(
      { id: "ticket-1", subject: "x", description: "" },
      project,
      "redmine:int-1"
    );

    const existing = await store.getTaskByTicketId("ticket-1" as TicketId);
    expect(existing).not.toBeNull();
    expect(tracker.snapshot().global).toBeGreaterThanOrEqual(0);
  });

  it("continueTask remains safe after a prior startTaskForProject run", async () => {
    const project = await seedProjectAndAgent(store, { agentMax: 1 });
    const tracker = createConcurrencyTracker({
      agentStore: { getAgentById: (id) => store.getAgentById(id) },
    });
    expect(await tracker.acquire(project.id, project.agentId)).toBe(true);

    const orch = buildOrchestrator(store, tracker);
    await orch.startTaskForProject(
      { id: "ticket-2", subject: "x", description: "" },
      project,
      "redmine:int-1"
    );

    const first = await store.getTaskByTicketId("ticket-2" as TicketId);
    expect(first).not.toBeNull();

    tracker.release(project.id, project.agentId);
    await orch.continueTask(first!.taskId);

    const task = await store.getTaskByTicketId("ticket-2" as TicketId);
    expect(task).not.toBeNull();
    expect(task!.state).toBe("FAILED");
    // Slot was acquired for the cycle and released after completion.
    expect(tracker.snapshot()).toEqual({ global: 0, perProject: {}, perAgent: {} });
  });

  it("orchestrator without a tracker performs no gating (backward compat)", async () => {
    const project = await seedProjectAndAgent(store);
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

  it("ABANDONED state does not leak a slot", async () => {
    const project = await seedProjectAndAgent(store);
    const tracker = createConcurrencyTracker({
      agentStore: { getAgentById: (id) => store.getAgentById(id) },
    });
    const orch = buildOrchestrator(store, tracker);

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

    // Move task to ABANDONED then run the workflow — no slot should be acquired.
    await store.transition(task.taskId, "CONTEXT_BUILDING");
    await store.transition(task.taskId, "AGENT_RUNNING");
    await store.transition(task.taskId, "ABANDONED");
    const refreshed = await store.getTask(task.taskId);
    await (orch as unknown as { runWorkflow: (t: unknown) => Promise<void> }).runWorkflow(refreshed!);
    expect(tracker.snapshot()).toEqual({ global: 0, perProject: {}, perAgent: {} });
  });

  it("resumeStalledCodeGenTask advances a CONTEXT_BUILDING task once the slot frees up", async () => {
    const project = await seedProjectAndAgent(store, { agentMax: 1 });
    const tracker = createConcurrencyTracker({
      agentStore: { getAgentById: (id) => store.getAgentById(id) },
    });
    const orch = buildOrchestrator(store, tracker);

    const taskId = `task-${randomUUID()}`;
    const task = await store.createTask(
      taskId as never,
      "stall-1" as TicketId,
      "x",
      "",
      "redmine:int-1",
      undefined
    );
    await store.setTaskProjectId(task.taskId, project.id);
    await store.transition(task.taskId, "CONTEXT_BUILDING");

    // Slot saturated externally → resume defers without advancing the task.
    expect(await tracker.acquire(project.id, project.agentId)).toBe(true);
    await orch.resumeStalledCodeGenTask(task.taskId);
    expect((await store.getTask(task.taskId))!.state).toBe("CONTEXT_BUILDING");

    // Free the slot → next resume drives the cycle to completion (FAILED here
    // because the mock workspace cannot clone), and releases the slot.
    tracker.release(project.id, project.agentId);
    await orch.resumeStalledCodeGenTask(task.taskId);
    expect((await store.getTask(task.taskId))!.state).toBe("FAILED");
    expect(tracker.snapshot()).toEqual({ global: 0, perProject: {}, perAgent: {} });
  });

  it("does not drive the same stalled task concurrently", async () => {
    const project = await seedProjectAndAgent(store);
    const orch = buildOrchestrator(store, undefined);
    const task = await store.createTask(
      `task-${randomUUID()}` as never,
      "stall-concurrent" as TicketId,
      "x",
      "",
      "redmine:int-1",
      undefined
    );
    await store.setTaskProjectId(task.taskId, project.id);
    await store.transition(task.taskId, "CONTEXT_BUILDING");
    const stalledTask = (await store.getTask(task.taskId))!;

    let finishFirstRun: (() => void) | undefined;
    const firstRunBlocked = new Promise<void>((resolve) => {
      finishFirstRun = resolve;
    });
    const runFromContextBuilding = vi.fn().mockReturnValue(firstRunBlocked);
    const internal = orch as unknown as {
      runWorkflow(task: Task): Promise<void>;
      runFromContextBuilding(task: Task): Promise<void>;
    };
    internal.runFromContextBuilding = runFromContextBuilding;

    const firstRun = internal.runWorkflow(stalledTask);
    await internal.runWorkflow(stalledTask);

    expect(runFromContextBuilding).toHaveBeenCalledTimes(1);
    finishFirstRun!();
    await firstRun;
  });

  it("resumeStalledCodeGenTask is a no-op for non-stalled or code-review tasks", async () => {
    const project = await seedProjectAndAgent(store);
    const orch = buildOrchestrator(store, undefined);

    // IN_REVIEW code-gen task must not be re-driven by the stalled poll.
    const taskId = `task-${randomUUID()}`;
    const task = await store.createTask(
      taskId as never,
      "noop-1" as TicketId,
      "x",
      "",
      "redmine:int-1",
      undefined
    );
    await store.setTaskProjectId(task.taskId, project.id);
    await store.transition(task.taskId, "CONTEXT_BUILDING");
    await store.transition(task.taskId, "AGENT_RUNNING");
    await store.transition(task.taskId, "IN_REVIEW");

    await orch.resumeStalledCodeGenTask(task.taskId);
    // State is unchanged — the method returned early without running a cycle.
    expect((await store.getTask(task.taskId))!.state).toBe("IN_REVIEW");
  });
});
