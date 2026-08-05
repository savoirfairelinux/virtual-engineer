import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import { makeTaskId, makeTicketId, makeExternalChangeId } from "../../src/interfaces.js";
import { randomUUID } from "crypto";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

function tempDbPath(): string {
  return tempDatabasePath("ve-test");
}

describe("SqliteStateStore — review dedup", () => {
  let store: SqliteStateStore;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
  });

  afterEach(() => {
    store.close();
  });

  describe("comment deduplication", () => {
    it("tracks processed comment ids", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("7"));

      const before = await store.getProcessedCommentIds(taskId);
      expect(before.size).toBe(0);

      await store.markCommentProcessed(taskId, "comment-abc");
      await store.markCommentProcessed(taskId, "comment-def");

      const after = await store.getProcessedCommentIds(taskId);
      expect(after.has("comment-abc")).toBe(true);
      expect(after.has("comment-def")).toBe(true);
      expect(after.has("comment-xyz")).toBe(false);
    });
  });

  describe("posted-review-comment deduplication", () => {
    it("records posted comments and exposes their hashes", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("rev-1"));
      const changeId = makeExternalChangeId("owner/repo#1");

      expect((await store.getPostedReviewCommentHashes(taskId)).size).toBe(0);

      await store.markReviewCommentsPosted(taskId, changeId, [
        { commentHash: "hash-a", file: "src/a.ts", line: 10, message: "Issue A", severity: "error" },
        { commentHash: "hash-b", file: "src/b.ts", line: 20, message: "Issue B", severity: "warning", providerThreadId: "thread-b" },
      ]);

      const hashes = await store.getPostedReviewCommentHashes(taskId);
      expect(hashes.has("hash-a")).toBe(true);
      expect(hashes.has("hash-b")).toBe(true);

      const records = await store.getPostedReviewComments(taskId);
      expect(records).toHaveLength(2);
      const b = records.find((r) => r.commentHash === "hash-b");
      expect(b?.providerThreadId).toBe("thread-b");
      expect(b?.resolved).toBe(false);
    });

    it("ignores duplicate hashes for the same task", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("rev-2"));
      const changeId = makeExternalChangeId("owner/repo#2");

      await store.markReviewCommentsPosted(taskId, changeId, [
        { commentHash: "dup", file: "src/a.ts", line: 1, message: "first", severity: "error" },
      ]);
      await store.markReviewCommentsPosted(taskId, changeId, [
        { commentHash: "dup", file: "src/a.ts", line: 99, message: "second", severity: "error" },
      ]);

      const records = await store.getPostedReviewComments(taskId);
      expect(records).toHaveLength(1);
      expect(records[0]?.line).toBe(1);
    });

    it("marks a posted comment as resolved", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("rev-3"));
      const changeId = makeExternalChangeId("owner/repo#3");

      await store.markReviewCommentsPosted(taskId, changeId, [
        { commentHash: "h", file: "src/a.ts", line: 5, message: "resolve me", severity: "error" },
      ]);
      const [rec] = await store.getPostedReviewComments(taskId);
      expect(rec).toBeDefined();

      await store.markReviewCommentResolved(rec!.id);

      const [updated] = await store.getPostedReviewComments(taskId);
      expect(updated?.resolved).toBe(true);
    });
  });

  describe("thread-reply ledger", () => {
    it("records posted replies and exposes their handled hashes", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("reply-1"));
      const changeId = makeExternalChangeId("owner/repo#10");

      expect((await store.getHandledThreadReplyHashes(taskId)).size).toBe(0);

      await store.markThreadReplyPosted(taskId, changeId, [
        { threadId: "disc-1", handledCommentHash: "hash-1", replyMessage: "Thanks, fixed." },
        { threadId: "disc-2", handledCommentHash: "hash-2", replyMessage: "I disagree." },
      ]);

      const hashes = await store.getHandledThreadReplyHashes(taskId);
      expect(hashes.has("hash-1")).toBe(true);
      expect(hashes.has("hash-2")).toBe(true);
      expect(hashes.has("hash-3")).toBe(false);
    });

    it("ignores duplicate (threadId, handledCommentHash) pairs", async () => {
      const taskId = makeTaskId(randomUUID());
      await store.createTask(taskId, makeTicketId("reply-2"));
      const changeId = makeExternalChangeId("owner/repo#11");

      await store.markThreadReplyPosted(taskId, changeId, [
        { threadId: "disc-1", handledCommentHash: "dup", replyMessage: "first" },
      ]);
      await store.markThreadReplyPosted(taskId, changeId, [
        { threadId: "disc-1", handledCommentHash: "dup", replyMessage: "second" },
      ]);

      const hashes = await store.getHandledThreadReplyHashes(taskId);
      expect(hashes.size).toBe(1);
    });

    it("scopes handled hashes per task", async () => {
      const taskA = makeTaskId(randomUUID());
      const taskB = makeTaskId(randomUUID());
      await store.createTask(taskA, makeTicketId("reply-3a"));
      await store.createTask(taskB, makeTicketId("reply-3b"));
      const changeId = makeExternalChangeId("owner/repo#12");

      await store.markThreadReplyPosted(taskA, changeId, [
        { threadId: "disc-1", handledCommentHash: "only-a", replyMessage: "hi" },
      ]);

      expect((await store.getHandledThreadReplyHashes(taskA)).has("only-a")).toBe(true);
      expect((await store.getHandledThreadReplyHashes(taskB)).has("only-a")).toBe(false);
    });
  });
});
