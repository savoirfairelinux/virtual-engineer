import { describe, it, expect, vi } from "vitest";
import { FeedbackProcessor } from "../../src/orchestrator/feedbackProcessor.js";
import type { StateStore, GerritComment } from "../../src/interfaces.js";
import { makeTaskId, makeExternalChangeId } from "../../src/interfaces.js";
import { randomUUID } from "crypto";

function makeComment(overrides: Partial<GerritComment> = {}): GerritComment {
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

  it("maps comment fields to FeedbackItem", async () => {
    const comment = makeComment({
      message: "This function is wrong",
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
      source: "gerrit_review",
      content: "This function is wrong",
      filePath: "src/foo.ts",
      line: 42,
    });
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
});
