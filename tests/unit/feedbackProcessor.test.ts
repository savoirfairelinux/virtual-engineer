import { describe, it, expect, vi } from "vitest";
import { FeedbackProcessor } from "../../src/orchestrator/feedbackProcessor.js";
import type { StateStore, ReviewComment } from "../../src/interfaces.js";
import { makeTaskId, makeExternalChangeId } from "../../src/interfaces.js";
import { randomUUID } from "crypto";

function makeComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: randomUUID(),
    author: "reviewer@example.com",
    message: "Please fix this",
    unresolved: true,
    patchset: 1,
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeStateStoreMock(processedIds: Set<string> = new Set()): StateStore {
  return {
    getProcessedCommentIds: vi.fn().mockResolvedValue(processedIds),
    markCommentProcessed: vi.fn().mockResolvedValue(undefined),
  } as unknown as StateStore;
}

describe("FeedbackProcessor", () => {
  it("returns empty array when no unresolved comments", async () => {
    const store = makeStateStoreMock();
    const processor = new FeedbackProcessor(store);
    const taskId = makeTaskId(randomUUID());
    const changeId = makeExternalChangeId("Iabc");

    const [items, comments] = await processor.extractNewFeedback(taskId, changeId, [
      makeComment({ unresolved: false }),
    ]);

    expect(items).toHaveLength(0);
    expect(comments).toHaveLength(0);
    expect(store.markCommentProcessed).not.toHaveBeenCalled();
  });

  it("filters out already-processed comment ids", async () => {
    const comment1 = makeComment();
    const comment2 = makeComment();
    const store = makeStateStoreMock(new Set([comment1.id]));
    const processor = new FeedbackProcessor(store);
    const taskId = makeTaskId(randomUUID());
    const changeId = makeExternalChangeId("Idef");

    const [items, comments] = await processor.extractNewFeedback(taskId, changeId, [
      comment1,
      comment2,
    ]);

    expect(items).toHaveLength(1);
    expect(comments).toHaveLength(1);
    expect(items[0]?.content).toBe(comment2.message);
    expect(comments[0]?.id).toBe(comment2.id);
  });

  it("marks new comments as processed", async () => {
    const comment = makeComment();
    const store = makeStateStoreMock();
    const processor = new FeedbackProcessor(store);
    const taskId = makeTaskId(randomUUID());
    const changeId = makeExternalChangeId("Ighi");

    await processor.extractNewFeedback(taskId, changeId, [comment]);

    expect(store.markCommentProcessed).toHaveBeenCalledWith(taskId, comment.id);
  });

  it.each([
    { integrationId: "github-2", repoKey: "team/api", changeId: "42" },
    { integrationId: "github-1", repoKey: "team/ui", changeId: "42" },
    { integrationId: "github-1", repoKey: "team/api", changeId: "43" },
  ])("separates native comment IDs by integration, repository and change: %j", async (other) => {
    const processedIds = new Set<string>();
    const store = makeStateStoreMock(processedIds);
    vi.mocked(store.markCommentProcessed).mockImplementation((_taskId, id) => {
      processedIds.add(id);
      return Promise.resolve();
    });
    const processor = new FeedbackProcessor(store);
    const taskId = makeTaskId("task-1");
    const comment = makeComment({ id: "101", reviewSystem: "github" });
    const scope = { integrationId: "github-1", repoKey: "team/api" };

    const [, firstComments] = await processor.extractNewFeedback(taskId, makeExternalChangeId("42"), [comment], scope);
    const [, otherComments] = await processor.extractNewFeedback(
      taskId, makeExternalChangeId(other.changeId), [comment], other,
    );
    const [repeatedItems] = await processor.extractNewFeedback(taskId, makeExternalChangeId("42"), [comment], scope);

    expect(firstComments).toEqual([comment]);
    expect(otherComments).toEqual([comment]);
    expect(repeatedItems).toEqual([]);
    expect(processedIds).toEqual(new Set([
      JSON.stringify(["github-1", "team/api", "42", "101"]),
      JSON.stringify([other.integrationId, other.repoKey, other.changeId, "101"]),
    ]));
  });

  it("keeps historical unscoped comments deduplicated when repository scoping is enabled", async () => {
    const comment = makeComment({ id: "101" });
    const store = makeStateStoreMock(new Set([comment.id]));
    const processor = new FeedbackProcessor(store);

    const result = await processor.extractNewFeedback(
      makeTaskId("task-1"), makeExternalChangeId("42"), [comment],
      { integrationId: "github-1", repoKey: "team/api" },
    );

    expect(result).toEqual([[], []]);
    expect(store.markCommentProcessed).not.toHaveBeenCalled();
  });

  it("keeps raw processed IDs for legacy rows recorded without an integration", async () => {
    const comment = makeComment({ id: "legacy-101" });
    const store = makeStateStoreMock();
    const processor = new FeedbackProcessor(store);
    const taskId = makeTaskId("task-1");

    await processor.extractNewFeedback(
      taskId, makeExternalChangeId("I123"), [comment], { integrationId: "", repoKey: "team/api" },
    );

    expect(store.markCommentProcessed).toHaveBeenCalledExactlyOnceWith(taskId, comment.id);
  });

  it("preserves native CI identifiers and classification when storing scoped processed IDs", async () => {
    const comment = makeComment({ id: "ci-run-9001", reviewSystem: "github" });
    const store = makeStateStoreMock();
    const processor = new FeedbackProcessor(store);
    const taskId = makeTaskId("task-1");

    const [items, comments] = await processor.extractNewFeedback(
      taskId, makeExternalChangeId("42"), [comment], { integrationId: "github-1", repoKey: "team/api" },
    );

    expect(items[0]).toMatchObject({ source: "ci_failure", reviewSystem: "github" });
    expect(comments).toEqual([comment]);
    expect(store.markCommentProcessed).toHaveBeenCalledExactlyOnceWith(
      taskId, JSON.stringify(["github-1", "team/api", "42", "ci-run-9001"]),
    );
  });

  it("maps comment fields and review provenance to FeedbackItem", async () => {
    const comment = makeComment({
      message: "This function is wrong",
      reviewSystem: "gerrit",
      filePath: "src/foo.ts",
      line: 42,
    });
    const store = makeStateStoreMock();
    const processor = new FeedbackProcessor(store);
    const taskId = makeTaskId(randomUUID());

    const [items] = await processor.extractNewFeedback(
      taskId,
      makeExternalChangeId("I123"),
      [comment]
    );

    expect(items[0]).toMatchObject({
      source: "review_comment",
      reviewSystem: "gerrit",
      content: "This function is wrong",
      filePath: "src/foo.ts",
      line: 42,
    });
  });

  it("uses generic review_comment source for Gerrit comments", async () => {
    const comment = makeComment({ id: "ssh-1234567890-2", message: "Please fix this", reviewSystem: "gerrit" });
    const store = makeStateStoreMock();
    const processor = new FeedbackProcessor(store);

    const [items] = await processor.extractNewFeedback(
      makeTaskId(randomUUID()),
      makeExternalChangeId("I123"),
      [comment]
    );

    expect(items[0]).toMatchObject({ source: "review_comment", reviewSystem: "gerrit" });
  });

  it("uses generic review_comment source for opaque GitLab discussion ids", async () => {
    const comment = makeComment({ id: "discussion-98765", message: "Please update this", reviewSystem: "gitlab" });
    const store = makeStateStoreMock();
    const processor = new FeedbackProcessor(store);

    const [items] = await processor.extractNewFeedback(
      makeTaskId(randomUUID()),
      makeExternalChangeId("42"),
      [comment]
    );

    expect(items[0]).toMatchObject({ source: "review_comment", reviewSystem: "gitlab" });
  });

  it("uses generic review_comment source for GitHub issue comments", async () => {
    const comment = makeComment({ id: "issue-98765", message: "Please update docs", reviewSystem: "github" });
    const store = makeStateStoreMock();
    const processor = new FeedbackProcessor(store);

    const [items] = await processor.extractNewFeedback(
      makeTaskId(randomUUID()),
      makeExternalChangeId("42"),
      [comment]
    );

    expect(items[0]).toMatchObject({ source: "review_comment", reviewSystem: "github" });
  });

  it("uses generic review_comment source for GitHub inline review comments", async () => {
    const comment = makeComment({ id: "123456789", message: "Suggestion here", reviewSystem: "github" });
    const store = makeStateStoreMock();
    const processor = new FeedbackProcessor(store);

    const [items] = await processor.extractNewFeedback(
      makeTaskId(randomUUID()),
      makeExternalChangeId("7"),
      [comment]
    );

    expect(items[0]).toMatchObject({ source: "review_comment", reviewSystem: "github" });
  });

  it("handles comments with no file path (patchset-level)", async () => {
    const comment = makeComment({ filePath: undefined, line: undefined });
    const store = makeStateStoreMock();
    const processor = new FeedbackProcessor(store);

    const [items] = await processor.extractNewFeedback(
      makeTaskId(randomUUID()),
      makeExternalChangeId("I999"),
      [comment]
    );

    expect(items[0]?.filePath).toBeUndefined();
    expect(items[0]?.line).toBeUndefined();
  });

  it("uses ci_failure source for comments with ci-run- id prefix", async () => {
    const comment = makeComment({ id: "ci-run-9001", message: "CI / test failed" });
    const store = makeStateStoreMock();
    const processor = new FeedbackProcessor(store);

    const [items] = await processor.extractNewFeedback(
      makeTaskId(randomUUID()),
      makeExternalChangeId("I000"),
      [comment]
    );

    expect(items[0]?.source).toBe("ci_failure");
    expect(items[0]?.content).toBe("CI / test failed");
  });

  it("uses ci_failure source for comments with ci-failure- id prefix (Gerrit build failures)", async () => {
    const comment = makeComment({ id: "ci-failure-1700000000", message: "Build Failed" });
    const store = makeStateStoreMock();
    const processor = new FeedbackProcessor(store);

    const [items] = await processor.extractNewFeedback(
      makeTaskId(randomUUID()),
      makeExternalChangeId("I000"),
      [comment]
    );

    expect(items[0]?.source).toBe("ci_failure");
  });
});
