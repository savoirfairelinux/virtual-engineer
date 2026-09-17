import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PollingLoop } from "../../src/orchestrator/pollingLoop.js";
import type { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type {
  StateStore,
  ProjectRecord,
  ProjectId,
  AgentId,
  Task,
  ProjectReviewConfig,
  ReviewDiscoveryConnector,
  ReviewAssignmentDiscovery,
} from "../../src/interfaces.js";
import { makeProjectId, makeTaskId, makeExternalChangeId, makeTicketId } from "../../src/interfaces.js";
import type { ReviewAssignmentTrigger } from "../../src/orchestrator/pollingLoop.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProject(
  over: Omit<Partial<ProjectRecord>, "id" | "type"> & { id: string; type: "coding" | "review" }
): ProjectRecord {
  return {
    id: makeProjectId(over.id),
    name: over.name ?? over.id,
    type: over.type,
    agentId: (over.agentId ?? "agent-1") as AgentId,
    agentOverrideJson: over.agentOverrideJson ?? null,
    postCloneScript: over.postCloneScript ?? "",
    skillSourcesJson: over.skillSourcesJson ?? "[]",
    gerritTopicOverride: over.gerritTopicOverride ?? null,
    useFullTicketUrlInCommits: over.useFullTicketUrlInCommits ?? false,
    postReviewLinkToTicket: over.postReviewLinkToTicket ?? false,
    reactToCiFailures: over.reactToCiFailures ?? false,
    enabled: over.enabled ?? true,
    createdAt: over.createdAt ?? new Date(),
    updatedAt: over.updatedAt ?? new Date(),
  };
}

function makeTask(
  over: {
    taskId: string;
    externalChangeId?: string | null;
    projectId?: string | null;
    state?: Task["state"];
    taskType?: Task["taskType"];
  }
): Task {
  return {
    taskId: makeTaskId(over.taskId),
    ticketId: makeTicketId("ticket-1"),
    ticketSourceLabel: "github-issue:int-1",
    ticketTitle: "Test ticket",
    ticketDescription: "",
    state: over.state ?? "IN_REVIEW",
    taskType: over.taskType ?? "code-gen",
    externalChangeId: over.externalChangeId != null
      ? makeExternalChangeId(over.externalChangeId)
      : null,
    currentPatchset: 1,
    reviewedPatchset: null,
    cycleCount: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    failureReason: null,
    ticketUrl: null,
    reviewUrl: null,
    projectId: over.projectId === null
      ? null
      : over.projectId !== undefined
        ? makeProjectId(over.projectId)
        : undefined,
    displayId: null,
  };
}

function makeStore(activeTasks: Task[] = []): StateStore {
  return {
    getActiveTasks: vi.fn().mockResolvedValue(activeTasks),
    getTaskByTicketId: vi.fn().mockResolvedValue(null),
    getFailedAttemptCount: vi.fn().mockResolvedValue(0),
    getChangesForTask: vi.fn().mockResolvedValue([]),
    isTaskPaused: vi.fn().mockResolvedValue(false),
  } as unknown as StateStore;
}

function makeOrchestrator() {
  return {
    startTaskForProject: vi.fn().mockResolvedValue(undefined),
    handleReviewEvent: vi.fn().mockResolvedValue(undefined),
    checkReviewWatchingTask: vi.fn().mockResolvedValue(undefined),
    continueTask: vi.fn().mockResolvedValue(undefined),
  } as unknown as Orchestrator & {
    checkReviewWatchingTask: ReturnType<typeof vi.fn>;
    handleReviewEvent: ReturnType<typeof vi.fn>;
  };
}

function makeReviewTrigger(): ReviewAssignmentTrigger & { calls: Array<{ integrationId: string; changeId: string }> } {
  const calls: Array<{ integrationId: string; changeId: string }> = [];
  return {
    calls,
    triggerReview: vi.fn(async (integrationId: string, changeId: string) => {
      calls.push({ integrationId, changeId });
    }),
  };
}

// ─── pollInReviewTasks ────────────────────────────────────────────────────────

