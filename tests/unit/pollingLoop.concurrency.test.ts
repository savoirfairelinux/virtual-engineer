/**
 * Phase 6 — PollingLoop concurrency-aware short-circuit tests.
 *
 * Verifies that `pollProjectTickets` defers (does not call
 * `startTaskForProject`) when the tracker reports the project is full, and
 * picks up again on the next tick after a release.
 */
import { describe, it, expect, vi } from "vitest";
import { PollingLoop } from "../../src/orchestrator/pollingLoop.js";
import type { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type {
  TicketConnector,
  StateStore,
  ProjectRecord,
  ProjectId,
  AgentId,
  ProjectTicketSourceRecord,
} from "../../src/interfaces.js";

function makeProject(id: string): ProjectRecord {
  return {
    id: id as unknown as ProjectId,
    name: id,
    type: "coding",
    agentId: ("agent-1") as unknown as AgentId,
    agentOverrideJson: null,
    postCloneScript: "",
    maxConcurrent: 1,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeRedmine(): TicketConnector {
  return {
    getAssignedTickets: vi.fn(async () => [
      { id: "1" as unknown as import("../../src/interfaces.js").TicketId, subject: "T1", description: "", status: "open", assigneeId: 1, projectId: 1, customFields: {} },
    ]),
    getTicket: vi.fn(),
    transitionStatus: vi.fn(),
    transitionToInProgress: vi.fn(),
    transitionToInReview: vi.fn(),
    addNote: vi.fn(),
    closeTicket: vi.fn(),
    getSourceLabel: vi.fn(() => "redmine"),
  };
}

function makeStore(): StateStore {
  return {
    getActiveTasks: vi.fn().mockResolvedValue([]),
    getTaskByTicketId: vi.fn().mockResolvedValue(null),
    getFailedAttemptCount: vi.fn().mockResolvedValue(0),
    getChangesForTask: vi.fn().mockResolvedValue([]),
    isTaskPaused: vi.fn().mockResolvedValue(false),
  } as unknown as StateStore;
}

function makeOrchestrator(): Orchestrator & { startTaskForProject: ReturnType<typeof vi.fn> } {
  return {
    startTaskForProject: vi.fn().mockResolvedValue(undefined),
    handleReviewEvent: vi.fn(),
    continueTask: vi.fn(),
  } as unknown as Orchestrator & { startTaskForProject: ReturnType<typeof vi.fn> };
}


describe("PollingLoop — Phase 6 concurrency", () => {
  it("defers ticket processing when project is full (tracker.canStart=false)", async () => {
    const project = makeProject("p-a");
    const projectStore = {
      listProjects: vi.fn(async () => [project]),
      getProjectTicketSource: vi.fn(async (): Promise<ProjectTicketSourceRecord | null> => ({
        id: 1,
        projectId: project.id,
        integrationId: "int-a",
        ticketProjectKey: "platform",
        createdAt: new Date(),
      })),
      getProjectReviewConfig: vi.fn(async () => null),
    };
    const connector = makeRedmine();
    const pluginManager = {
      getConnectorForIntegration: vi.fn(() => connector),
    } as unknown as { getConnectorForIntegration<T>(id: string): T | null };
    const orchestrator = makeOrchestrator();
    const tracker = { canStart: vi.fn(async () => false) };

    const loop = new PollingLoop(
      { ticketIntervalMs: 60000, maxRetryAttempts: 3 },
      orchestrator,
      makeStore(),
      { projectStore, pluginManager, concurrencyTracker: tracker }
    );

    await loop.pollProjectTickets();
    await new Promise((r) => setImmediate(r));

    expect(tracker.canStart).toHaveBeenCalledWith(project.id, project.agentId);
    expect(orchestrator.startTaskForProject).not.toHaveBeenCalled();
  });

  it("calls startTaskForProject when tracker.canStart=true", async () => {
    const project = makeProject("p-a");
    const projectStore = {
      listProjects: vi.fn(async () => [project]),
      getProjectTicketSource: vi.fn(async (): Promise<ProjectTicketSourceRecord | null> => ({
        id: 1,
        projectId: project.id,
        integrationId: "int-a",
        ticketProjectKey: "platform",
        createdAt: new Date(),
      })),
      getProjectReviewConfig: vi.fn(async () => null),
    };
    const connector = makeRedmine();
    const pluginManager = {
      getConnectorForIntegration: vi.fn(() => connector),
    } as unknown as { getConnectorForIntegration<T>(id: string): T | null };
    const orchestrator = makeOrchestrator();
    const tracker = { canStart: vi.fn(async () => true) };

    const loop = new PollingLoop(
      { ticketIntervalMs: 60000, maxRetryAttempts: 3 },
      orchestrator,
      makeStore(),
      { projectStore, pluginManager, concurrencyTracker: tracker }
    );

    await loop.pollProjectTickets();
    await new Promise((r) => setImmediate(r));
    expect(orchestrator.startTaskForProject).toHaveBeenCalledTimes(1);
  });

  it("retries on the next tick after the slot is released (canStart flips true)", async () => {
    const project = makeProject("p-a");
    const projectStore = {
      listProjects: vi.fn(async () => [project]),
      getProjectTicketSource: vi.fn(async (): Promise<ProjectTicketSourceRecord | null> => ({
        id: 1,
        projectId: project.id,
        integrationId: "int-a",
        ticketProjectKey: "platform",
        createdAt: new Date(),
      })),
      getProjectReviewConfig: vi.fn(async () => null),
    };
    const connector = makeRedmine();
    const pluginManager = {
      getConnectorForIntegration: vi.fn(() => connector),
    } as unknown as { getConnectorForIntegration<T>(id: string): T | null };
    const orchestrator = makeOrchestrator();
    let canStartReturn = false;
    const tracker = { canStart: vi.fn(async () => canStartReturn) };

    const loop = new PollingLoop(
      { ticketIntervalMs: 60000, maxRetryAttempts: 3 },
      orchestrator,
      makeStore(),
      { projectStore, pluginManager, concurrencyTracker: tracker }
    );

    await loop.pollProjectTickets();
    await new Promise((r) => setImmediate(r));
    expect(orchestrator.startTaskForProject).not.toHaveBeenCalled();

    // Simulate slot release
    canStartReturn = true;
    await loop.pollProjectTickets();
    await new Promise((r) => setImmediate(r));
    expect(orchestrator.startTaskForProject).toHaveBeenCalledTimes(1);
  });
});
