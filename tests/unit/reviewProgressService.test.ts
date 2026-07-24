import { describe, expect, it, vi } from "vitest";
import { makeExternalChangeId, makeTaskId, makeTicketId } from "../../src/domain/identifiers.js";
import type { ChangePerRepository, Task } from "../../src/domain/tasks.js";
import type { FeedbackItem, ReviewComment, ReviewConnector } from "../../src/interfaces.js";
import type { VcsConnector } from "../../src/vcs/vcsConnector.js";
import {
  ReviewProgressService,
  type ReviewProgressDependencies,
} from "../../src/orchestrator/reviewProgressService.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: makeTaskId("task-1"),
    ticketId: makeTicketId("ticket-1"),
    ticketSourceLabel: "redmine:integration-1",
    ticketTitle: "Fix review feedback",
    ticketDescription: "Description",
    state: "IN_REVIEW",
    taskType: "code-gen",
    externalChangeId: makeExternalChangeId("I123"),
    currentPatchset: 1,
    reviewedPatchset: null,
    cycleCount: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    failureReason: null,
    ticketUrl: null,
    reviewUrl: null,
    displayId: "1",
    ...overrides,
  };
}

function makeChange(
  task: Task,
  overrides: Partial<ChangePerRepository> = {}
): ChangePerRepository {
  return {
    id: "change-1",
    taskId: task.taskId,
    repoKey: "team/repo",
    changeId: "I123",
    reviewUrl: null,
    status: "OPEN",
    integrationId: "gerrit-1",
    reviewSystem: "gerrit",
    commitIndex: 0,
    subjectHash: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function makeComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: "comment-1",
    author: "reviewer",
    message: "Please fix this",
    unresolved: true,
    patchset: 1,
    updatedAt: new Date(0),
    ...overrides,
  };
}

