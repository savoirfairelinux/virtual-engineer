import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import {
  makeTaskId,
  makeTicketId,
  makeExternalChangeId,
  makeProjectId,
} from "../../src/interfaces.js";
import type { ChangePerRepository } from "../../src/domain/tasks.js";
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

function makeChange(
  task: Task,
  overrides: Partial<ChangePerRepository> = {}
): ChangePerRepository {
  const now = new Date();
  return {
    id: `${task.taskId}:repo-a`,
    taskId: task.taskId,
    repoKey: "repo-a",
    changeId: "Iabc",
    reviewUrl: null,
    status: "OPEN",
    integrationId: "g-1",
    reviewSystem: "gerrit",
    commitIndex: 0,
    subjectHash: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
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
    updateChangePerRepositoryStatusById: vi.fn().mockResolvedValue(undefined),
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

function makeOrchestrator(
  stateStore: StateStore,
  review: ReviewConnector = makeReview(),
  pushTargets: unknown[] = [{ integrationId: "gerrit-int" }]
): Orchestrator {
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
        listProjectPushTargets: vi.fn().mockResolvedValue(pushTargets),
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

    it("does not complete a task while another tracked change remains open", async () => {
      const task = makeTask({ state: "IN_REVIEW" });
      const stateStore = makeStateStore({
        findTaskByExternalChangeId: vi.fn().mockResolvedValue(task),
        getChangesForTask: vi.fn().mockResolvedValue([
          makeChange(task),
          makeChange(task, {
            id: `${task.taskId}:repo-b`,
            repoKey: "repo-b",
            changeId: "Iother",
          }),
        ]),
      });
      const orch = makeOrchestrator(stateStore);

      await orch.markChangeMerged("g-1", "Iabc");

      expect(stateStore.updateChangePerRepositoryStatusById).toHaveBeenCalledWith(
        task.taskId,
        `${task.taskId}:repo-a`,
        "MERGED"
      );
      expect(stateStore.transition).not.toHaveBeenCalledWith(task.taskId, "MERGED");
    });

    it("uses the Gerrit project to select a matching repo row for a duplicate Change-Id", async () => {
      const task = makeTask({ state: "IN_REVIEW" });
      const stateStore = makeStateStore({
        findTaskByExternalChangeId: vi.fn().mockResolvedValue(task),
        getChangesForTask: vi.fn().mockResolvedValue([
          makeChange(task, { id: `${task.taskId}:repo-a`, repoKey: "repo-a" }),
          makeChange(task, { id: `${task.taskId}:repo-b`, repoKey: "repo-b" }),
        ]),
      });
      const orch = makeOrchestrator(stateStore, makeReview(), [
        {
          integrationId: "g-1",
          repoKey: "repo-b",
          cloneUrl: "ssh://gerrit.example.com:29418/team/repo-b.git",
        },
      ]);

      await orch.markChangeMerged("g-1", "Iabc", "team/repo-b");

      expect(stateStore.updateChangePerRepositoryStatusById).toHaveBeenCalledWith(
        task.taskId,
        `${task.taskId}:repo-b`,
        "MERGED"
      );
    });

    it("resolves the Gerrit project path from an SCP-style clone URL", async () => {
      const task = makeTask({ state: "IN_REVIEW" });
      const stateStore = makeStateStore({
        findTaskByExternalChangeId: vi.fn().mockResolvedValue(task),
        getChangesForTask: vi.fn().mockResolvedValue([
          makeChange(task, { id: `${task.taskId}:repo-b`, repoKey: "repo-b" }),
        ]),
      });
      const orch = makeOrchestrator(stateStore, makeReview(), [
        {
          integrationId: "g-1",
          repoKey: "repo-b",
          cloneUrl: "git@gerrit.example.com:team/repo-b.git",
        },
      ]);

      await orch.markChangeMerged("g-1", "Iabc", "team/repo-b");

      expect(stateStore.updateChangePerRepositoryStatusById).toHaveBeenCalledWith(
        task.taskId,
        `${task.taskId}:repo-b`,
        "MERGED"
      );
    });

    it("resolves the Gerrit project path from an HTTP clone URL with /a/ prefix", async () => {
      const task = makeTask({ state: "IN_REVIEW" });
      const stateStore = makeStateStore({
        findTaskByExternalChangeId: vi.fn().mockResolvedValue(task),
        getChangesForTask: vi.fn().mockResolvedValue([
          makeChange(task, { id: `${task.taskId}:repo-b`, repoKey: "repo-b" }),
        ]),
      });
      const orch = makeOrchestrator(stateStore, makeReview(), [
        {
          integrationId: "g-1",
          repoKey: "repo-b",
          cloneUrl: "https://gerrit.example.com/a/team/repo-b.git",
        },
      ]);

      await orch.markChangeMerged("g-1", "Iabc", "team/repo-b");

      expect(stateStore.updateChangePerRepositoryStatusById).toHaveBeenCalledWith(
        task.taskId,
        `${task.taskId}:repo-b`,
        "MERGED"
      );
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

  describe("repository-qualified hosted events (real state store)", () => {
    let store: SqliteStateStore;

    beforeEach(async () => {
      store = await SqliteStateStore.create(":memory:");
    });

    afterEach(() => {
      store.close();
    });

    async function trackHostedChange(
      taskName: string,
      changes: Array<{ repoKey: string; changeId?: string }>,
    ): Promise<Task["taskId"]> {
      const taskId = makeTaskId(taskName);
      await store.createTask(taskId, makeTicketId(`ticket-${taskName}`));
      (store as unknown as { raw: Database.Database }).raw
        .prepare("UPDATE tasks SET state = 'IN_REVIEW', project_id = 'proj-1' WHERE task_id = ?")
        .run(taskId);
      for (const change of changes) {
        const changeId = change.changeId ?? "42";
        await store.saveChangePerRepository(
          taskId, change.repoKey, changeId, `https://github.com/${change.repoKey}/pull/${changeId}`,
          "OPEN", "github-1", "github", 0, null,
        );
      }
      return taskId;
    }

    it.each(["markChangeMerged", "markChangeAbandoned", "triggerFeedbackForChange"] as const)(
      "%s for an untracked repository leaves another repository's native number untouched",
      async (entryPoint) => {
        const tracked = await trackHostedChange("task-a", [{ repoKey: "owner/a" }]);
        const transitionsBefore = await store.getStateTransitions(tracked);
        const orch = makeOrchestrator(store);

        await orch[entryPoint]("github-1", "owner/b#42");

        expect(await store.getTask(tracked)).toMatchObject({ state: "IN_REVIEW", failureReason: null });
        expect(await store.getStateTransitions(tracked)).toHaveLength(transitionsBefore.length);
        expect(await store.getChangesForTask(tracked)).toEqual([
          expect.objectContaining({ repoKey: "owner/a", changeId: "42", status: "OPEN" }),
        ]);
      },
    );

    it("routes a shared native number to the task of the event repository, case-insensitively", async () => {
      const taskA = await trackHostedChange("task-a", [{ repoKey: "owner/a" }]);
      const taskB = await trackHostedChange("task-b", [{ repoKey: "Owner/B" }]);
      const orch = makeOrchestrator(store);

      await orch.markChangeAbandoned("github-1", "owner/b#42");

      expect((await store.getTask(taskB))?.state).toBe("ABANDONED");
      expect((await store.getTask(taskA))?.state).toBe("IN_REVIEW");
    });

    it("merges only the event repository's row when one task tracks the same number twice", async () => {
      const taskId = await trackHostedChange("task-multi", [{ repoKey: "owner/a" }, { repoKey: "owner/b" }]);
      const orch = makeOrchestrator(store);

      await orch.markChangeMerged("github-1", "owner/b#42");

      const rows = await store.getChangesForTask(taskId);
      expect(rows.find((row) => row.repoKey === "owner/b")?.status).toBe("MERGED");
      expect(rows.find((row) => row.repoKey === "owner/a")?.status).toBe("OPEN");
      expect((await store.getTask(taskId))?.state).toBe("IN_REVIEW");
    });

    it("still completes the tracked task for its own repository's merge event", async () => {
      const taskId = await trackHostedChange("task-a", [{ repoKey: "owner/a" }]);
      const orch = makeOrchestrator(store);

      await orch.markChangeMerged("github-1", "OWNER/A#42");

      expect((await store.getChangesForTask(taskId))[0]?.status).toBe("MERGED");
      expect((await store.getTask(taskId))?.state).toBe("DONE");
    });

    it("does not abandon a task through its mirrored id after its project is rebound", async () => {
      const agent = await store.createAgent({
        name: "Agent",
        type: "coding",
        modelConfigJson: "{}",
        systemPromptId: "system_generic_code",
        instructionsPromptId: "instructions_generic_code",
        enabled: true,
      });
      await store.upsertIntegration({ id: "github-1", provider: "github", name: "GitHub", configJson: "{}", enabled: true });
      await store.createProject({ id: makeProjectId("proj-1"), name: "Project", type: "coding", agentId: agent.id, enabled: true });
      await store.addProjectPushTarget(makeProjectId("proj-1"), {
        integrationId: "github-1",
        repoKey: "owner/b",
        cloneUrl: "https://github.com/owner/b.git",
        targetBranch: "main",
        role: "primary",
        commitOrder: 1,
        localPath: ".",
      });
      const tracked = await trackHostedChange("task-a", [{ repoKey: "owner/a" }]);
      await store.updateExternalChangeId(tracked, makeExternalChangeId("42"), 1);
      const orch = makeOrchestrator(store);

      await orch.markChangeAbandoned("github-1", "owner/b#42");

      expect(await store.getTask(tracked)).toMatchObject({ state: "IN_REVIEW", failureReason: null });
    });
  });
});
