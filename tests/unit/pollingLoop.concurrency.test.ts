/**
 * Phase 6 — PollingLoop concurrency ingestion tests.
 *
 * Verifies that `pollProjectTickets` always calls `startTaskForProject`
 * for eligible tickets; concurrency limiting now happens inside the
 * orchestrator agent-cycle execution path.
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
    skillDiscoveryEnabled: false,
    localSkillsPath: ".github/skills",
    skillSourcesJson: "[]",
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
    getActiveTaskByTicketId: vi.fn().mockResolvedValue(null),
    getLatestTaskByTicketSource: vi.fn().mockResolvedValue(null),
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
  it("calls startTaskForProject for eligible tickets", async () => {
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
      getConnectorForCapability: vi.fn(() => connector),
    } as unknown as { getConnectorForCapability<T>(id: string): T | null };
    const orchestrator = makeOrchestrator();

    const loop = new PollingLoop(
      { ticketIntervalMs: 60000, maxRetryAttempts: 3 },
      orchestrator,
      makeStore(),
      { projectStore, pluginManager }
    );

    await loop.pollProjectTickets();
    await new Promise((r) => setImmediate(r));
    expect(orchestrator.startTaskForProject).toHaveBeenCalledTimes(1);
  });

  it("retries on next tick when startTaskForProject previously threw", async () => {
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
      getConnectorForCapability: vi.fn(() => connector),
    } as unknown as { getConnectorForCapability<T>(id: string): T | null };
    const orchestrator = makeOrchestrator();
    orchestrator.startTaskForProject
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue(undefined);

    const loop = new PollingLoop(
      { ticketIntervalMs: 60000, maxRetryAttempts: 3 },
      orchestrator,
      makeStore(),
      { projectStore, pluginManager }
    );

    await loop.pollProjectTickets();
    await new Promise((r) => setImmediate(r));
    expect(orchestrator.startTaskForProject).toHaveBeenCalledTimes(1);

    await loop.pollProjectTickets();
    await new Promise((r) => setImmediate(r));
    expect(orchestrator.startTaskForProject).toHaveBeenCalledTimes(2);
  });
});