function makeDependencies(
  task: Task,
  reviewConnector: ReviewConnector,
  overrides: Partial<ReviewProgressDependencies> = {}
): ReviewProgressDependencies {
  return {
    getChangesForTask: vi.fn().mockResolvedValue([]),
    transition: vi.fn().mockImplementation(async (_taskId, state) => ({ ...task, state })),
    updateChangeStatus: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(task),
    resolveReviewConnector: vi.fn().mockResolvedValue(reviewConnector),
    resolveVcsConnector: vi.fn().mockResolvedValue(undefined),
    getDefaultVcsConnector: vi.fn().mockReturnValue(undefined),
    extractNewFeedback: vi.fn().mockResolvedValue([[], []]),
    reactsToCiFailures: vi.fn().mockResolvedValue(false),
    getMaxAgentCycles: vi.fn().mockReturnValue(3),
    runAgentCycle: vi.fn().mockResolvedValue(undefined),
    closeTicket: vi.fn().mockResolvedValue(undefined),
    abandonTask: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("ReviewProgressService", () => {
  it("converges a merged single-repository change and closes its ticket", async () => {
    const task = makeTask();
    const reviewConnector = {
      getChangeStatus: vi.fn().mockResolvedValue("MERGED"),
    } as unknown as ReviewConnector;
    const dependencies = makeDependencies(task, reviewConnector);
    const service = new ReviewProgressService(dependencies);

    await service.check(task);

    expect(dependencies.transition).toHaveBeenCalledWith(task.taskId, "MERGED");
    expect(dependencies.closeTicket).toHaveBeenCalledWith(
      expect.objectContaining({ state: "MERGED" })
    );
  });

  it("treats a multi-repository task with only inactive changes as merged", async () => {
    const task = makeTask();
    const reviewConnector = {} as ReviewConnector;
    const dependencies = makeDependencies(task, reviewConnector, {
      getChangesForTask: vi.fn().mockResolvedValue([
        makeChange(task, { status: "NO_CHANGE" }),
        makeChange(task, { id: "change-2", status: "ORPHANED" }),
      ]),
    });
    const service = new ReviewProgressService(dependencies);

    await service.check(task);

    expect(dependencies.transition).toHaveBeenCalledWith(task.taskId, "MERGED");
    expect(dependencies.closeTicket).toHaveBeenCalledWith(
      expect.objectContaining({ state: "MERGED" })
    );
  });

  it("converges when every active repository reports merged", async () => {
    const task = makeTask();
    const changes = [
      makeChange(task, { id: "change-1", repoKey: "team/api", changeId: "Iapi" }),
      makeChange(task, { id: "change-2", repoKey: "team/ui", changeId: "Iui" }),
    ];
    const vcsConnector = {
      getChangeStatus: vi.fn().mockResolvedValue("MERGED"),
    } as unknown as VcsConnector;
    const dependencies = makeDependencies(task, {} as ReviewConnector, {
      getChangesForTask: vi.fn().mockResolvedValue(changes),
      resolveVcsConnector: vi.fn().mockResolvedValue(vcsConnector),
    });
    const service = new ReviewProgressService(dependencies);

    await service.check(task);

    expect(dependencies.updateChangeStatus).toHaveBeenCalledTimes(2);
    expect(dependencies.transition).toHaveBeenCalledWith(task.taskId, "MERGED");
    expect(dependencies.closeTicket).toHaveBeenCalledWith(
      expect.objectContaining({ state: "MERGED" })
    );
  });

  it("abandons the task when any repository change is abandoned", async () => {
    const task = makeTask();
    const change = makeChange(task);
    const vcsConnector = {
      getChangeStatus: vi.fn().mockResolvedValue("ABANDONED"),
    } as unknown as VcsConnector;
    const dependencies = makeDependencies(task, {} as ReviewConnector, {
      getChangesForTask: vi.fn().mockResolvedValue([change]),
      resolveVcsConnector: vi.fn().mockResolvedValue(vcsConnector),
    });
    const service = new ReviewProgressService(dependencies);

    await service.check(task);

    expect(dependencies.updateChangeStatus).toHaveBeenCalledWith(
      task.taskId,
      change.repoKey,
      "ABANDONED",
      change.changeId
    );
    expect(dependencies.abandonTask).toHaveBeenCalledWith(
      task,
      "Change abandoned externally for repositories: team/repo"
    );
  });

  it("returns to IN_REVIEW when no new feedback is actionable", async () => {
    const task = makeTask();
    const reviewConnector = {
      getChangeStatus: vi.fn().mockResolvedValue("OPEN"),
      getUnresolvedComments: vi.fn().mockResolvedValue([]),
    } as unknown as ReviewConnector;
    const dependencies = makeDependencies(task, reviewConnector);
    const service = new ReviewProgressService(dependencies);

    await service.check(task);

    expect(dependencies.transition).toHaveBeenNthCalledWith(
      1,
      task.taskId,
      "FEEDBACK_PROCESSING"
    );
    expect(dependencies.transition).toHaveBeenNthCalledWith(2, task.taskId, "IN_REVIEW");
    expect(dependencies.runAgentCycle).not.toHaveBeenCalled();
  });

  it("filters CI failure comments when the project has not opted in", async () => {
    const task = makeTask();
    const ciComment = makeComment({ id: "ci-failure-1", message: "Build Failed" });
    const reviewConnector = {
      getChangeStatus: vi.fn().mockResolvedValue("OPEN"),
      getUnresolvedComments: vi.fn().mockResolvedValue([ciComment]),
    } as unknown as ReviewConnector;
    const dependencies = makeDependencies(task, reviewConnector);
    const service = new ReviewProgressService(dependencies);

    await service.check(task);

    expect(dependencies.extractNewFeedback).toHaveBeenCalledWith(
      task.taskId,
      task.externalChangeId,
      []
    );
  });

  it("reads the current cycle limit before abandoning feedback", async () => {
    const task = makeTask({ cycleCount: 4 });
    const comment = makeComment();
    const feedback: FeedbackItem = { source: "gerrit_review", content: comment.message };
    const reviewConnector = {
      getChangeStatus: vi.fn().mockResolvedValue("OPEN"),
      getUnresolvedComments: vi.fn().mockResolvedValue([comment]),
    } as unknown as ReviewConnector;
    const getMaxAgentCycles = vi.fn().mockReturnValue(3);
    const dependencies = makeDependencies(task, reviewConnector, {
      extractNewFeedback: vi.fn().mockResolvedValue([[feedback], [comment]]),
      getMaxAgentCycles,
    });
    const service = new ReviewProgressService(dependencies);

    await service.check(task);

    expect(getMaxAgentCycles).toHaveBeenCalledOnce();
    expect(dependencies.abandonTask).toHaveBeenCalledWith(
      expect.objectContaining({ state: "FEEDBACK_PROCESSING", cycleCount: 4 }),
      "Max cycles 3 reached during review"
    );
    expect(dependencies.runAgentCycle).not.toHaveBeenCalled();
  });

  it("runs a retry and resolves newly processed comments after review resumes", async () => {
    const task = makeTask();
    const comment = makeComment();
    const feedback: FeedbackItem = { source: "gerrit_review", content: comment.message };
    const reviewConnector = {
      getChangeStatus: vi.fn().mockResolvedValue("OPEN"),
      getUnresolvedComments: vi.fn().mockResolvedValue([comment]),
      resolveComments: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReviewConnector;
    const dependencies = makeDependencies(task, reviewConnector, {
      extractNewFeedback: vi.fn().mockResolvedValue([[feedback], [comment]]),
      getTask: vi.fn().mockResolvedValue({ ...task, state: "IN_REVIEW" }),
    });
    const service = new ReviewProgressService(dependencies);

    await service.check(task);

    expect(dependencies.runAgentCycle).toHaveBeenCalledWith(
      expect.objectContaining({ state: "RETRY_CYCLE" }),
      [feedback]
    );
    expect(reviewConnector.resolveComments).toHaveBeenCalledWith(
      task.externalChangeId,
      [comment]
    );
  });

  it("keeps multi-repository review active when connector resolution fails", async () => {
    const task = makeTask();
    const dependencies = makeDependencies(task, {} as ReviewConnector, {
      getChangesForTask: vi.fn().mockResolvedValue([makeChange(task)]),
      resolveVcsConnector: vi.fn().mockResolvedValue(undefined),
    });
    const service = new ReviewProgressService(dependencies);

    await service.check(task);

    expect(dependencies.transition).toHaveBeenNthCalledWith(
      1,
      task.taskId,
      "FEEDBACK_PROCESSING"
    );
    expect(dependencies.transition).toHaveBeenNthCalledWith(2, task.taskId, "IN_REVIEW");
    expect(dependencies.abandonTask).not.toHaveBeenCalled();
  });
});