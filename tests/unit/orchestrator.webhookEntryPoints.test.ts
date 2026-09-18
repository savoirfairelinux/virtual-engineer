import { describe, it, expect, vi, beforeEach } from "vitest";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import {
  makeTaskId,
  makeTicketId,
  makeExternalChangeId,
  makeProjectId,
} from "../../src/interfaces.js";
import type {
  StateStore,
  Task,
  WorkspaceRunner,
  ReviewConnector,
} from "../../src/interfaces.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date();
  return {
    taskId: makeTaskId("task-1"),
    ticketId: makeTicketId("ticket-1"),
    ticketSourceLabel: "redmine",
    ticketTitle: "T",
    ticketDescription: "D",
    state: "IN_REVIEW",
    externalChangeId: makeExternalChangeId("Iabc"),
    currentPatchset: 1,
    cycleCount: 1,
    failureReason: null,
    ticketUrl: null,
    reviewUrl: null,
    reviewedPatchset: null,
    projectId: makeProjectId("proj-1"),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Task;
}

function makeStateStore(overrides: Partial<StateStore> = {}): StateStore {
  return {
    createTask: vi.fn(),
    getTask: vi.fn().mockResolvedValue(null),
    getTaskByTicketId: vi.fn().mockResolvedValue(null),
    getActiveTasks: vi.fn().mockResolvedValue([]),
    getFailedAttemptCount: vi.fn().mockResolvedValue(0),
    transition: vi.fn().mockImplementation(async (taskId, toState) => makeTask({ taskId, state: toState })),
    abandonTask: vi.fn().mockImplementation(async (taskId) => makeTask({ taskId, state: "ABANDONED" })),
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
    getActiveRepoSetLock: vi.fn().mockResolvedValue(null),
    findTaskByExternalChangeId: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as StateStore;
}

function makeWorkspaceRunner(): WorkspaceRunner {
  return {
    prepareWorkspace: vi.fn(),
    cleanupWorkspace: vi.fn(),
    runAgent: vi.fn(),
  } as unknown as WorkspaceRunner;
}

function makeReview(overrides: Partial<ReviewConnector> = {}): ReviewConnector {
  return {
    pushChange: vi.fn(),
    getChangeStatus: vi.fn().mockResolvedValue("OPEN"),
    getUnresolvedComments: vi.fn().mockResolvedValue([]),
    addChangeComment: vi.fn().mockResolvedValue(undefined),
    resolveComments: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ReviewConnector;
}

function makeOrchestrator(stateStore: StateStore, review: ReviewConnector = makeReview()): Orchestrator {
  const redmine = {
    getAssignedTickets: vi.fn().mockResolvedValue([]),
    getTicket: vi.fn().mockResolvedValue(null),
    addNote: vi.fn().mockResolvedValue(undefined),
    transitionStatus: vi.fn().mockResolvedValue(undefined),
    transitionToInProgress: vi.fn().mockResolvedValue(undefined),
    transitionToInReview: vi.fn().mockResolvedValue(undefined),
    closeTicket: vi.fn().mockResolvedValue(undefined),
    getSourceLabel: vi.fn().mockReturnValue("redmine"),
  };
  return new Orchestrator(
    {
      maxAgentCycles: 3,
      maxRetryAttempts: 5,
      agentTimeoutMs: 1000,
      gitAuthorName: "VE",
      gitAuthorEmail: "ve@example.com",
      agentContainerImage: "x:latest",
    },
    stateStore,
    makeWorkspaceRunner(),
    undefined,
    undefined,
    {
      projectStore: {
        getProjectById: vi.fn().mockResolvedValue(null),
        listProjectPushTargets: vi.fn().mockResolvedValue([{ integrationId: "gerrit-int" }]),
        getProjectTicketSource: vi.fn().mockResolvedValue({ integrationId: "redmine-int" }),
        getProjectReviewConfig: vi.fn().mockResolvedValue(null),
        getAgentById: vi.fn().mockResolvedValue(null),
      },
      pluginManager: {
        getConnectorForIntegration: vi.fn().mockImplementation((id: string) => {
          if (id === "redmine-int") return redmine;
          if (id === "gerrit-int") return review;
          return null;
        }),
        getConnectorForCapability: vi.fn().mockImplementation((id: string, capability: string) => {
          if (id === "redmine-int" && capability === "issue_tracking") return redmine;
          if (id === "gerrit-int" && capability === "code_review") return review;
          return null;
        }),
      },
    }
  );
}

describe("Orchestrator — webhook entry points (Phase 5)", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe("triggerFeedbackForChange", () => {
    it("no-ops when task not found", async () => {
      const stateStore = makeStateStore({ findTaskByExternalChangeId: vi.fn().mockResolvedValue(null) });
      const orch = makeOrchestrator(stateStore);
      await expect(orch.triggerFeedbackForChange("g-1", "Iabc")).resolves.toBeUndefined();
      expect(stateStore.transition).not.toHaveBeenCalled();
    });

    it("no-ops when task is in a terminal state", async () => {
      const task = makeTask({ state: "DONE" });
      const stateStore = makeStateStore({ findTaskByExternalChangeId: vi.fn().mockResolvedValue(task) });
      const orch = makeOrchestrator(stateStore);
      await orch.triggerFeedbackForChange("g-1", "Iabc");
      expect(stateStore.transition).not.toHaveBeenCalled();
    });

    it("no-ops when task is not in IN_REVIEW", async () => {
      const task = makeTask({ state: "AGENT_RUNNING" });
      const stateStore = makeStateStore({ findTaskByExternalChangeId: vi.fn().mockResolvedValue(task) });
      const orch = makeOrchestrator(stateStore);
      await orch.triggerFeedbackForChange("g-1", "Iabc");
      expect(stateStore.transition).not.toHaveBeenCalled();
    });

    it("invokes review-progress check when task is IN_REVIEW (single-repo path: queries Gerrit status)", async () => {
      const task = makeTask({ state: "IN_REVIEW" });
      const review = makeReview({ getChangeStatus: vi.fn().mockResolvedValue("OPEN") });
      const stateStore = makeStateStore({ findTaskByExternalChangeId: vi.fn().mockResolvedValue(task) });
      const orch = makeOrchestrator(stateStore, review);
      await orch.triggerFeedbackForChange("g-1", "Iabc");
      expect(review.getChangeStatus).toHaveBeenCalled();
    });

    it("resolves the code_review connector for a unified provider, not the issue connector", async () => {
      // A unified provider (github/gitlab) exposes BOTH issue_tracking and
      // code_review. getConnectorForIntegration returns the issue connector
      // first (which lacks getChangeStatus); the review path must instead
      // resolve the code_review capability connector.
      const task = makeTask({ state: "IN_REVIEW" });
      const review = makeReview({ getChangeStatus: vi.fn().mockResolvedValue("OPEN") });
      const issueConnector = { getSourceLabel: vi.fn().mockReturnValue("github") };
      const stateStore = makeStateStore({ findTaskByExternalChangeId: vi.fn().mockResolvedValue(task) });
      const orch = new Orchestrator(
        {
          maxAgentCycles: 3,
          maxRetryAttempts: 5,
          agentTimeoutMs: 1000,
          gitAuthorName: "VE",
          gitAuthorEmail: "ve@example.com",
          agentContainerImage: "x:latest",
        },
        stateStore,
        makeWorkspaceRunner(),
        undefined,
        undefined,
        {
          projectStore: {
            getProjectById: vi.fn().mockResolvedValue(null),
            listProjectPushTargets: vi.fn().mockResolvedValue([{ integrationId: "github-int" }]),
            getProjectTicketSource: vi.fn().mockResolvedValue({ integrationId: "github-int" }),
            getProjectReviewConfig: vi.fn().mockResolvedValue(null),
            getAgentById: vi.fn().mockResolvedValue(null),
          },
          pluginManager: {
            getConnectorForIntegration: vi.fn().mockReturnValue(issueConnector),
            getConnectorForCapability: vi.fn().mockImplementation((id: string, capability: string) =>
              id === "github-int" && capability === "code_review" ? review : null
            ),
          },
        }
      );
      await orch.triggerFeedbackForChange("g-1", "Iabc");
      expect(review.getChangeStatus).toHaveBeenCalled();
    });
  });

  describe("markChangeMerged", () => {
    it("no-ops when task not found", async () => {
      const stateStore = makeStateStore();
      const orch = makeOrchestrator(stateStore);
      await orch.markChangeMerged("g-1", "Iabc");
      expect(stateStore.transition).not.toHaveBeenCalled();
    });

    it("no-ops when task is terminal", async () => {
      const task = makeTask({ state: "MERGED" });
      const stateStore = makeStateStore({ findTaskByExternalChangeId: vi.fn().mockResolvedValue(task) });
      const orch = makeOrchestrator(stateStore);
      await orch.markChangeMerged("g-1", "Iabc");
      expect(stateStore.transition).not.toHaveBeenCalled();
    });

    it("transitions IN_REVIEW → MERGED → CLOSING → DONE and closes the ticket", async () => {
      const task = makeTask({ state: "IN_REVIEW" });
      const stateStore = makeStateStore({
        findTaskByExternalChangeId: vi.fn().mockResolvedValue(task),
      });
      const orch = makeOrchestrator(stateStore);
      await orch.markChangeMerged("g-1", "Iabc");
      const calls = (stateStore.transition as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
      expect(calls).toContain("MERGED");
      expect(calls).toContain("CLOSING");
      expect(calls).toContain("DONE");
    });

    it("keeps a multi-repository task in review until every required change is merged", async () => {
      const task = makeTask({ state: "IN_REVIEW" });
      const changes = [
        {
          id: "task-1:root",
          taskId: task.taskId,
          repoKey: "root",
          changeId: "Iabc",
          reviewUrl: "https://gerrit.example/c/Iabc",
          status: "OPEN",
          integrationId: "gerrit-int",
          reviewSystem: "gerrit",
          commitIndex: 0,
          subjectHash: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "task-1:lib",
          taskId: task.taskId,
          repoKey: "lib",
          changeId: "Idef",
          reviewUrl: "https://gerrit.example/c/Idef",
          status: "OPEN",
          integrationId: "gerrit-int",
          reviewSystem: "gerrit",
          commitIndex: 0,
          subjectHash: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];
      const stateStore = makeStateStore({
        findTaskByExternalChangeId: vi.fn().mockResolvedValue(task),
        getTask: vi.fn().mockResolvedValue(task),
        getChangesForTask: vi.fn().mockResolvedValue(changes),
      });
      const review = makeReview({
        getChangeStatus: vi.fn().mockImplementation(async (changeId: string) =>
          changeId === "Iabc" ? "MERGED" : "OPEN"),
      });
      const orch = makeOrchestrator(stateStore, review);

      await orch.markChangeMerged("gerrit-int", "Iabc");

      expect(stateStore.updateChangePerRepositoryStatus).toHaveBeenCalledWith(
        task.taskId,
        "root",
        "MERGED",
        "Iabc",
      );
      expect(stateStore.transition).not.toHaveBeenCalledWith(task.taskId, "MERGED");
      expect(stateStore.transition).not.toHaveBeenCalledWith(task.taskId, "CLOSING");
      expect(stateStore.transition).not.toHaveBeenCalledWith(task.taskId, "DONE");
    });

    it("matches qualified repository identities exactly when IIDs overlap", async () => {
      const task = makeTask({ state: "IN_REVIEW" });
      const changes = [
        {
          id: "task-1:root",
          taskId: task.taskId,
          repoKey: "org/root",
          changeId: "org/root#7",
          reviewUrl: "https://gitlab.example/org/root/-/merge_requests/7",
          status: "OPEN",
          integrationId: "gitlab-int",
          reviewSystem: "gitlab",
          commitIndex: 0,
          subjectHash: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "task-1:child",
          taskId: task.taskId,
          repoKey: "org/child",
          changeId: "org/child#7",
          reviewUrl: "https://gitlab.example/org/child/-/merge_requests/7",
          status: "OPEN",
          integrationId: "gitlab-int",
          reviewSystem: "gitlab",
          commitIndex: 0,
          subjectHash: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];
      const stateStore = makeStateStore({
        findTaskByExternalChangeId: vi.fn().mockResolvedValue(task),
        getTask: vi.fn().mockResolvedValue(task),
        getChangesForTask: vi.fn().mockResolvedValue(changes),
      });
      const orch = makeOrchestrator(stateStore);

      await orch.markChangeMerged("gitlab-int", "org/root#7");

      expect(stateStore.updateChangePerRepositoryStatus).toHaveBeenCalledTimes(1);
      expect(stateStore.updateChangePerRepositoryStatus).toHaveBeenCalledWith(
        task.taskId,
        "org/root",
        "MERGED",
        "org/root#7",
      );
      expect(stateStore.transition).not.toHaveBeenCalledWith(task.taskId, "MERGED");
    });

    it("transitions REVIEW_WATCHING → REVIEW_DONE for merged review tasks", async () => {
      const task = makeTask({ state: "REVIEW_WATCHING" });
      const stateStore = makeStateStore({
        findTaskByExternalChangeId: vi.fn().mockResolvedValue(task),
      });
      const orch = makeOrchestrator(stateStore);
      await orch.markChangeMerged("g-1", "Iabc");
      expect(stateStore.transition).toHaveBeenCalledWith(task.taskId, "REVIEW_DONE");
    });

    it("does nothing when task is not IN_REVIEW", async () => {
      const task = makeTask({ state: "AGENT_RUNNING" });
      const stateStore = makeStateStore({ findTaskByExternalChangeId: vi.fn().mockResolvedValue(task) });
      const orch = makeOrchestrator(stateStore);
      await orch.markChangeMerged("g-1", "Iabc");
      expect(stateStore.transition).not.toHaveBeenCalled();
    });
  });

  describe("markChangeAbandoned", () => {
    it("no-ops when task not found", async () => {
      const stateStore = makeStateStore();
      const orch = makeOrchestrator(stateStore);
      await orch.markChangeAbandoned("g-1", "Iabc");
      expect(stateStore.transition).not.toHaveBeenCalled();
    });

    it("no-ops when task is terminal", async () => {
      const task = makeTask({ state: "ABANDONED" });
      const stateStore = makeStateStore({ findTaskByExternalChangeId: vi.fn().mockResolvedValue(task) });
      const orch = makeOrchestrator(stateStore);
      await orch.markChangeAbandoned("g-1", "Iabc");
      expect(stateStore.transition).not.toHaveBeenCalled();
    });

    it("abandons task via the dedicated mutator", async () => {
      const task = makeTask({ state: "IN_REVIEW" });
      const stateStore = makeStateStore({ findTaskByExternalChangeId: vi.fn().mockResolvedValue(task) });
      const orch = makeOrchestrator(stateStore);
      await orch.markChangeAbandoned("g-1", "Iabc");
      expect(stateStore.abandonTask).toHaveBeenCalledWith(task.taskId);
      expect(stateStore.transition).not.toHaveBeenCalledWith(task.taskId, "ABANDONED");
      expect(stateStore.setFailureReason).toHaveBeenCalled();
    });
  });
});