describe("PollingLoop — pollInReviewTasks", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("calls handleReviewEvent for each code-gen IN_REVIEW task with externalChangeId", async () => {
    const task = makeTask({ taskId: "t-1", externalChangeId: "octocat/repo#42" });
    const stateStore = makeStore([task]);
    const orchestrator = makeOrchestrator();

    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      orchestrator,
      stateStore,
    );

    await loop.pollInReviewTasks();

    // Wait for fire-and-forget promises
    await new Promise((r) => setTimeout(r, 0));

    expect(orchestrator.handleReviewEvent).toHaveBeenCalledTimes(1);
    expect(orchestrator.handleReviewEvent).toHaveBeenCalledWith(
      makeExternalChangeId("octocat/repo#42"),
      task.taskId,
    );
  });

  it("skips code-review tasks (type code-review)", async () => {
    const task = makeTask({ taskId: "t-2", taskType: "code-review", externalChangeId: "change-99" });
    const stateStore = makeStore([task]);
    const orchestrator = makeOrchestrator();

    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      orchestrator,
      stateStore,
    );

    await loop.pollInReviewTasks();
    await new Promise((r) => setTimeout(r, 0));

    expect(orchestrator.handleReviewEvent).not.toHaveBeenCalled();
  });

  it("skips code-gen tasks not in IN_REVIEW state", async () => {
    const task = makeTask({ taskId: "t-3", state: "AGENT_RUNNING", externalChangeId: "change-77" });
    const stateStore = makeStore([task]);
    const orchestrator = makeOrchestrator();

    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      orchestrator,
      stateStore,
    );

    await loop.pollInReviewTasks();
    await new Promise((r) => setTimeout(r, 0));

    expect(orchestrator.handleReviewEvent).not.toHaveBeenCalled();
  });

  it("skips code-gen IN_REVIEW tasks with null externalChangeId", async () => {
    const task = makeTask({ taskId: "t-4", state: "IN_REVIEW", externalChangeId: null });
    const stateStore = makeStore([task]);
    const orchestrator = makeOrchestrator();

    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      orchestrator,
      stateStore,
    );

    await loop.pollInReviewTasks();
    await new Promise((r) => setTimeout(r, 0));

    expect(orchestrator.handleReviewEvent).not.toHaveBeenCalled();
  });

  it("processes multiple IN_REVIEW tasks independently and logs errors without throwing", async () => {
    const task1 = makeTask({ taskId: "t-5", externalChangeId: "repo#1" });
    const task2 = makeTask({ taskId: "t-6", externalChangeId: "repo#2" });
    const stateStore = makeStore([task1, task2]);
    const orchestrator = makeOrchestrator();
    (orchestrator.handleReviewEvent as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("review check failed"))
      .mockResolvedValueOnce(undefined);

    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      orchestrator,
      stateStore,
    );

    // Should not throw even when handleReviewEvent rejects
    await expect(loop.pollInReviewTasks()).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 10));
    expect(orchestrator.handleReviewEvent).toHaveBeenCalledTimes(2);
  });

  it("skips tasks polled within the cooldown interval", async () => {
    const task = makeTask({ taskId: "t-7", externalChangeId: "octocat/repo#99" });
    const stateStore = makeStore([task]);
    const orchestrator = makeOrchestrator();

    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      orchestrator,
      stateStore,
    );

    // First poll: should call handleReviewEvent
    await loop.pollInReviewTasks();
    await new Promise((r) => setTimeout(r, 0));
    expect(orchestrator.handleReviewEvent).toHaveBeenCalledTimes(1);

    // Second poll immediately: should skip due to cooldown
    await loop.pollInReviewTasks();
    await new Promise((r) => setTimeout(r, 0));
    expect(orchestrator.handleReviewEvent).toHaveBeenCalledTimes(1); // still 1
  });

  it("polls again after cooldown expires", async () => {
    const task = makeTask({ taskId: "t-8", externalChangeId: "octocat/repo#100" });
    const stateStore = makeStore([task]);
    const orchestrator = makeOrchestrator();

    const loop = new PollingLoop(
      { ticketIntervalMs: 100, maxRetryAttempts: 5 }, // 100ms cooldown
      orchestrator,
      stateStore,
    );

    // First poll
    await loop.pollInReviewTasks();
    await new Promise((r) => setTimeout(r, 0));
    expect(orchestrator.handleReviewEvent).toHaveBeenCalledTimes(1);

    // Wait for cooldown to expire
    await new Promise((r) => setTimeout(r, 120));

    // Second poll: should proceed
    await loop.pollInReviewTasks();
    await new Promise((r) => setTimeout(r, 0));
    expect(orchestrator.handleReviewEvent).toHaveBeenCalledTimes(2);
  });
});

