import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type {
  ExternalChangeId,
  PostedReviewComment,
  PostedReviewCommentInput,
  TaskId,
  ThreadReplyRecordInput,
} from "../../interfaces.js";
import { makeExternalChangeId } from "../../interfaces.js";
import { postedReviewComments, processedComments, reviewThreadReplies } from "../schema.js";
import * as schema from "../schema.js";

export interface ReviewDedupStoreApi {
  getProcessedCommentIds(taskId: TaskId): Promise<Set<string>>;
  markCommentProcessed(taskId: TaskId, gerritCommentId: string): Promise<void>;
  getPostedReviewCommentHashes(taskId: TaskId): Promise<Set<string>>;
  getPostedReviewComments(taskId: TaskId): Promise<PostedReviewComment[]>;
  markReviewCommentsPosted(
    taskId: TaskId,
    changeId: ExternalChangeId,
    comments: PostedReviewCommentInput[]
  ): Promise<void>;
  markReviewCommentResolved(id: number): Promise<void>;
  getHandledThreadReplyHashes(taskId: TaskId): Promise<Set<string>>;
  markThreadReplyPosted(
    taskId: TaskId,
    changeId: ExternalChangeId,
    replies: ThreadReplyRecordInput[]
  ): Promise<void>;
}

interface ReviewDedupStoreContext {
  db: BetterSQLite3Database<typeof schema>;
  raw: Database.Database;
}

export function createReviewDedupStore(context: ReviewDedupStoreContext): ReviewDedupStoreApi {
  const { db, raw } = context;

  async function getProcessedCommentIds(taskId: TaskId): Promise<Set<string>> {
    const rows = await db.query.processedComments.findMany({
      where: eq(processedComments.taskId, taskId),
    });
    return new Set(rows.map((row) => row.gerritCommentId));
  }

  async function markCommentProcessed(taskId: TaskId, gerritCommentId: string): Promise<void> {
    await db.insert(processedComments).values({
      taskId,
      gerritCommentId,
      createdAt: new Date(),
    });
  }

  async function getPostedReviewCommentHashes(taskId: TaskId): Promise<Set<string>> {
    const rows = await db.query.postedReviewComments.findMany({
      where: eq(postedReviewComments.taskId, taskId),
    });
    return new Set(rows.map((row) => row.commentHash));
  }

  async function getPostedReviewComments(taskId: TaskId): Promise<PostedReviewComment[]> {
    const rows = await db.query.postedReviewComments.findMany({
      where: eq(postedReviewComments.taskId, taskId),
    });
    return rows.map((row) => ({
      id: row.id,
      taskId: row.taskId as TaskId,
      changeId: makeExternalChangeId(row.changeId),
      commentHash: row.commentHash,
      file: row.file,
      line: row.line,
      message: row.message,
      severity: row.severity,
      providerThreadId: row.providerThreadId,
      resolved: row.resolved === 1,
      createdAt: row.createdAt,
    }));
  }

  async function markReviewCommentsPosted(
    taskId: TaskId,
    changeId: ExternalChangeId,
    comments: PostedReviewCommentInput[]
  ): Promise<void> {
    if (comments.length === 0) return;
    const now = Math.floor(Date.now() / 1000);
    // INSERT OR IGNORE so a duplicate (task_id, comment_hash) is silently skipped
    // rather than aborting the whole batch on the unique index.
    const stmt = raw.prepare(
      `INSERT OR IGNORE INTO posted_review_comments
         (task_id, change_id, comment_hash, file, line, message, severity, provider_thread_id, resolved, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    );
    const insertMany = raw.transaction((items: PostedReviewCommentInput[]) => {
      for (const c of items) {
        stmt.run(
          taskId,
          String(changeId),
          c.commentHash,
          c.file,
          c.line,
          c.message,
          c.severity,
          c.providerThreadId ?? null,
          now
        );
      }
    });
    insertMany(comments);
  }

  async function markReviewCommentResolved(id: number): Promise<void> {
    raw.prepare("UPDATE posted_review_comments SET resolved = 1 WHERE id = ?").run(id);
  }

  async function getHandledThreadReplyHashes(taskId: TaskId): Promise<Set<string>> {
    const rows = await db.query.reviewThreadReplies.findMany({
      where: eq(reviewThreadReplies.taskId, taskId),
    });
    return new Set(rows.map((row) => row.handledCommentHash));
  }

  async function markThreadReplyPosted(
    taskId: TaskId,
    changeId: ExternalChangeId,
    replies: ThreadReplyRecordInput[]
  ): Promise<void> {
    if (replies.length === 0) return;
    const now = Math.floor(Date.now() / 1000);
    // INSERT OR IGNORE so a duplicate (task_id, thread_id, handled_comment_hash)
    // is silently skipped rather than aborting the whole batch.
    const stmt = raw.prepare(
      `INSERT OR IGNORE INTO review_thread_replies
         (task_id, change_id, thread_id, handled_comment_hash, reply_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertMany = raw.transaction((items: ThreadReplyRecordInput[]) => {
      for (const r of items) {
        stmt.run(taskId, String(changeId), r.threadId, r.handledCommentHash, r.replyMessage, now);
      }
    });
    insertMany(replies);
  }

  return {
    getProcessedCommentIds,
    markCommentProcessed,
    getPostedReviewCommentHashes,
    getPostedReviewComments,
    markReviewCommentsPosted,
    markReviewCommentResolved,
    getHandledThreadReplyHashes,
    markThreadReplyPosted,
  };
}
