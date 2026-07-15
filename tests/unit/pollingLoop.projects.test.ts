import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

function makeProject(over: Omit<Partial<ProjectRecord>, "id" | "type"> & { id: string; type: "coding" | "review" }): ProjectRecord {
  return {
    id: over.id as unknown as ProjectId,
    name: over.name ?? over.id,
    type: over.type,
    agentId: (over.agentId ?? "agent-1") as AgentId,
    agentOverrideJson: over.agentOverrideJson ?? null,
    postCloneScript: over.postCloneScript ?? "",
    skillDiscoveryEnabled: over.skillDiscoveryEnabled ?? false,
    gerritTopicOverride: over.gerritTopicOverride ?? null,
    useFullTicketUrlInCommits: over.useFullTicketUrlInCommits ?? false,
    enabled: over.enabled ?? true,
    createdAt: over.createdAt ?? new Date(),
    updatedAt: over.updatedAt ?? new Date(),
  };
}

function makeRedmine(): TicketConnector & { calls: Array<{ projectKey?: string }> } {
  const calls: Array<{ projectKey?: string }> = [];
  const c: TicketConnector = {
    getAssignedTickets: vi.fn(async (opts) => {
      calls.push(opts?.projectKey !== undefined ? { projectKey: opts.projectKey } : {});
      return [];
    }),
    getTicket: vi.fn(),
    transitionStatus: vi.fn(),
    transitionToInProgress: vi.fn(),
    transitionToInReview: vi.fn(),
    addNote: vi.fn(),
    closeTicket: vi.fn(),
    getSourceLabel: vi.fn(() => "redmine"),
  };
  return Object.assign(c, { calls });
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

function makeOrchestrator() {
  return {
    startTaskForProject: vi.fn().mockResolvedValue(undefined),
    handleReviewEvent: vi.fn().mockResolvedValue(undefined),
    continueTask: vi.fn().mockResolvedValue(undefined),
  } as unknown as Orchestrator & { startTaskForProject: ReturnType<typeof vi.fn> };
}


describe("PollingLoop — Phase 4 project mode", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("pollProjectTickets iterates enabled coding projects and uses per-integration connectors with projectKey filter", async () => {
    const projectA = makeProject({ id: "p-a", type: "coding" });
    const projectB = makeProject({ id: "p-b", type: "coding" });
    const projectStore = {
      listProjects: vi.fn(async (filter?: { type?: "coding" | "review"; enabled?: boolean }) => {
        if (filter?.type === "coding") return [projectA, projectB];
        return [];
      }),
      getProjectTicketSource: vi.fn(async (id: ProjectId): Promise<ProjectTicketSourceRecord | null> => {
        if (id === ("p-a" as ProjectId)) return { id: 1, projectId: id, integrationId: "int-a", ticketProjectKey: "platform", createdAt: new Date() };
        if (id === ("p-b" as ProjectId)) return { id: 2, projectId: id, integrationId: "int-b", ticketProjectKey: "tools", createdAt: new Date() };
        return null;
      }),
      getProjectReviewConfig: vi.fn(async () => null),
    };

    const connectorA = makeRedmine();
    const connectorB = makeRedmine();
    (connectorA.getAssignedTickets as ReturnType<typeof vi.fn>).mockImplementation(async (opts) => {
      connectorA.calls.push({ projectKey: opts?.projectKey });
      return [{ id: "1", subject: "T1", description: "", status: "open", assigneeId: 1, projectId: 1, customFields: {} }];
    });

    const pluginManager = {
      getConnectorForCapability: vi.fn(<T,>(id: string): T | null => {
        if (id === "int-a") return connectorA as unknown as T;
        if (id === "int-b") return connectorB as unknown as T;
        return null;
      }),
    } as unknown as { getConnectorForCapability<T>(id: string): T | null };

    const orchestrator = makeOrchestrator();
    const loop = new PollingLoop(
      { ticketIntervalMs: 60000, maxRetryAttempts: 3 },
      orchestrator,
      makeStore(),
      { projectStore, pluginManager }
    );

    await loop.pollProjectTickets();

    expect(projectStore.listProjects).toHaveBeenCalledWith({ type: "coding", enabled: true });
    expect(pluginManager.getConnectorForCapability).toHaveBeenCalledWith("int-a", "issue_tracking");
    expect(pluginManager.getConnectorForCapability).toHaveBeenCalledWith("int-b", "issue_tracking");
    expect(connectorA.calls).toEqual([{ projectKey: "platform" }]);
    expect(connectorB.calls).toEqual([{ projectKey: "tools" }]);
    // Wait one microtask flush so the floating Promise.resolve().then(...) runs.
    await new Promise((r) => setImmediate(r));
    expect(orchestrator.startTaskForProject).toHaveBeenCalledTimes(1);
    const args = (orchestrator.startTaskForProject as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(args[0]).toMatchObject({ id: "1", subject: "T1" });
    expect(args[1]).toBe(projectA);
    expect(args[2]).toMatch(/^redmine:int-a$/);
  });

  it("does NOT start a task when an orphaned DONE task already exists for the ticket source", async () => {
    // A former project completed this ticket, was deleted (project_id → NULL),
    // and the orphan was never re-adopted. The project-scoped lookup misses it,
    // but the ticket-source fallback finds it — so a fresh instance must not
    // re-run the completed work.
    const project = makeProject({ id: "p-a", type: "coding" });
    const projectStore = {
      listProjects: vi.fn(async (filter?: { type?: "coding" | "review"; enabled?: boolean }) =>
        filter?.type === "coding" ? [project] : []
      ),
      getProjectTicketSource: vi.fn(async (id: ProjectId): Promise<ProjectTicketSourceRecord | null> => ({
        id: 1,
        projectId: id,
        integrationId: "int-a",
        ticketProjectKey: "platform",
        createdAt: new Date(),
      })),
      getProjectReviewConfig: vi.fn(async () => null),
    };

    const connector = makeRedmine();
    (connector.getAssignedTickets as ReturnType<typeof vi.fn>).mockImplementation(async () => [
      { id: "42", subject: "T42", description: "", status: "open", assigneeId: 1, projectId: 1, customFields: {} },
    ]);

    const pluginManager = {
      getConnectorForCapability: vi.fn(<T,>(id: string): T | null =>
        id === "int-a" ? (connector as unknown as T) : null
      ),
    } as unknown as { getConnectorForCapability<T>(id: string): T | null };

    const store = makeStore();
    // Project-scoped lookup misses the orphan; the source-scoped fallback finds it.
    (store.getTaskByTicketId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (store.getLatestTaskByTicketSource as ReturnType<typeof vi.fn>).mockResolvedValue({
      taskId: "orphan-task",
      state: "DONE",
    });

    const orchestrator = makeOrchestrator();
    const loop = new PollingLoop(
      { ticketIntervalMs: 60000, maxRetryAttempts: 3 },
      orchestrator,
      store,
      { projectStore, pluginManager }
    );

    await loop.pollProjectTickets();
    await new Promise((r) => setImmediate(r));

    expect(store.getLatestTaskByTicketSource).toHaveBeenCalledWith("42", "int-a", "platform");
    expect(orchestrator.startTaskForProject).not.toHaveBeenCalled();
  });

  it("still starts a task when the orphaned task for the ticket source is FAILED (retry allowed)", async () => {
    const project = makeProject({ id: "p-a", type: "coding" });
    const projectStore = {
      listProjects: vi.fn(async (filter?: { type?: "coding" | "review"; enabled?: boolean }) =>
        filter?.type === "coding" ? [project] : []
      ),
      getProjectTicketSource: vi.fn(async (id: ProjectId): Promise<ProjectTicketSourceRecord | null> => ({
        id: 1,
        projectId: id,
        integrationId: "int-a",
        ticketProjectKey: "platform",
        createdAt: new Date(),
      })),
      getProjectReviewConfig: vi.fn(async () => null),
    };

    const connector = makeRedmine();
    (connector.getAssignedTickets as ReturnType<typeof vi.fn>).mockImplementation(async () => [
      { id: "42", subject: "T42", description: "", status: "open", assigneeId: 1, projectId: 1, customFields: {} },
    ]);

    const pluginManager = {
      getConnectorForCapability: vi.fn(<T,>(id: string): T | null =>
        id === "int-a" ? (connector as unknown as T) : null
      ),
    } as unknown as { getConnectorForCapability<T>(id: string): T | null };

    const store = makeStore();
    (store.getTaskByTicketId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (store.getLatestTaskByTicketSource as ReturnType<typeof vi.fn>).mockResolvedValue({
      taskId: "orphan-task",
      state: "FAILED",
    });

    const orchestrator = makeOrchestrator();
    const loop = new PollingLoop(
      { ticketIntervalMs: 60000, maxRetryAttempts: 3 },
      orchestrator,
      store,
      { projectStore, pluginManager }
    );

    await loop.pollProjectTickets();
    await new Promise((r) => setImmediate(r));

    expect(orchestrator.startTaskForProject).toHaveBeenCalledTimes(1);
  });

  it("prefers a project-bound connector when the plugin manager can build one", async () => {
    const project = makeProject({ id: "p-a", type: "coding" });
    const projectStore = {
      listProjects: vi.fn(async () => [project]),
      getProjectTicketSource: vi.fn(async () => ({
        id: 1,
        projectId: project.id,
        integrationId: "gitlab-int",
        ticketProjectKey: "group/platform",
        createdAt: new Date(),
      })),
      getProjectReviewConfig: vi.fn(async () => null),
    };

    const connector = makeRedmine();
    const pluginManager = {
      getConnectorForCapability: vi.fn(() => null),
      createConnectorForCapability: vi.fn(async <T,>(_id: string, _capability: string, _context?: { ticketProjectKey?: string }) => connector as unknown as T),
    } as unknown as {
      getConnectorForCapability<T>(id: string): T | null;
      createConnectorForCapability?<T>(id: string, capability: string, context?: { ticketProjectKey?: string }): Promise<T | null>;
    };

    const loop = new PollingLoop(
      { ticketIntervalMs: 60000, maxRetryAttempts: 3 },
      makeOrchestrator(),
      makeStore(),
      { projectStore, pluginManager }
    );

    await loop.pollProjectTickets();

    expect(pluginManager.createConnectorForCapability).toHaveBeenCalledWith("gitlab-int", "issue_tracking", {
      ticketProjectKey: "group/platform",
    });
    expect(pluginManager.getConnectorForCapability).not.toHaveBeenCalled();
    expect(connector.calls).toEqual([{ projectKey: "group/platform" }]);
  });

  it("skips projects with no ticket source or no active connector", async () => {
    const projectA = makeProject({ id: "p-a", type: "coding" });
    const projectStore = {
      listProjects: vi.fn(async () => [projectA]),
      getProjectTicketSource: vi.fn(async () => null),
      getProjectReviewConfig: vi.fn(async () => null),
    };
    const pluginManager = { getConnectorForCapability: vi.fn(() => null) } as unknown as { getConnectorForCapability<T>(id: string): T | null };
    const orchestrator = makeOrchestrator();
    const loop = new PollingLoop(
      { ticketIntervalMs: 60000, maxRetryAttempts: 3 },
      orchestrator,
      makeStore(),
      { projectStore, pluginManager }
    );

    await loop.pollProjectTickets();
    await new Promise((r) => setImmediate(r));
    expect(orchestrator.startTaskForProject).not.toHaveBeenCalled();
  });

  it("dedupes tickets that already have an active task", async () => {
    const projectA = makeProject({ id: "p-a", type: "coding" });
    const projectStore = {
      listProjects: vi.fn(async () => [projectA]),
      getProjectTicketSource: vi.fn(async () => ({
        id: 1,
        projectId: "p-a" as ProjectId,
        integrationId: "int-a",
        ticketProjectKey: "platform",
        createdAt: new Date(),
      })),
      getProjectReviewConfig: vi.fn(async () => null),
    };
    const connector = makeRedmine();
    (connector.getAssignedTickets as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "42", subject: "X", description: "", status: "open", assigneeId: 1, projectId: 1, customFields: {} },
    ]);
    const pluginManager = { getConnectorForCapability: vi.fn(() => connector) } as unknown as { getConnectorForCapability<T>(id: string): T | null };
    const orchestrator = makeOrchestrator();

    const store = makeStore();
    (store.getActiveTaskByTicketId as ReturnType<typeof vi.fn>).mockResolvedValue({
      taskId: "t-1",
      ticketId: "42",
      state: "AGENT_RUNNING",
    });

    const loop = new PollingLoop(
      { ticketIntervalMs: 60000, maxRetryAttempts: 3 },
      orchestrator,
      store,
      { projectStore, pluginManager }
    );

    await loop.pollProjectTickets();
    await new Promise((r) => setImmediate(r));
    expect(orchestrator.startTaskForProject).not.toHaveBeenCalled();
  });

  it("skips ticket when an active task coexists with a newer FAILED task", async () => {
    const projectStore = {
      listProjects: vi.fn(async () => [makeProject({ id: "p-1", type: "coding" })]),
      getProjectTicketSource: vi.fn(async () => ({
        id: 1, projectId: "p-1" as ProjectId, integrationId: "int-1", ticketProjectKey: "", createdAt: new Date(),
      })),
      getProjectReviewConfig: vi.fn(async () => null),
    };
    const connector = makeRedmine();
    (connector.getAssignedTickets as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "1993", subject: "X", description: "", status: "open", assigneeId: 1, projectId: 1, customFields: {} },
    ]);
    const pluginManager = { getConnectorForCapability: vi.fn(() => connector) } as unknown as { getConnectorForCapability<T>(id: string): T | null };
    const orchestrator = makeOrchestrator();

    const store = makeStore();
    // Newest task by createdAt is FAILED, but an older task is still active.
    (store.getTaskByTicketId as ReturnType<typeof vi.fn>).mockResolvedValue({
      taskId: "t-failed", ticketId: "1993", state: "FAILED",
    });
    (store.getActiveTaskByTicketId as ReturnType<typeof vi.fn>).mockResolvedValue({
      taskId: "t-active", ticketId: "1993", state: "AGENT_RUNNING",
    });

    const loop = new PollingLoop(
      { ticketIntervalMs: 60000, maxRetryAttempts: 3 },
      orchestrator,
      store,
      { projectStore, pluginManager }
    );

    await loop.pollProjectTickets();
    await new Promise((r) => setImmediate(r));
    expect(orchestrator.startTaskForProject).not.toHaveBeenCalled();
  });

  it("creates new task when existing task is FAILED and retry count is below max", async () => {
    const projectStore = {
      listProjects: vi.fn(async () => [makeProject({ id: "p-1", type: "coding" })]),
      getProjectTicketSource: vi.fn(async () => ({
        id: 1, projectId: "p-1" as ProjectId, integrationId: "int-1", ticketProjectKey: "", createdAt: new Date(),
      })),
      getProjectReviewConfig: vi.fn(async () => null),
    };
    const connector = makeRedmine();
    (connector.getAssignedTickets as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "42", subject: "Retry me", description: "", status: "open", assigneeId: 1, projectId: 1, customFields: {} },
    ]);
    const pluginManager = { getConnectorForCapability: vi.fn(() => connector) } as unknown as { getConnectorForCapability<T>(id: string): T | null };
    const orchestrator = makeOrchestrator();

    const store = makeStore();
    (store.getTaskByTicketId as ReturnType<typeof vi.fn>).mockResolvedValue({ taskId: "t-1", ticketId: "42", state: "FAILED" });
    (store.getFailedAttemptCount as ReturnType<typeof vi.fn>).mockResolvedValue(1); // below max

    const loop = new PollingLoop(
      { ticketIntervalMs: 60000, maxRetryAttempts: 3 },
      orchestrator,
      store,
      { projectStore, pluginManager }
    );

    await loop.pollProjectTickets();
    await new Promise((r) => setImmediate(r));
    expect(orchestrator.startTaskForProject).toHaveBeenCalledTimes(1);
    const args = (orchestrator.startTaskForProject as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(args[0]).toMatchObject({ id: "42", subject: "Retry me" });
  });

  it.each(["DONE", "ABANDONED", "REVIEW_DONE", "REVIEW_FAILED"] as const)(
    "skips ticket when existing task is in %s state",
    async (terminalState) => {
      const projectStore = {
        listProjects: vi.fn(async () => [makeProject({ id: "p-1", type: "coding" })]),
        getProjectTicketSource: vi.fn(async () => ({
          id: 1, projectId: "p-1" as ProjectId, integrationId: "int-1", ticketProjectKey: "", createdAt: new Date(),
        })),
        getProjectReviewConfig: vi.fn(async () => null),
      };
      const connector = makeRedmine();
      (connector.getAssignedTickets as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "42", subject: "X", description: "", status: "open", assigneeId: 1, projectId: 1, customFields: {} },
      ]);
      const pluginManager = { getConnectorForCapability: vi.fn(() => connector) } as unknown as { getConnectorForCapability<T>(id: string): T | null };
      const orchestrator = makeOrchestrator();

      const store = makeStore();
      (store.getTaskByTicketId as ReturnType<typeof vi.fn>).mockResolvedValue({ taskId: "t-1", ticketId: "42", state: terminalState });

      const loop = new PollingLoop(
        { ticketIntervalMs: 60000, maxRetryAttempts: 3 },
        orchestrator,
        store,
        { projectStore, pluginManager }
      );

      await loop.pollProjectTickets();
      await new Promise((r) => setImmediate(r));
      expect(orchestrator.startTaskForProject).not.toHaveBeenCalled();
    }
  );
});