// ─── pollReviewProjects ───────────────────────────────────────────────────────

describe("PollingLoop — pollReviewProjects", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("calls triggerReview for each PR where VE is requested reviewer", async () => {
    const project = makeProject({ id: "rp-1", type: "review" });
    const reviewConfig: ProjectReviewConfig = {
      integrationId: "int-gh-1",
      repos: ["octocat/hello-world"],
    };

    const assignments: ReviewAssignmentDiscovery[] = [
      { changeId: "octocat/hello-world#42", project: "octocat/hello-world", subject: "Feature PR" },
    ];
    const discoveryConnector: ReviewDiscoveryConnector = {
      getOpenReviewAssignments: vi.fn().mockResolvedValue(assignments),
    };

    const projectStore = {
      listProjects: vi.fn(async (filter?: { type?: string }) => {
        if (filter?.type === "review") return [project];
        return [];
      }),
      getProjectTicketSource: vi.fn(async () => null),
      getProjectReviewConfig: vi.fn(async (id: ProjectId) => {
        if (id === makeProjectId("rp-1")) return reviewConfig;
        return null;
      }),
    };
    const pluginManager = {
      getConnectorForCapability: vi.fn((_id: string) => discoveryConnector),
    };
    const trigger = makeReviewTrigger();
    const orchestrator = makeOrchestrator();
    const stateStore = makeStore();

    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      orchestrator,
      stateStore,
      { projectStore: projectStore as never, pluginManager: pluginManager as never, reviewTrigger: trigger },
    );

    await loop.pollReviewProjects();
    await new Promise((r) => setTimeout(r, 0));

    expect(discoveryConnector.getOpenReviewAssignments).toHaveBeenCalledWith(["octocat/hello-world"]);
    expect(trigger.triggerReview).toHaveBeenCalledWith("int-gh-1", "octocat/hello-world#42", { triggerCause: "backfill" });
  });

  it("does not backfill open changes for automatic review projects", async () => {
    const project = makeProject({ id: "rp-auto", type: "review" });
    const discoveryConnector: ReviewDiscoveryConnector = {
      getOpenReviewAssignments: vi.fn().mockResolvedValue([
        { changeId: "octocat/repo#42", project: "octocat/repo" },
      ]),
    };
    const projectStore = {
      listProjects: vi.fn(async () => [project]),
      getProjectTicketSource: vi.fn(async () => null),
      getProjectReviewConfig: vi.fn(async () => ({
        integrationId: "int-auto",
        repos: ["octocat/repo"],
        assignmentMode: "automatic" as const,
      })),
    };
    const pluginManager = {
      getConnectorForCapability: vi.fn(() => discoveryConnector),
    };
    const trigger = makeReviewTrigger();
    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      makeOrchestrator(),
      makeStore(),
      { projectStore: projectStore as never, pluginManager: pluginManager as never, reviewTrigger: trigger },
    );

    await loop.pollReviewProjects();

    expect(discoveryConnector.getOpenReviewAssignments).not.toHaveBeenCalled();
    expect(trigger.triggerReview).not.toHaveBeenCalled();
  });

  it("is a no-op when reviewTrigger is not set", async () => {
    const project = makeProject({ id: "rp-2", type: "review" });
    const projectStore = {
      listProjects: vi.fn(async () => [project]),
      getProjectTicketSource: vi.fn(async () => null),
      getProjectReviewConfig: vi.fn(async () => ({
        integrationId: "int-1",
        repos: ["octocat/repo"],
      })),
    };
    const discoveryConnector: ReviewDiscoveryConnector = {
      getOpenReviewAssignments: vi.fn().mockResolvedValue([]),
    };
    const pluginManager = {
      getConnectorForCapability: vi.fn(() => discoveryConnector),
    };
    const orchestrator = makeOrchestrator();
    const stateStore = makeStore();

    // No reviewTrigger in projectMode
    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      orchestrator,
      stateStore,
      { projectStore: projectStore as never, pluginManager: pluginManager as never },
    );

    await loop.pollReviewProjects();

    expect(discoveryConnector.getOpenReviewAssignments).not.toHaveBeenCalled();
  });

  it("skips review projects with no review config", async () => {
    const project = makeProject({ id: "rp-3", type: "review" });
    const projectStore = {
      listProjects: vi.fn(async () => [project]),
      getProjectTicketSource: vi.fn(async () => null),
      getProjectReviewConfig: vi.fn(async () => null), // no config
    };
    const discoveryConnector: ReviewDiscoveryConnector = {
      getOpenReviewAssignments: vi.fn().mockResolvedValue([]),
    };
    const pluginManager = {
      getConnectorForCapability: vi.fn(() => discoveryConnector),
    };
    const trigger = makeReviewTrigger();
    const orchestrator = makeOrchestrator();
    const stateStore = makeStore();

    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      orchestrator,
      stateStore,
      { projectStore: projectStore as never, pluginManager: pluginManager as never, reviewTrigger: trigger },
    );

    await loop.pollReviewProjects();

    expect(discoveryConnector.getOpenReviewAssignments).not.toHaveBeenCalled();
    expect(trigger.triggerReview).not.toHaveBeenCalled();
  });

  it("skips review projects whose integration uses stream events (e.g. Gerrit)", async () => {
    const project = makeProject({ id: "rp-4a", type: "review" });
    const projectStore = {
      listProjects: vi.fn(async () => [project]),
      getProjectTicketSource: vi.fn(async () => null),
      getProjectReviewConfig: vi.fn(async () => ({ integrationId: "int-gerrit", repos: ["gerrit/repo"] })),
    };
    const discoveryConnector: ReviewDiscoveryConnector = {
      getOpenReviewAssignments: vi.fn().mockResolvedValue([]),
    };
    const pluginManager = {
      getConnectorForCapability: vi.fn(() => discoveryConnector),
      integrationHasStreamEvents: vi.fn((_id: string) => true), // Gerrit uses stream events
    };
    const trigger = makeReviewTrigger();
    const orchestrator = makeOrchestrator();
    const stateStore = makeStore();

    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      orchestrator,
      stateStore,
      { projectStore: projectStore as never, pluginManager: pluginManager as never, reviewTrigger: trigger },
    );

    await loop.pollReviewProjects();

    expect(discoveryConnector.getOpenReviewAssignments).not.toHaveBeenCalled();
    expect(trigger.triggerReview).not.toHaveBeenCalled();
  });

  it("skips projects when connector does not support review discovery", async () => {
    const project = makeProject({ id: "rp-4", type: "review" });
    const projectStore = {
      listProjects: vi.fn(async () => [project]),
      getProjectTicketSource: vi.fn(async () => null),
      getProjectReviewConfig: vi.fn(async () => ({ integrationId: "int-1", repos: ["octocat/repo"] })),
    };
    // Connector without getOpenReviewAssignments
    const plainConnector = { someOtherMethod: vi.fn() };
    const pluginManager = {
      getConnectorForCapability: vi.fn(() => plainConnector),
    };
    const trigger = makeReviewTrigger();
    const orchestrator = makeOrchestrator();
    const stateStore = makeStore();

    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      orchestrator,
      stateStore,
      { projectStore: projectStore as never, pluginManager: pluginManager as never, reviewTrigger: trigger },
    );

    await loop.pollReviewProjects();

    expect(trigger.triggerReview).not.toHaveBeenCalled();
  });

  it("logs and continues when getOpenReviewAssignments throws", async () => {
    const project = makeProject({ id: "rp-5", type: "review" });
    const projectStore = {
      listProjects: vi.fn(async () => [project]),
      getProjectTicketSource: vi.fn(async () => null),
      getProjectReviewConfig: vi.fn(async () => ({ integrationId: "int-1", repos: ["octocat/repo"] })),
    };
    const failingConnector: ReviewDiscoveryConnector = {
      getOpenReviewAssignments: vi.fn().mockRejectedValue(new Error("network error")),
    };
    const pluginManager = {
      getConnectorForCapability: vi.fn(() => failingConnector),
    };
    const trigger = makeReviewTrigger();
    const orchestrator = makeOrchestrator();
    const stateStore = makeStore();

    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      orchestrator,
      stateStore,
      { projectStore: projectStore as never, pluginManager: pluginManager as never, reviewTrigger: trigger },
    );

    await expect(loop.pollReviewProjects()).resolves.toBeUndefined();
    expect(trigger.triggerReview).not.toHaveBeenCalled();
  });

  it("setReviewTrigger updates the trigger used on subsequent polls", async () => {
    const project = makeProject({ id: "rp-6", type: "review" });
    const assignments: ReviewAssignmentDiscovery[] = [
      { changeId: "octocat/repo#1", project: "octocat/repo" },
    ];
    const discoveryConnector: ReviewDiscoveryConnector = {
      getOpenReviewAssignments: vi.fn().mockResolvedValue(assignments),
    };
    const projectStore = {
      listProjects: vi.fn(async () => [project]),
      getProjectTicketSource: vi.fn(async () => null),
      getProjectReviewConfig: vi.fn(async () => ({ integrationId: "int-1", repos: ["octocat/repo"] })),
    };
    const pluginManager = {
      getConnectorForCapability: vi.fn(() => discoveryConnector),
    };
    const orchestrator = makeOrchestrator();
    const stateStore = makeStore();

    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      orchestrator,
      stateStore,
      { projectStore: projectStore as never, pluginManager: pluginManager as never },
    );

    // No trigger yet — poll is a no-op
    await loop.pollReviewProjects();
    expect(discoveryConnector.getOpenReviewAssignments).not.toHaveBeenCalled();

    // Set trigger and poll again
    const trigger = makeReviewTrigger();
    loop.setReviewTrigger(trigger);
    await loop.pollReviewProjects();
    await new Promise((r) => setTimeout(r, 0));

    expect(trigger.triggerReview).toHaveBeenCalledWith("int-1", "octocat/repo#1", { triggerCause: "backfill" });
  });

  it("rechecks watched polling review tasks when VE remains assigned", async () => {
    const task = makeTask({
      taskId: "watched-1",
      externalChangeId: "octocat/hello-world#42",
      projectId: "rp-watched",
      state: "REVIEW_WATCHING",
      taskType: "code-review",
    });
    const project = makeProject({ id: "rp-watched", type: "review" });
    const reviewConfig: ProjectReviewConfig = {
      integrationId: "int-gh-1",
      repos: ["octocat/hello-world"],
    };
    const discoveryConnector: ReviewDiscoveryConnector & {
      hasReviewAssignment: ReturnType<typeof vi.fn>;
    } = {
      getOpenReviewAssignments: vi.fn().mockResolvedValue([]),
      hasReviewAssignment: vi.fn().mockResolvedValue(true),
    };
    const projectStore = {
      listProjects: vi.fn(async (filter?: { type?: string }) =>
        filter?.type === "review" ? [project] : []
      ),
      getProjectTicketSource: vi.fn(async () => null),
      getProjectReviewConfig: vi.fn(async (id: ProjectId) =>
        id === project.id ? reviewConfig : null
      ),
    };
    const pluginManager = {
      getConnectorForCapability: vi.fn(() => discoveryConnector),
      createConnectorForCapability: vi.fn(async () => discoveryConnector),
      integrationHasStreamEvents: vi.fn(() => false),
      getIntegrationCapabilityIntake: vi.fn(() => ["polling"]),
    };
    const trigger = makeReviewTrigger();
    const orchestrator = makeOrchestrator();
    const stateStore = makeStore([task]);

    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      orchestrator,
      stateStore,
      {
        projectStore: projectStore as never,
        pluginManager: pluginManager as never,
        reviewTrigger: trigger,
      },
    );

    await loop.pollReviewWatchingTasks();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(orchestrator.checkReviewWatchingTask).toHaveBeenCalledWith(task.taskId);
    expect(discoveryConnector.hasReviewAssignment).toHaveBeenCalledWith(task.externalChangeId);
    expect(trigger.triggerReview).toHaveBeenCalledWith("int-gh-1", "octocat/hello-world#42");
  });

  it("rechecks watched automatic review tasks without requiring current assignment", async () => {
    const task = makeTask({
      taskId: "watched-auto",
      externalChangeId: "octocat/hello-world#52",
      projectId: "rp-watched-auto",
      state: "REVIEW_WATCHING",
      taskType: "code-review",
    });
    const discoveryConnector: ReviewDiscoveryConnector & { hasReviewAssignment: ReturnType<typeof vi.fn> } = {
      getOpenReviewAssignments: vi.fn().mockResolvedValue([]),
      hasReviewAssignment: vi.fn().mockResolvedValue(false),
    };
    const projectStore = {
      getProjectReviewConfig: vi.fn(async () => ({
        integrationId: "int-gh-auto",
        repos: ["octocat/hello-world"],
        assignmentMode: "automatic" as const,
      })),
    };
    const pluginManager = {
      createConnectorForCapability: vi.fn(async () => discoveryConnector),
      integrationHasStreamEvents: vi.fn(() => false),
      getIntegrationCapabilityIntake: vi.fn(() => ["polling"]),
    };
    const trigger = makeReviewTrigger();
    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      makeOrchestrator(),
      makeStore([task]),
      {
        projectStore: projectStore as never,
        pluginManager: pluginManager as never,
        reviewTrigger: trigger,
      },
    );

    await loop.pollReviewWatchingTasks();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(discoveryConnector.hasReviewAssignment).not.toHaveBeenCalled();
    expect(trigger.triggerReview).toHaveBeenCalledWith("int-gh-auto", "octocat/hello-world#52");
  });

  it("does not re-trigger a watched review after VE is unassigned", async () => {
    const task = makeTask({
      taskId: "watched-2",
      externalChangeId: "octocat/hello-world#43",
      projectId: "rp-watched-2",
      state: "REVIEW_WATCHING",
      taskType: "code-review",
    });
    const project = makeProject({ id: "rp-watched-2", type: "review" });
    const discoveryConnector: ReviewDiscoveryConnector & {
      hasReviewAssignment: ReturnType<typeof vi.fn>;
    } = {
      getOpenReviewAssignments: vi.fn().mockResolvedValue([]),
      hasReviewAssignment: vi.fn().mockResolvedValue(false),
    };
    const projectStore = {
      listProjects: vi.fn(async () => [project]),
      getProjectTicketSource: vi.fn(async () => null),
      getProjectReviewConfig: vi.fn(async () => ({
        integrationId: "int-gh-2",
        repos: ["octocat/hello-world"],
      })),
    };
    const pluginManager = {
      createConnectorForCapability: vi.fn(async () => discoveryConnector),
      integrationHasStreamEvents: vi.fn(() => false),
      getIntegrationCapabilityIntake: vi.fn(() => ["polling"]),
    };
    const trigger = makeReviewTrigger();
    const orchestrator = makeOrchestrator();
    const stateStore = makeStore([task]);
    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      orchestrator,
      stateStore,
      {
        projectStore: projectStore as never,
        pluginManager: pluginManager as never,
        reviewTrigger: trigger,
      },
    );

    await loop.pollReviewWatchingTasks();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(discoveryConnector.hasReviewAssignment).toHaveBeenCalledWith(task.externalChangeId);
    expect(trigger.triggerReview).not.toHaveBeenCalled();
  });

  it("reuses one repo-bound connector for watched tasks in the same repository", async () => {
    const tasks = [
      makeTask({
        taskId: "watched-3",
        externalChangeId: "octocat/hello-world#44",
        projectId: "rp-watched-3",
        state: "REVIEW_WATCHING",
        taskType: "code-review",
      }),
      makeTask({
        taskId: "watched-4",
        externalChangeId: "octocat/hello-world#45",
        projectId: "rp-watched-3",
        state: "REVIEW_WATCHING",
        taskType: "code-review",
      }),
    ];
    const project = makeProject({ id: "rp-watched-3", type: "review" });
    const connector: ReviewDiscoveryConnector & {
      hasReviewAssignment: ReturnType<typeof vi.fn>;
    } = {
      getOpenReviewAssignments: vi.fn().mockResolvedValue([]),
      hasReviewAssignment: vi.fn().mockResolvedValue(true),
    };
    const projectStore = {
      getProjectReviewConfig: vi.fn(async () => ({
        integrationId: "int-gh-3",
        repos: ["octocat/hello-world"],
      })),
    };
    const pluginManager = {
      createConnectorForCapability: vi.fn(async () => connector),
      integrationHasStreamEvents: vi.fn(() => false),
      getIntegrationCapabilityIntake: vi.fn(() => ["polling"]),
    };
    const trigger = makeReviewTrigger();
    const orchestrator = makeOrchestrator();
    const stateStore = makeStore(tasks);
    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      orchestrator,
      stateStore,
      {
        projectStore: projectStore as never,
        pluginManager: pluginManager as never,
        reviewTrigger: trigger,
      },
    );

    await loop.pollReviewWatchingTasks();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(project).toBeDefined();
    expect(pluginManager.createConnectorForCapability).toHaveBeenCalledTimes(1);
    expect(connector.hasReviewAssignment).toHaveBeenCalledTimes(2);
  });

  it("clears review trigger cooldowns when polling stops", async () => {
    const assignments: ReviewAssignmentDiscovery[] = [
      { changeId: "octocat/repo#46", project: "octocat/repo" },
    ];
    const discoveryConnector: ReviewDiscoveryConnector = {
      getOpenReviewAssignments: vi.fn().mockResolvedValue(assignments),
    };
    const project = makeProject({ id: "rp-stop", type: "review" });
    const projectStore = {
      listProjects: vi.fn(async () => [project]),
      getProjectTicketSource: vi.fn(async () => null),
      getProjectReviewConfig: vi.fn(async () => ({
        integrationId: "int-stop",
        repos: ["octocat/repo"],
      })),
    };
    const pluginManager = {
      getConnectorForCapability: vi.fn(() => discoveryConnector),
    };
    const trigger = makeReviewTrigger();
    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      makeOrchestrator(),
      makeStore(),
      {
        projectStore: projectStore as never,
        pluginManager: pluginManager as never,
        reviewTrigger: trigger,
      },
    );

    await loop.pollReviewProjects();
    await new Promise((resolve) => setTimeout(resolve, 0));
    loop.stop();
    await loop.pollReviewProjects();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(trigger.triggerReview).toHaveBeenCalledTimes(2);
  });

  it("prunes expired review trigger cooldowns", async () => {
    const baseNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(baseNow);
    const assignments: ReviewAssignmentDiscovery[] = [
      { changeId: "octocat/repo#47", project: "octocat/repo" },
    ];
    const discoveryConnector: ReviewDiscoveryConnector = {
      getOpenReviewAssignments: vi.fn().mockResolvedValue(assignments),
    };
    const project = makeProject({ id: "rp-prune", type: "review" });
    const projectStore = {
      listProjects: vi.fn(async () => [project]),
      getProjectTicketSource: vi.fn(async () => null),
      getProjectReviewConfig: vi.fn(async () => ({
        integrationId: "int-prune",
        repos: ["octocat/repo"],
      })),
    };
    const pluginManager = {
      getConnectorForCapability: vi.fn(() => discoveryConnector),
    };
    const loop = new PollingLoop(
      { ticketIntervalMs: 30_000, maxRetryAttempts: 5 },
      makeOrchestrator(),
      makeStore(),
      {
        projectStore: projectStore as never,
        pluginManager: pluginManager as never,
        reviewTrigger: makeReviewTrigger(),
      },
    );

    await loop.pollReviewProjects();
    vi.spyOn(Date, "now").mockReturnValue(baseNow + 30_001);
    await loop.pollReviewProjects();

    const cooldowns = (loop as unknown as {
      reviewTriggerCooldowns: Map<string, number>;
    }).reviewTriggerCooldowns;
    expect(cooldowns.has("int-prune:octocat/repo#47")).toBe(true);
    expect(cooldowns.size).toBe(1);
  });
});
