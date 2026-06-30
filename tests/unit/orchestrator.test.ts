import { describe, it, expect, vi } from "vitest";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type {
  StateStore,
  WorkspaceRunner,
  ReviewConnector,
  TicketConnector,
  Task,
  ReviewComment,
} from "../../src/interfaces.js";
import {
  makeTaskId,
  makeTicketId,
  makeExternalChangeId,
  makeProjectId,
} from "../../src/interfaces.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: makeTaskId("task-1"),
    ticketId: makeTicketId("ticket-1"),
    ticketSourceLabel: "redmine",
    ticketTitle: "Add retry handling",
    ticketDescription: "Implement retry logic.",
    state: "IN_REVIEW",
    taskType: "code-gen",
    externalChangeId: makeExternalChangeId("I123"),
    currentPatchset: 2,
    reviewedPatchset: null,
    projectId: makeProjectId("proj-1"),
    cycleCount: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    failureReason: null,
    ticketUrl: null,
    reviewUrl: null,
    displayId: null,
    ...overrides,
  };
}

function makeComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: "comment-1",
    author: "reviewer@example.com",
    message: "Please address this",
    unresolved: true,
    patchset: 1,
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("Orchestrator", () => {
  it("skips resolution when there is no new actionable feedback", async () => {
    const task = makeTask();
    const comment = makeComment();

    const stateStore: StateStore = {
      getProcessedCommentIds: vi.fn().mockResolvedValue(new Set([comment.id])),
      getStateTransitions: vi.fn().mockResolvedValue([]),
      getChangesForTask: vi.fn().mockResolvedValue([]),
      transition: vi
        .fn()
        .mockResolvedValueOnce({ ...task, state: "FEEDBACK_PROCESSING" })
        .mockResolvedValueOnce({ ...task, state: "IN_REVIEW" }),
    } as unknown as StateStore;

    const workspaceRunner: WorkspaceRunner = {
      createWorkspace: vi.fn(),
      cloneRepo: vi.fn(),
      runAgent: vi.fn(),
      destroyWorkspace: vi.fn(),
    };

    const gerritConnector: ReviewConnector = {
      getChangeStatus: vi.fn().mockResolvedValue("OPEN"),
      getUnresolvedComments: vi.fn().mockResolvedValue([comment]),
      resolveComments: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReviewConnector;

    const redmineConnector: TicketConnector = {
      getTicket: vi.fn(),
      getAssignedTickets: vi.fn(),
      addNote: vi.fn(),
      transitionStatus: vi.fn(),
      transitionToInProgress: vi.fn(),
      transitionToInReview: vi.fn(),
      closeTicket: vi.fn(),
      getSourceLabel: vi.fn().mockReturnValue("redmine"),
    };

    const orchestrator = new Orchestrator(
      {
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        agentTimeoutMs: 1000,
        gitAuthorName: "Virtual Engineer",
        gitAuthorEmail: "ve@example.com",
        agentContainerImage: "virtual-engineer-workspace:latest",
      },
      stateStore,
      workspaceRunner,
      undefined,
      undefined,
      makeProjectMode({ gerritConnector, redmineConnector })
    );

    await (orchestrator as any).checkReviewProgress(task);

    // When there's no new actionable feedback, we should NOT try to resolve previously processed comments.
    // Resolution only happens after new feedback triggers an agent cycle.
    expect(gerritConnector.getUnresolvedComments).toHaveBeenCalledWith(
      task.externalChangeId,
      task.currentPatchset
    );
    expect(gerritConnector.resolveComments).not.toHaveBeenCalled();
    expect(workspaceRunner.runAgent).not.toHaveBeenCalled();
    expect(stateStore.transition).toHaveBeenNthCalledWith(1, task.taskId, "FEEDBACK_PROCESSING");
    expect(stateStore.transition).toHaveBeenNthCalledWith(2, task.taskId, "IN_REVIEW");
  });

  it("anchors the review to the latest patchset, not the root", async () => {
    const task = makeTask({ currentPatchset: 4 });

    const stateStore: StateStore = {
      getProcessedCommentIds: vi.fn().mockResolvedValue(new Set()),
      getStateTransitions: vi.fn().mockResolvedValue([]),
      getChangesForTask: vi.fn().mockResolvedValue([]),
      transition: vi
        .fn()
        .mockResolvedValueOnce({ ...task, state: "FEEDBACK_PROCESSING" })
        .mockResolvedValueOnce({ ...task, state: "IN_REVIEW" }),
    } as unknown as StateStore;

    const workspaceRunner: WorkspaceRunner = {
      createWorkspace: vi.fn(),
      cloneRepo: vi.fn(),
      runAgent: vi.fn(),
      destroyWorkspace: vi.fn(),
    };

    const gerritConnector: ReviewConnector = {
      getChangeStatus: vi.fn().mockResolvedValue("OPEN"),
      getUnresolvedComments: vi.fn().mockResolvedValue([]),
      resolveComments: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReviewConnector;

    const redmineConnector: TicketConnector = {
      getTicket: vi.fn(),
      getAssignedTickets: vi.fn(),
      addNote: vi.fn(),
      transitionStatus: vi.fn(),
      transitionToInProgress: vi.fn(),
      transitionToInReview: vi.fn(),
      closeTicket: vi.fn(),
      getSourceLabel: vi.fn().mockReturnValue("redmine"),
    };

    const orchestrator = new Orchestrator(
      {
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        agentTimeoutMs: 1000,
        gitAuthorName: "Virtual Engineer",
        gitAuthorEmail: "ve@example.com",
        agentContainerImage: "virtual-engineer-workspace:latest",
      },
      stateStore,
      workspaceRunner,
      undefined,
      undefined,
      makeProjectMode({ gerritConnector, redmineConnector })
    );

    await (orchestrator as any).checkReviewProgress(task);

    expect(gerritConnector.getUnresolvedComments).toHaveBeenCalledWith(
      task.externalChangeId,
      4
    );
  });

  function makeRedmineTicket() {
    return {
      id: makeTicketId("ticket-1"),
      subject: "Add retry handling",
      description: [
        "Implement retry logic.",
        "- [ ] Preserve Change-Id",
        "1. Close the ticket on merge",
      ].join("\n"),
      status: "New",
      assigneeId: 5,
      projectId: 1,
      customFields: {},
    };
  }

  function makeStateStore(overrides: Partial<StateStore> = {}): StateStore {
    return {
      createTask: vi.fn(),
      getTask: vi.fn().mockResolvedValue(null),
      getTaskByTicketId: vi.fn().mockResolvedValue(null),
      getActiveTasks: vi.fn().mockResolvedValue([]),
      getFailedAttemptCount: vi.fn().mockResolvedValue(0),
      transition: vi.fn().mockImplementation(async (taskId, toState) => makeTask({ taskId, state: toState })),
      updateGerritChangeId: vi.fn().mockResolvedValue(undefined),
      incrementCycle: vi.fn().mockResolvedValue(1),
      setFailureReason: vi.fn().mockResolvedValue(undefined),
      saveAgentCycle: vi.fn().mockResolvedValue(undefined),
      updateAgentCycleCommitMessages: vi.fn().mockResolvedValue(undefined),
      getAgentCycles: vi.fn().mockResolvedValue([]),
      getStateTransitions: vi.fn().mockResolvedValue([]),
      getProcessedCommentIds: vi.fn().mockResolvedValue(new Set()),
      markCommentProcessed: vi.fn().mockResolvedValue(undefined),
      getChangesForTask: vi.fn().mockResolvedValue([]),
      saveChangePerRepository: vi.fn().mockResolvedValue(undefined),
      updateChangePerRepositoryStatus: vi.fn().mockResolvedValue(undefined),
      orphanExcessChanges: vi.fn().mockResolvedValue(0),
      findTaskByExternalChangeId: vi.fn().mockResolvedValue(null),
      getActiveRepoSetLock: vi.fn().mockResolvedValue(null),
      ...overrides,
    } as unknown as StateStore;
  }

  function makeWorkspaceRunner(overrides: Partial<WorkspaceRunner> = {}): WorkspaceRunner {
    return {
      createWorkspace: vi.fn().mockResolvedValue({
        taskId: makeTaskId("task-1"),
        containerId: "container-1",
        volumeName: "volume-1",
        hostWorkspacePath: "/tmp/ve-task-1",
      }),
      cloneRepo: vi.fn().mockResolvedValue({ success: true, localPath: "/tmp/ve-task-1" }),
      runAgent: vi.fn().mockResolvedValue({
        status: "success",
        modifiedFiles: ["src/index.ts"],
        summary: "Updated src/index.ts",
        agentLogs: "ok",
        gerritChangeId: makeExternalChangeId("I123"),
        commitSha: "abc123",
        metadata: { adapter: "mock" },
      }),
      destroyWorkspace: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    } as unknown as WorkspaceRunner;
  }

  function makeGerritConnector(overrides: Partial<ReviewConnector> = {}): ReviewConnector {
    return {
      getChange: vi.fn().mockResolvedValue({
        changeId: makeExternalChangeId("I123"),
        changeNumber: 1,
        patchsetNumber: 2,
        url: "http://localhost:8080/c/1",
      }),
      getChangeStatus: vi.fn().mockResolvedValue("OPEN"),
      getUnresolvedComments: vi.fn().mockResolvedValue([]),
      addChangeComment: vi.fn().mockResolvedValue(undefined),
      resolveComments: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    } as unknown as ReviewConnector;
  }

  function makeRedmineConnector(overrides: Partial<TicketConnector> = {}): TicketConnector {
    return {
      getAssignedTickets: vi.fn().mockResolvedValue([]),
      getTicket: vi.fn().mockResolvedValue(makeRedmineTicket()),
      addNote: vi.fn().mockResolvedValue(undefined),
      transitionStatus: vi.fn().mockResolvedValue(undefined),
      transitionToInProgress: vi.fn().mockResolvedValue(undefined),
      transitionToInReview: vi.fn().mockResolvedValue(undefined),
      closeTicket: vi.fn().mockResolvedValue(undefined),
      getSourceLabel: vi.fn().mockReturnValue("redmine"),
      ...overrides,
    } as unknown as TicketConnector;
  }

  function makeProjectMode(overrides: {
    gerritConnector?: ReviewConnector;
    redmineConnector?: TicketConnector;
  } = {}) {
    const gc = overrides.gerritConnector ?? makeGerritConnector();
    const rc = overrides.redmineConnector ?? makeRedmineConnector();
    return {
      projectStore: {
        getProjectById: vi.fn().mockResolvedValue(null),
        listProjectPushTargets: vi.fn().mockResolvedValue([{ integrationId: "gerrit-int" }]),
        getProjectTicketSource: vi.fn().mockResolvedValue({ integrationId: "redmine-int" }),
        getProjectReviewConfig: vi.fn().mockResolvedValue(null),
        getAgentById: vi.fn().mockResolvedValue(null),
      },
      pluginManager: {
        getConnectorForIntegration: vi.fn().mockImplementation((id: string) => {
          if (id === "redmine-int") return rc;
          if (id === "gerrit-int") return gc;
          return null;
        }),
      },
    };
  }

  function makeOrchestrator(overrides: {
    stateStore?: StateStore;
    workspaceRunner?: WorkspaceRunner;
    gerritConnector?: ReviewConnector;
    redmineConnector?: TicketConnector;
  } = {}) {
    return new Orchestrator(
      {
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        agentTimeoutMs: 1000,
        gitAuthorName: "Virtual Engineer",
        gitAuthorEmail: "ve@example.com",
        agentContainerImage: "virtual-engineer-workspace:latest",
      },
      overrides.stateStore ?? makeStateStore(),
      overrides.workspaceRunner ?? makeWorkspaceRunner(),
      undefined,
      undefined,
      makeProjectMode({
        ...(overrides.gerritConnector ? { gerritConnector: overrides.gerritConnector } : {}),
        ...(overrides.redmineConnector ? { redmineConnector: overrides.redmineConnector } : {}),
      })
    );
  }

  it("ignores Gerrit events with no matching active task", async () => {
    const stateStore = makeStateStore({ findTaskByExternalChangeId: vi.fn().mockResolvedValue(null) });
    const orchestrator = makeOrchestrator({ stateStore });

    await orchestrator.handleGerritEvent(makeExternalChangeId("Imissing"));

    expect(stateStore.findTaskByExternalChangeId).toHaveBeenCalledWith(null, "Imissing");
  });

  it("ignores Gerrit events for tasks not in IN_REVIEW", async () => {
    const gerritChangeId = makeExternalChangeId("I123");
    const stateStore = makeStateStore({
      findTaskByExternalChangeId: vi.fn().mockResolvedValue(
        makeTask({ state: "AGENT_RUNNING", externalChangeId: gerritChangeId }),
      ),
    });
    const gerritConnector = makeGerritConnector();
    const orchestrator = makeOrchestrator({ stateStore, gerritConnector });

    await orchestrator.handleGerritEvent(gerritChangeId);

    expect(gerritConnector.getChangeStatus).not.toHaveBeenCalled();
  });

  it("delegates Gerrit events to review progress for matching IN_REVIEW tasks", async () => {
    const gerritChangeId = makeExternalChangeId("Idelegate");
    const task = makeTask({ state: "IN_REVIEW", externalChangeId: gerritChangeId });
    const stateStore = makeStateStore({
      findTaskByExternalChangeId: vi.fn().mockResolvedValue(task),
    });
    const orchestrator = makeOrchestrator({ stateStore });
    const checkReviewProgress = vi.spyOn(orchestrator as any, "checkReviewProgress").mockResolvedValue(undefined);

    await orchestrator.handleGerritEvent(gerritChangeId);

    expect(checkReviewProgress).toHaveBeenCalledWith(task);
  });

  it("ignores Gerrit events for terminal tasks", async () => {
    const gerritChangeId = makeExternalChangeId("Idone");
    const stateStore = makeStateStore({
      findTaskByExternalChangeId: vi.fn().mockResolvedValue(
        makeTask({ state: "DONE", externalChangeId: gerritChangeId }),
      ),
    });
    const orchestrator = makeOrchestrator({ stateStore });
    const checkReviewProgress = vi.spyOn(orchestrator as any, "checkReviewProgress").mockResolvedValue(undefined);

    await orchestrator.handleGerritEvent(gerritChangeId);

    expect(checkReviewProgress).not.toHaveBeenCalled();
  });

  it("continues resuming remaining tasks when one resumed workflow fails", async () => {
    const taskA = makeTask({ taskId: makeTaskId("task-a"), state: "DETECTED" });
    const taskB = makeTask({ taskId: makeTaskId("task-b"), state: "IN_REVIEW" });
    const stateStore = makeStateStore({ getActiveTasks: vi.fn().mockResolvedValue([taskA, taskB]) });
    const orchestrator = makeOrchestrator({ stateStore });
    const runWorkflow = vi.spyOn(orchestrator as any, "runWorkflow")
      .mockRejectedValueOnce(new Error("resume failed"))
      .mockResolvedValueOnce(undefined);

    await orchestrator.resumeActiveTasks();
    await new Promise((resolve) => setImmediate(resolve));

    expect(runWorkflow).toHaveBeenCalledTimes(2);
  });

  it("dispatches workflow handlers for each non-terminal state", async () => {
    const orchestrator = makeOrchestrator();
    const runFromDetected = vi.spyOn(orchestrator as any, "runFromDetected").mockResolvedValue(undefined);
    const runFromContextBuilding = vi.spyOn(orchestrator as any, "runFromContextBuilding").mockResolvedValue(undefined);
    const runAgentCycle = vi.spyOn(orchestrator as any, "runAgentCycle").mockResolvedValue(undefined);
    const checkReviewProgress = vi.spyOn(orchestrator as any, "checkReviewProgress").mockResolvedValue(undefined);
    const processFeedback = vi.spyOn(orchestrator as any, "processFeedback").mockResolvedValue(undefined);
    const closeTicket = vi.spyOn(orchestrator as any, "closeTicket").mockResolvedValue(undefined);

    await (orchestrator as any).runWorkflow(makeTask({ state: "DETECTED" }));
    await (orchestrator as any).runWorkflow(makeTask({ state: "CONTEXT_BUILDING" }));
    await (orchestrator as any).runWorkflow(makeTask({ state: "AGENT_RUNNING" }));
    await (orchestrator as any).runWorkflow(makeTask({ state: "RETRY_CYCLE" }));
    await (orchestrator as any).runWorkflow(makeTask({ state: "IN_REVIEW" }));
    await (orchestrator as any).runWorkflow(makeTask({ state: "FEEDBACK_PROCESSING" }));
    await (orchestrator as any).runWorkflow(makeTask({ state: "MERGED" }));
    await (orchestrator as any).runWorkflow(makeTask({ state: "CLOSING" }));
    await (orchestrator as any).runWorkflow(makeTask({ state: "DONE" }));
    await (orchestrator as any).runWorkflow(makeTask({ state: "FAILED" }));
    await (orchestrator as any).runWorkflow(makeTask({ state: "ABANDONED" }));

    expect(runFromDetected).toHaveBeenCalledTimes(1);
    expect(runFromContextBuilding).toHaveBeenCalledTimes(1);
    expect(runAgentCycle).toHaveBeenCalledTimes(2);
    expect(checkReviewProgress).toHaveBeenCalledTimes(1);
    expect(processFeedback).toHaveBeenCalledTimes(1);
    expect(closeTicket).toHaveBeenCalledTimes(2);
  });

  it("records a fatal error when a workflow handler throws", async () => {
    const orchestrator = makeOrchestrator();
    vi.spyOn(orchestrator as any, "runFromDetected").mockRejectedValue(new Error("boom"));
    const handleFatalError = vi.spyOn(orchestrator as any, "handleFatalError").mockResolvedValue(undefined);

    await (orchestrator as any).runWorkflow(makeTask({ state: "DETECTED" }));

    expect(handleFatalError).toHaveBeenCalledWith(expect.objectContaining({ state: "DETECTED" }), expect.any(Error));
  });

  it("moves merged changes through ticket closing", async () => {
    const task = makeTask({ state: "IN_REVIEW" });
    const stateStore = makeStateStore({
      getTask: vi.fn().mockResolvedValue(makeTask({ state: "IN_REVIEW" })),
      transition: vi.fn()
        .mockResolvedValueOnce(makeTask({ state: "MERGED" }))
        .mockResolvedValueOnce(makeTask({ state: "CLOSING" }))
        .mockResolvedValueOnce(makeTask({ state: "DONE" })),
    });
    const gerritConnector = makeGerritConnector({ getChangeStatus: vi.fn().mockResolvedValue("MERGED") });
    const redmineConnector = makeRedmineConnector();
    const orchestrator = makeOrchestrator({ stateStore, gerritConnector, redmineConnector });

    await (orchestrator as any).checkReviewProgress(task);

    expect(stateStore.transition).toHaveBeenCalledWith(task.taskId, "MERGED");
    expect(redmineConnector.closeTicket).toHaveBeenCalledWith(
      task.ticketId,
      expect.stringContaining(String(task.externalChangeId))
    );
    expect(stateStore.transition).toHaveBeenCalledWith(task.taskId, "DONE");
  });

  it("marks merged tasks as failed if Redmine closing keeps failing", async () => {
    vi.useFakeTimers();
    try {
      const task = makeTask({ state: "MERGED" });
      const stateStore = makeStateStore({
        transition: vi.fn()
          .mockResolvedValueOnce(makeTask({ state: "CLOSING" }))
          .mockResolvedValueOnce(makeTask({ state: "FAILED" })),
      });
      const redmineConnector = makeRedmineConnector({ closeTicket: vi.fn().mockRejectedValue(new Error("redmine down")) });
      const orchestrator = makeOrchestrator({ stateStore, redmineConnector });

      const promise = (orchestrator as any).closeTicket(task);
      await vi.runAllTimersAsync();
      await promise;

      expect(stateStore.setFailureReason).toHaveBeenCalledWith(
        task.taskId,
        expect.stringContaining("Ticket close failed (change is merged): redmine down")
      );
      expect(stateStore.transition).toHaveBeenCalledWith(task.taskId, "FAILED");
    } finally {
      vi.useRealTimers();
    }
  });

  it("abandons a task when Gerrit marks the change abandoned", async () => {
    const task = makeTask({ state: "IN_REVIEW" });
    const gerritConnector = makeGerritConnector({ getChangeStatus: vi.fn().mockResolvedValue("ABANDONED") });
    const orchestrator = makeOrchestrator({ gerritConnector });
    const handleAbandoned = vi.spyOn(orchestrator as any, "handleAbandoned").mockResolvedValue(undefined);

    await (orchestrator as any).checkReviewProgress(task);

    expect(handleAbandoned).toHaveBeenCalledWith(task, "change was abandoned externally");
  });

  it("returns early when IN_REVIEW tasks do not yet have a Gerrit Change-Id", async () => {
    const task = makeTask({ state: "IN_REVIEW", externalChangeId: null });
    const gerritConnector = makeGerritConnector();
    const orchestrator = makeOrchestrator({ gerritConnector });

    await (orchestrator as any).checkReviewProgress(task);

    expect(gerritConnector.getChangeStatus).not.toHaveBeenCalled();
  });

  it("returns to IN_REVIEW when no new actionable comments remain", async () => {
    const task = makeTask({ state: "IN_REVIEW" });
    const comment = makeComment({ unresolved: false });
    const stateStore = makeStateStore({
      transition: vi.fn()
        .mockResolvedValueOnce(makeTask({ state: "FEEDBACK_PROCESSING" }))
        .mockResolvedValueOnce(makeTask({ state: "IN_REVIEW" })),
      getProcessedCommentIds: vi.fn().mockResolvedValue(new Set()),
    });
    const gerritConnector = makeGerritConnector({ getUnresolvedComments: vi.fn().mockResolvedValue([comment]) });
    const orchestrator = makeOrchestrator({ stateStore, gerritConnector });

    await (orchestrator as any).checkReviewProgress(task);

    expect(stateStore.transition).toHaveBeenNthCalledWith(1, task.taskId, "FEEDBACK_PROCESSING");
    expect(stateStore.transition).toHaveBeenNthCalledWith(2, task.taskId, "IN_REVIEW");
  });

  it("abandons review feedback when max cycle count has already been reached", async () => {
    const task = makeTask({ state: "IN_REVIEW", cycleCount: 4 });
    const comment = makeComment();
    const stateStore = makeStateStore({
      transition: vi.fn().mockResolvedValue(makeTask({ state: "FEEDBACK_PROCESSING", cycleCount: 4 })),
      getProcessedCommentIds: vi.fn().mockResolvedValue(new Set()),
      markCommentProcessed: vi.fn().mockResolvedValue(undefined),
    });
    const gerritConnector = makeGerritConnector({ getUnresolvedComments: vi.fn().mockResolvedValue([comment]) });
    const orchestrator = makeOrchestrator({ stateStore, gerritConnector });
    const handleAbandoned = vi.spyOn(orchestrator as any, "handleAbandoned").mockResolvedValue(undefined);

    await (orchestrator as any).checkReviewProgress(task);

    expect(stateStore.markCommentProcessed).toHaveBeenCalledWith(task.taskId, comment.id);
    expect(handleAbandoned).toHaveBeenCalledWith(expect.objectContaining({ state: "FEEDBACK_PROCESSING" }), "Max cycles 3 reached during review");
  });

  it("retries actionable feedback and tolerates Gerrit resolution failures", async () => {
    const task = makeTask({ state: "IN_REVIEW", cycleCount: 1 });
    const comment = makeComment({ filePath: "src/index.ts", line: 12 });

    // Track processed comment IDs across calls
    const processedIds = new Set<string>();
    const stateStore = makeStateStore({
      transition: vi.fn()
        .mockResolvedValueOnce(makeTask({ state: "FEEDBACK_PROCESSING", cycleCount: 1 }))
        .mockResolvedValueOnce(makeTask({ state: "RETRY_CYCLE", cycleCount: 1 })),
      getTask: vi.fn().mockResolvedValue(makeTask({ state: "IN_REVIEW", cycleCount: 2 })),
      getProcessedCommentIds: vi.fn().mockImplementation(() => Promise.resolve(new Set(processedIds))),
      markCommentProcessed: vi.fn().mockImplementation((_, id) => {
        processedIds.add(id);
        return Promise.resolve();
      }),
    });
    const gerritConnector = makeGerritConnector({
      getUnresolvedComments: vi.fn().mockResolvedValue([comment]),
      resolveComments: vi.fn().mockRejectedValue(new Error("cannot resolve now")),
    });
    const orchestrator = makeOrchestrator({ stateStore, gerritConnector });
    const runAgentCycle = vi.spyOn(orchestrator as any, "runAgentCycle").mockResolvedValue(undefined);

    await (orchestrator as any).checkReviewProgress(task);

    expect(stateStore.markCommentProcessed).toHaveBeenCalledWith(task.taskId, comment.id);
    expect(runAgentCycle).toHaveBeenCalledWith(
      expect.objectContaining({ state: "RETRY_CYCLE" }),
      expect.arrayContaining([expect.objectContaining({ source: "gerrit_review" })]),
    );
    expect(gerritConnector.resolveComments).toHaveBeenCalledWith(task.externalChangeId, [comment]);
  });

  it("continues review processing when new feedback triggers agent cycle", async () => {
    const task = makeTask({ state: "IN_REVIEW", cycleCount: 1 });
    const comment = makeComment();

    // Track which comment IDs have been processed
    const processedIds = new Set<string>();

    const stateStore = makeStateStore({
      getProcessedCommentIds: vi.fn().mockImplementation(() => Promise.resolve(new Set(processedIds))),
      markCommentProcessed: vi.fn().mockImplementation((_, id) => {
        processedIds.add(id);
        return Promise.resolve();
      }),
      getTask: vi.fn().mockResolvedValue(makeTask({ state: "IN_REVIEW", cycleCount: 2 })),
      transition: vi.fn()
        .mockResolvedValueOnce(makeTask({ state: "FEEDBACK_PROCESSING", cycleCount: 1 }))
        .mockResolvedValueOnce(makeTask({ state: "RETRY_CYCLE", cycleCount: 1 })),
    });
    const gerritConnector = makeGerritConnector({
      getUnresolvedComments: vi.fn().mockResolvedValue([comment]),
      resolveComments: vi.fn().mockResolvedValue(undefined),
    });
    const orchestrator = makeOrchestrator({ stateStore, gerritConnector });
    const runAgentCycle = vi.spyOn(orchestrator as any, "runAgentCycle").mockResolvedValue(undefined);

    await (orchestrator as any).checkReviewProgress(task);

    // When there's new feedback, agent cycle runs and comments are resolved
    expect(stateStore.markCommentProcessed).toHaveBeenCalledWith(task.taskId, comment.id);
    expect(runAgentCycle).toHaveBeenCalled();
    expect(gerritConnector.resolveComments).toHaveBeenCalledWith(task.externalChangeId, [comment]);
    expect(stateStore.transition).toHaveBeenNthCalledWith(1, task.taskId, "FEEDBACK_PROCESSING");
    expect(stateStore.transition).toHaveBeenNthCalledWith(2, task.taskId, "RETRY_CYCLE");
  });

  it("does not resolve Gerrit comments when feedback retry abandons with no changes", async () => {
    const task = makeTask({ state: "IN_REVIEW", cycleCount: 1 });
    const comment = makeComment();
    const processedIds = new Set<string>();

    const stateStore = makeStateStore({
      getProcessedCommentIds: vi.fn().mockImplementation(() => Promise.resolve(new Set(processedIds))),
      getTask: vi.fn().mockResolvedValue(
        makeTask({
          state: "ABANDONED",
          cycleCount: 2,
          failureReason: "Agent produced no changes after cycle 2",
        })
      ),
      markCommentProcessed: vi.fn().mockImplementation((_, id) => {
        processedIds.add(id);
        return Promise.resolve();
      }),
      transition: vi.fn()
        .mockResolvedValueOnce(makeTask({ state: "FEEDBACK_PROCESSING", cycleCount: 1 }))
        .mockResolvedValueOnce(makeTask({ state: "RETRY_CYCLE", cycleCount: 1 })),
    });
    const gerritConnector = makeGerritConnector({
      getUnresolvedComments: vi.fn().mockResolvedValue([comment]),
      resolveComments: vi.fn().mockResolvedValue(undefined),
    });
    const orchestrator = makeOrchestrator({ stateStore, gerritConnector });
    const runAgentCycle = vi.spyOn(orchestrator as any, "runAgentCycle").mockResolvedValue(undefined);

    await (orchestrator as any).checkReviewProgress(task);

    expect(stateStore.markCommentProcessed).toHaveBeenCalledWith(task.taskId, comment.id);
    expect(runAgentCycle).toHaveBeenCalledWith(
      expect.objectContaining({ state: "RETRY_CYCLE" }),
      expect.arrayContaining([expect.objectContaining({ source: "gerrit_review" })]),
    );
    expect(stateStore.getTask).toHaveBeenCalledWith(task.taskId);
    expect(gerritConnector.resolveComments).not.toHaveBeenCalled();
  });

  it("delegates FEEDBACK_PROCESSING recovery back to review progress", async () => {
    const task = makeTask({ state: "FEEDBACK_PROCESSING" });
    const orchestrator = makeOrchestrator();
    const checkReviewProgress = vi.spyOn(orchestrator as any, "checkReviewProgress").mockResolvedValue(undefined);

    await (orchestrator as any).processFeedback(task);

    expect(checkReviewProgress).toHaveBeenCalledWith(task);
  });

  it("suppresses secondary state-store failures while recording fatal errors", async () => {
    const task = makeTask({ state: "AGENT_RUNNING" });
    const stateStore = makeStateStore({
      setFailureReason: vi.fn().mockRejectedValue(new Error("db unavailable")),
    });
    const redmineConnector = makeRedmineConnector();
    const orchestrator = makeOrchestrator({ stateStore, redmineConnector });

    await expect((orchestrator as any).handleFatalError(task, new Error("boom"))).resolves.toBeUndefined();
    expect(redmineConnector.addNote).not.toHaveBeenCalled();
  });

  it("posts a ticket note for genuine task failures", async () => {
    const task = makeTask({ state: "AGENT_RUNNING" });
    const stateStore = makeStateStore({ getTask: vi.fn().mockResolvedValue(task) });
    const redmineConnector = makeRedmineConnector();
    const orchestrator = makeOrchestrator({ stateStore, redmineConnector });

    await (orchestrator as any).handleFatalError(task, new Error("merge conflict in src/index.ts"));

    expect(stateStore.transition).toHaveBeenCalledWith(task.taskId, "FAILED", expect.any(Object));
    expect(redmineConnector.addNote).toHaveBeenCalledWith(
      task.ticketId,
      expect.stringContaining("Virtual Engineer encountered an error"),
      false
    );
  });

  it("does not post infrastructure/connection errors to the ticket", async () => {
    const task = makeTask({ state: "AGENT_RUNNING" });
    const stateStore = makeStateStore({ getTask: vi.fn().mockResolvedValue(task) });
    const redmineConnector = makeRedmineConnector();
    const orchestrator = makeOrchestrator({ stateStore, redmineConnector });

    await (orchestrator as any).handleFatalError(
      task,
      new Error("ssh: connect to host gerrit.example.com port 29418: Connection refused")
    );

    // Failure is still recorded for the admin UI…
    expect(stateStore.setFailureReason).toHaveBeenCalled();
    expect(stateStore.transition).toHaveBeenCalledWith(task.taskId, "FAILED", expect.any(Object));
    // …but it is NOT echoed back to the ticket.
    expect(redmineConnector.addNote).not.toHaveBeenCalled();
  });

  it("extracts acceptance criteria and enforces timeouts", async () => {
    vi.useFakeTimers();
    try {
      const orchestrator = makeOrchestrator();
      expect((orchestrator as any).extractAcceptanceCriteria(makeRedmineTicket().description)).toEqual([
        "- [ ] Preserve Change-Id",
        "1. Close the ticket on merge",
      ]);

      const timeoutPromise = (orchestrator as any).withTimeout(
        new Promise<string>(() => undefined),
        25,
        "timed out"
      );
      const assertion = expect(timeoutPromise).rejects.toThrow("timed out");

      await vi.advanceTimersByTimeAsync(25);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("records abandonment details and notifies Redmine", async () => {
    const task = makeTask({ state: "AGENT_RUNNING" });
    const stateStore = makeStateStore();
    const redmineConnector = makeRedmineConnector();
    const orchestrator = makeOrchestrator({ stateStore, redmineConnector });

    await (orchestrator as any).handleAbandoned(task, "review abandoned");

    expect(stateStore.setFailureReason).toHaveBeenCalledWith(task.taskId, "review abandoned");
    expect(stateStore.transition).toHaveBeenCalledWith(task.taskId, "ABANDONED");
    expect(redmineConnector.addNote).toHaveBeenCalledWith(
      task.ticketId,
      expect.stringContaining("Reason: review abandoned"),
      false
    );
  });

  it("records no-change failures and notifies Redmine", async () => {
    const task = makeTask({ state: "AGENT_RUNNING" });
    const stateStore = makeStateStore();
    const redmineConnector = makeRedmineConnector();
    const orchestrator = makeOrchestrator({ stateStore, redmineConnector });

    await (orchestrator as any).handleNoChange(task, 2);

    expect(stateStore.setFailureReason).toHaveBeenCalledWith(
      task.taskId,
      "Agent produced no changes after cycle 2"
    );
    expect(stateStore.transition).toHaveBeenCalledWith(task.taskId, "ABANDONED");
    expect(redmineConnector.addNote).toHaveBeenCalledWith(
      task.ticketId,
      expect.stringContaining("Agent produced no changes after cycle 2"),
      false
    );
  });

  it("swallows Redmine note failures while notifying abandonment", async () => {
    const task = makeTask({ state: "AGENT_RUNNING" });
    const redmineConnector = makeRedmineConnector({ addNote: vi.fn().mockRejectedValue(new Error("note failed")) });
    const orchestrator = makeOrchestrator({ redmineConnector });

    await expect((orchestrator as any).notifyTicketFailure(task, "boom")).resolves.toBeUndefined();
  });

  it("buildPriorFeedback returns only failed-cycle agent logs", async () => {
    const task = makeTask({ state: "AGENT_RUNNING" });
    const stateStore = makeStateStore({
      getAgentCycles: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 1,
            taskId: task.taskId,
            cycleNumber: 1,
            result: {
              status: "success",
              modifiedFiles: [],
              summary: "ok",
              agentLogs: "",
              metadata: {},
            },
            validationResult: null,
            createdAt: new Date(),
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 2,
            taskId: task.taskId,
            cycleNumber: 2,
            result: {
              status: "failed",
              modifiedFiles: [],
              summary: "failed",
              agentLogs: "x".repeat(4000),
              metadata: {},
            },
            validationResult: null,
            createdAt: new Date(),
          },
        ]),
    });
    const orchestrator = makeOrchestrator({ stateStore });

    await expect((orchestrator as any).buildPriorFeedback(task)).resolves.toEqual([]);
    await expect((orchestrator as any).buildPriorFeedback(task)).resolves.toEqual([]);
    await expect((orchestrator as any).buildPriorFeedback(task)).resolves.toEqual([
      expect.objectContaining({ source: "lint_failure", content: "x".repeat(3000) }),
    ]);
  });

  it("builds the expected commit message format", () => {
    const task = makeTask({ ticketId: makeTicketId("42") });
    const orchestrator = makeOrchestrator();

    expect((orchestrator as any).buildCommitMessage(task, "Fix parser")).toBe("feat: Fix parser");
  });

  // ─── Issue 1: GitLab Review System Not Fully Supported ────────────────────

  describe("GitLab review system support", () => {
    it("when reviewSystem=gitlab, Gerrit-specific config fields are optional", async () => {
      const stateStore = makeStateStore({ getAgentCycles: vi.fn().mockResolvedValue([]) });
      const workspaceRunner = makeWorkspaceRunner();
      const gerritConnector = makeGerritConnector();
      const redmineConnector = makeRedmineConnector();

      const orchestrator = new Orchestrator(
        {
          maxAgentCycles: 3,
          maxRetryAttempts: 5,
          agentTimeoutMs: 1000,
          gitAuthorName: "Virtual Engineer",
          gitAuthorEmail: "ve@example.com",
          agentContainerImage: "virtual-engineer-workspace:latest",
        },
        stateStore,
        workspaceRunner,
        undefined,
        undefined,
        makeProjectMode({ gerritConnector, redmineConnector })
      );

      // This should not throw on initialization
      expect(orchestrator).toBeDefined();
    });
  });

  // ─── Issue 4: Missing GitLab Configuration Validation in Orchestrator ────────

  describe("Issue 4: GitLab configuration validation", () => {
    it("accepts gitlab mode when all GitLab fields are populated", () => {
      const config = {
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        agentTimeoutMs: 1000,
        gitAuthorName: "Virtual Engineer",
        gitAuthorEmail: "ve@example.com",
        agentContainerImage: "ve-workspace:latest",
      };

      // Should not throw or error
      const orchestrator = new Orchestrator(
        config,
        makeStateStore(),
        makeWorkspaceRunner()
      );
      expect(orchestrator).toBeDefined();
    });

    it("allows gerrit mode when all Gerrit fields are populated", () => {
      const config = {
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        agentTimeoutMs: 1000,
        gitAuthorName: "Virtual Engineer",
        gitAuthorEmail: "ve@example.com",
        agentContainerImage: "ve-workspace:latest",
      };

      const orchestrator = new Orchestrator(
        config,
        makeStateStore(),
        makeWorkspaceRunner()
      );
      expect(orchestrator).toBeDefined();
    });

    it("accepts gerrit mode when gerritSshHost is missing (UI-config mode — deferred validation)", () => {
      const config = {
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        agentTimeoutMs: 1000,
        gitAuthorName: "Virtual Engineer",
        gitAuthorEmail: "ve@example.com",
        agentContainerImage: "ve-workspace:latest",
      };

      // gerritSshHost missing → UI-config mode; no throw at construction time
      expect(() => {
        new Orchestrator(
          config,
          makeStateStore(),
          makeWorkspaceRunner()
        );
      }).not.toThrow();
    });
  });

  // ─── Issue 5: Timeout Implementation Missing Cleanup on Rejection ────────────

  describe("Issue 5: withTimeout timer cleanup", () => {
    it("clears timer when promise resolves", async () => {
      vi.useFakeTimers();
      try {
        const orchestrator = makeOrchestrator();
        const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

        const result = await (orchestrator as any).withTimeout(
          Promise.resolve("success"),
          1000,
          "timeout"
        );

        expect(result).toBe("success");
        expect(clearTimeoutSpy).toHaveBeenCalled();
        clearTimeoutSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears timer when promise rejects before timeout fires", async () => {
      vi.useFakeTimers();
      try {
        const orchestrator = makeOrchestrator();
        const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

        const promise = (orchestrator as any).withTimeout(
          Promise.reject(new Error("inner error")),
          1000,
          "timeout"
        );

        await expect(promise).rejects.toThrow("inner error");
        expect(clearTimeoutSpy).toHaveBeenCalled();
        clearTimeoutSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears timer when timeout fires", async () => {
      vi.useFakeTimers();
      try {
        const orchestrator = makeOrchestrator();
        const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

        const promise = (orchestrator as any).withTimeout(
          new Promise<never>(() => undefined),
          100,
          "timed out"
        );

        await vi.advanceTimersByTimeAsync(100);
        await expect(promise).rejects.toThrow("timed out");
        expect(clearTimeoutSpy).toHaveBeenCalled();
        clearTimeoutSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    it("propagates rejection from inner promise after timer cleanup", async () => {
      vi.useFakeTimers();
      try {
        const orchestrator = makeOrchestrator();

        const innerError = new Error("agent failed");
        const promise = (orchestrator as any).withTimeout(
          Promise.reject(innerError),
          5000,
          "timeout message"
        );

        await expect(promise).rejects.toThrow("agent failed");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not call setInterval or create stale timers", async () => {
      vi.useFakeTimers();
      try {
        const orchestrator = makeOrchestrator();
        const setIntervalSpy = vi.spyOn(global, "setInterval");

        await (orchestrator as any).withTimeout(Promise.resolve("ok"), 100, "timeout");

        expect(setIntervalSpy).not.toHaveBeenCalled();
        setIntervalSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ─── Issue 8: Redmine Note Addition Silently Fails on Closed Tickets ────────

  describe("Issue 8: Redmine note addition error handling", () => {
    it("logs warning when addNote fails but does not crash task", async () => {
      const task = makeTask({ state: "CLOSING", ticketId: makeTicketId("ticket-closed") });
      const stateStore = makeStateStore();
      const redmineConnector = makeRedmineConnector({
        addNote: vi.fn().mockRejectedValue(new Error("cannot add note to closed ticket")),
      });

      const orchestrator = makeOrchestrator({ stateStore, redmineConnector });

      // Should not throw even if addNote fails
      await expect((orchestrator as any).notifyTicketFailure(task, "some reason")).resolves.toBeUndefined();

      expect(redmineConnector.addNote).toHaveBeenCalled();
    });

    it("does not abandon task when closing ticket is attempted but addNote fails", async () => {
      const task = makeTask({ state: "MERGED" });
      const stateStore = makeStateStore({
        transition: vi.fn()
          .mockResolvedValueOnce(makeTask({ state: "CLOSING" }))
          .mockResolvedValueOnce(makeTask({ state: "DONE" })),
      });
      const redmineConnector = makeRedmineConnector({
        closeTicket: vi.fn().mockResolvedValue(undefined),
        addNote: vi.fn().mockRejectedValue(new Error("Note failed")),
      });

      const orchestrator = makeOrchestrator({ stateStore, redmineConnector });

      // closeTicket should succeed even if subsequent addNote call fails
      await expect((orchestrator as any).closeTicket(task)).resolves.not.toThrow();

      // Task should still transition to DONE
      expect(stateStore.transition).toHaveBeenCalledWith(task.taskId, "DONE");
    });

    it("includes failure reason in task logs when addNote fails on closed ticket", async () => {
      const task = makeTask({ state: "AGENT_RUNNING" });
      const failureError = new Error("Cannot add note to closed ticket");
      const stateStore = makeStateStore();
      const redmineConnector = makeRedmineConnector({
        addNote: vi.fn().mockRejectedValue(failureError),
      });

      const orchestrator = makeOrchestrator({ stateStore, redmineConnector });

      await (orchestrator as any).notifyTicketFailure(task, "boom");

      // Should attempt to call addNote
      expect(redmineConnector.addNote).toHaveBeenCalled();
    });

    it("continues task execution when addNote fails with 409 conflict", async () => {
      const task = makeTask({ state: "CLOSING" });
      const stateStore = makeStateStore({
        transition: vi.fn().mockResolvedValue(makeTask({ state: "DONE" })),
      });

      const conflictError = new Error("HTTP 409: Conflict");
      const redmineConnector = makeRedmineConnector({
        addNote: vi.fn().mockRejectedValue(conflictError),
      });

      const orchestrator = makeOrchestrator({ stateStore, redmineConnector });

      // Should not re-throw the conflict error
      await expect((orchestrator as any).notifyTicketFailure(task, "reason")).resolves.not.toThrow();

      // Task should still be able to transition
      expect(stateStore.transition).not.toHaveBeenCalledWith(task.taskId, "FAILED");
    });
  });

  describe("code-review task isolation", () => {
    it("resumeActiveTasks skips code-review tasks", async () => {
      const reviewTask = makeTask({
        taskId: makeTaskId("review-42-abc"),
        state: "REVIEW_PENDING" as any,
        taskType: "code-review",
      });
      const ticketTask = makeTask({ taskId: makeTaskId("ticket-1"), state: "DETECTED" });

      const stateStore = makeStateStore({
        getActiveTasks: vi.fn().mockResolvedValue([reviewTask, ticketTask]),
      });
      const orchestrator = makeOrchestrator({ stateStore });
      const runWorkflow = vi.spyOn(orchestrator as any, "runWorkflow").mockResolvedValue(undefined);

      await orchestrator.resumeActiveTasks();
      await new Promise((resolve) => setImmediate(resolve));

      // Only the ticket task should be dispatched; code-review task must be skipped
      expect(runWorkflow).toHaveBeenCalledTimes(1);
      expect(runWorkflow).toHaveBeenCalledWith(expect.objectContaining({ taskId: ticketTask.taskId }));
    });

    it("runWorkflow silently exits for code-review tasks without touching the ticket workflow", async () => {
      const reviewTask = makeTask({
        taskId: makeTaskId("review-42-abc"),
        state: "REVIEW_FAILED" as any,
        taskType: "code-review",
      });
      const orchestrator = makeOrchestrator();
      const runFromDetected = vi.spyOn(orchestrator as any, "runFromDetected");
      const runAgentCycle = vi.spyOn(orchestrator as any, "runAgentCycle");
      const handleFatalError = vi.spyOn(orchestrator as any, "handleFatalError");

      await (orchestrator as any).runWorkflow(reviewTask);

      expect(runFromDetected).not.toHaveBeenCalled();
      expect(runAgentCycle).not.toHaveBeenCalled();
      expect(handleFatalError).not.toHaveBeenCalled();
    });
  });

  // ─── Gerrit feedback loop regression ──────────────────────────────────────

  it("passes Gerrit review comments into runAgentCycle as reviewFeedback", async () => {
    const task = makeTask({ state: "IN_REVIEW", cycleCount: 1 });
    const comment = makeComment({ message: "Refactor this method", filePath: "src/foo.ts", line: 10 });

    const processedIds = new Set<string>();
    const stateStore = makeStateStore({
      getProcessedCommentIds: vi.fn().mockImplementation(() => Promise.resolve(new Set(processedIds))),
      markCommentProcessed: vi.fn().mockImplementation((_, id) => {
        processedIds.add(id);
        return Promise.resolve();
      }),
      getTask: vi.fn().mockResolvedValue(makeTask({ state: "IN_REVIEW", cycleCount: 2 })),
      transition: vi.fn()
        .mockResolvedValueOnce(makeTask({ state: "FEEDBACK_PROCESSING", cycleCount: 1 }))
        .mockResolvedValueOnce(makeTask({ state: "RETRY_CYCLE", cycleCount: 1 })),
    });
    const gerritConnector = makeGerritConnector({
      getUnresolvedComments: vi.fn().mockResolvedValue([comment]),
      resolveComments: vi.fn().mockResolvedValue(undefined),
    });
    const orchestrator = makeOrchestrator({ stateStore, gerritConnector });
    const runAgentCycle = vi.spyOn(orchestrator as any, "runAgentCycle").mockResolvedValue(undefined);

    await (orchestrator as any).checkReviewProgress(task);

    // runAgentCycle must receive the feedback items as second argument — not an empty array
    expect(runAgentCycle).toHaveBeenCalledWith(
      expect.objectContaining({ state: "RETRY_CYCLE" }),
      expect.arrayContaining([
        expect.objectContaining({
          source: "gerrit_review",
          content: expect.stringContaining("Refactor this method"),
        }),
      ])
    );
  });

  it("buildPriorFeedback merges review feedback with cycle logs", async () => {
    const task = makeTask({ state: "AGENT_RUNNING" });
    const stateStore = makeStateStore({
      getAgentCycles: vi.fn().mockResolvedValue([
        {
          id: 1,
          taskId: task.taskId,
          cycleNumber: 1,
          result: { status: "failed", modifiedFiles: [], summary: "bad", agentLogs: "lint error", metadata: {} },
          validationResult: null,
          createdAt: new Date(),
        },
      ]),
    });
    const orchestrator = makeOrchestrator({ stateStore });
    const reviewFeedback = [{ source: "gerrit_review" as const, content: "Please fix naming" }];

    const result = await (orchestrator as any).buildPriorFeedback(task, reviewFeedback);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ source: "lint_failure", content: "lint error" });
    expect(result[1]).toMatchObject({ source: "gerrit_review", content: "Please fix naming" });
  });
});