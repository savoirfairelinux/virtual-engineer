import { describe, expect, it, vi } from "vitest";
import { makeExternalChangeId, makeTaskId, makeTicketId } from "../../src/domain/identifiers.js";
import type { ChangePerRepository, Task } from "../../src/domain/tasks.js";
import type { FeedbackItem, ReviewComment, ReviewConnector } from "../../src/interfaces.js";
import type { VcsConnector } from "../../src/vcs/vcsConnector.js";
import {
  ReviewProgressService,
  type ReviewProgressDependencies,
} from "../../src/orchestrator/reviewProgressService.js";

const { logger } = vi.hoisted(() => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock("../../src/logger.js", () => ({
  getLogger: vi.fn(() => logger),
}));

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
  it("uses provider-neutral warnings for missing changes and status failures", async () => {
    const task = makeTask({ externalChangeId: null });
    const dependencies = makeDependencies(task, {} as ReviewConnector);
    const service = new ReviewProgressService(dependencies);

    await service.check(task);

    expect(logger.warn).toHaveBeenCalledWith(
      { taskId: task.taskId },
      "IN_REVIEW but no external change id - waiting"
    );

    logger.warn.mockClear();
    const statusError = new Error("unavailable");
    const failedTask = makeTask();
    const failedConnector = {
      getChangeStatus: vi.fn().mockRejectedValue(statusError),
    } as unknown as ReviewConnector;
    const failedService = new ReviewProgressService(makeDependencies(failedTask, failedConnector));

    await failedService.check(failedTask);

    expect(logger.warn).toHaveBeenCalledWith(
      { taskId: failedTask.taskId, changeId: failedTask.externalChangeId, err: statusError },
      "failed to fetch review change status - staying IN_REVIEW"
    );
  });

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

  it("marks only the event's matching repo row and closes after the final active merge", async () => {
    const task = makeTask();
    const changes = [
      makeChange(task, { id: "change-api", repoKey: "team/api", changeId: "Ishared" }),
      makeChange(task, { id: "change-ui", repoKey: "team/ui", changeId: "Ishared" }),
      makeChange(task, {
        id: "change-orphan",
        repoKey: "team/old",
        changeId: "Iold",
        status: "ORPHANED",
      }),
    ];
    const updateChangeStatus = vi.fn(async (_taskId: Task["taskId"], rowId: string, status: string) => {
      const change = changes.find((candidate) => candidate.id === rowId);
      if (change && change.status !== "ORPHANED" && change.status !== "NO_CHANGE") {
        change.status = status;
      }
    });
    const dependencies = makeDependencies(task, {} as ReviewConnector, {
      getChangesForTask: vi.fn(async () => changes),
      updateChangeStatus,
    });
    const service = new ReviewProgressService(dependencies);

    await service.markChangeMerged(task, "gerrit-1", "Ishared", "team/api");

    expect(updateChangeStatus).toHaveBeenCalledWith(task.taskId, "change-api", "MERGED");
    expect(changes[1]?.status).toBe("OPEN");
    expect(dependencies.transition).not.toHaveBeenCalledWith(task.taskId, "MERGED");

    await service.markChangeMerged(task, "gerrit-1", "Iold", "team/old");
    expect(updateChangeStatus).toHaveBeenCalledTimes(1);

    await service.markChangeMerged(task, "gerrit-1", "Ishared", "team/ui");

    expect(updateChangeStatus).toHaveBeenLastCalledWith(task.taskId, "change-ui", "MERGED");
    expect(dependencies.transition).toHaveBeenCalledWith(task.taskId, "MERGED");
    expect(dependencies.closeTicket).toHaveBeenCalledOnce();
  });

  it("selects a qualified merge event's row by repository as well as native number", async () => {
    const task = makeTask();
    const hosted = { integrationId: "github-1", reviewSystem: "github", changeId: "42" };
    const changes = [
      makeChange(task, { ...hosted, id: "change-a", repoKey: "owner/a" }),
      makeChange(task, { ...hosted, id: "change-b", repoKey: "owner/b" }),
    ];
    const dependencies = makeDependencies(task, {} as ReviewConnector, {
      getChangesForTask: vi.fn(async () => changes),
    });
    const service = new ReviewProgressService(dependencies);

    await service.markChangeMerged(task, "github-1", "owner/c#42");
    expect(dependencies.updateChangeStatus).not.toHaveBeenCalled();

    await service.markChangeMerged(task, "github-1", "OWNER/B#42");
    expect(dependencies.updateChangeStatus).toHaveBeenCalledExactlyOnceWith(task.taskId, "change-b", "MERGED");
    expect(dependencies.transition).not.toHaveBeenCalled();
  });

  it("accepts qualified legacy merge event ids", async () => {
    const task = makeTask({ externalChangeId: makeExternalChangeId("123") });
    const dependencies = makeDependencies(task, {} as ReviewConnector, {
      getChangesForTask: vi.fn().mockResolvedValue([]),
    });
    const service = new ReviewProgressService(dependencies);

    await service.markChangeMerged(task, "github-1", "owner/repo#123");

    expect(dependencies.transition).toHaveBeenCalledWith(task.taskId, "MERGED");
    expect(dependencies.closeTicket).toHaveBeenCalledWith(
      expect.objectContaining({ state: "MERGED" })
    );
  });

  it("treats persisted merged rows as authoritative over stale open polling results", async () => {
    const task = makeTask();
    const mergedChange = makeChange(task, { status: "MERGED" });
    const reviewConnector = {
      getChangeStatus: vi.fn().mockResolvedValue("OPEN"),
    } as unknown as ReviewConnector;
    const dependencies = makeDependencies(task, reviewConnector, {
      getChangesForTask: vi.fn().mockResolvedValue([mergedChange]),
    });
    const service = new ReviewProgressService(dependencies);

    await service.check(task);

    expect(reviewConnector.getChangeStatus).not.toHaveBeenCalled();
    expect(dependencies.updateChangeStatus).not.toHaveBeenCalled();
    expect(dependencies.transition).toHaveBeenCalledWith(task.taskId, "MERGED");
    expect(dependencies.closeTicket).toHaveBeenCalledOnce();
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
      change.id,
      "ABANDONED"
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
    const feedback: FeedbackItem = { source: "review_comment", content: comment.message };
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
    const feedback: FeedbackItem = { source: "review_comment", content: comment.message };
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

  it("preserves provider provenance while aggregating multi-repository feedback", async () => {
    const task = makeTask();
    const changes = [
      makeChange(task, {
        id: "change-gerrit",
        repoKey: "team/api",
        changeId: "Iapi",
        integrationId: "gerrit-1",
        reviewSystem: "gerrit",
      }),
      makeChange(task, {
        id: "change-gitlab",
        repoKey: "team/ui",
        changeId: "7",
        integrationId: "gitlab-1",
        reviewSystem: "gitlab",
      }),
    ];
    const gerritComment = makeComment({
      id: "ssh-1-1",
      filePath: "team/api/src/index.ts",
      message: "Fix the API validation",
      reviewSystem: "gerrit",
    });
    const gitlabComment = makeComment({
      id: "discussion-1",
      filePath: "team/ui/src/index.ts",
      message: "Fix the UI state",
      reviewSystem: "gitlab",
    });
    const gerritConnector = {
      getChangeStatus: vi.fn().mockResolvedValue("OPEN"),
      getUnresolvedComments: vi.fn().mockResolvedValue([gerritComment]),
      resolveComments: vi.fn().mockResolvedValue(undefined),
    } as unknown as VcsConnector;
    const gitlabConnector = {
      getChangeStatus: vi.fn().mockResolvedValue("OPEN"),
      getUnresolvedComments: vi.fn().mockResolvedValue([gitlabComment]),
      resolveComments: vi.fn().mockResolvedValue(undefined),
    } as unknown as VcsConnector;
    const feedback = vi.fn().mockImplementation(
      async (_taskId: string, _changeId: string, comments: ReviewComment[]) => [
        comments.map((comment) => ({
          source: "review_comment" as const,
          reviewSystem: comment.reviewSystem,
          content: comment.message,
          ...(comment.filePath !== undefined ? { filePath: comment.filePath } : {}),
          ...(comment.line !== undefined ? { line: comment.line } : {}),
        })),
        comments,
      ]
    );
    const dependencies = makeDependencies(task, {} as ReviewConnector, {
      getChangesForTask: vi.fn().mockResolvedValue(changes),
      resolveVcsConnector: vi.fn().mockImplementation(async (_integrationId, context) =>
        context.repoKey === "team/api" ? gerritConnector : gitlabConnector
      ),
      extractNewFeedback: feedback,
      getTask: vi.fn().mockResolvedValue({ ...task, state: "IN_REVIEW" }),
    });
    const service = new ReviewProgressService(dependencies);

    await service.check(task);

    expect(dependencies.runAgentCycle).toHaveBeenCalledWith(
      expect.objectContaining({ state: "RETRY_CYCLE" }),
      [
        expect.objectContaining({
          source: "review_comment",
          reviewSystem: "gerrit",
          content: "[team/api] Fix the API validation",
        }),
        expect.objectContaining({
          source: "review_comment",
          reviewSystem: "gitlab",
          content: "[team/ui] Fix the UI state",
        }),
      ]
    );
    expect(gerritConnector.resolveComments).toHaveBeenCalledWith("Iapi", [gerritComment]);
    expect(gitlabConnector.resolveComments).toHaveBeenCalledWith("7", [gitlabComment]);
  });
});