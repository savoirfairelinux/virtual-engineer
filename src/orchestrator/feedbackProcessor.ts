import type {
  FeedbackItem,
  ReviewComment,
  ExternalChangeId,
  StateStore,
  TaskId,
} from "../interfaces.js";
import { getLogger } from "../logger.js";

const log = getLogger("feedback-processor");

/** Deduplicates review comments and formats them as FeedbackItems for the next agent cycle. */
export class FeedbackProcessor {
  constructor(private readonly stateStore: StateStore) {}

  /**
   * Returns new unresolved comments as [FeedbackItems, ReviewComments] and marks them processed.
   */
  async extractNewFeedback(
    taskId: TaskId,
    changeId: ExternalChangeId,
    comments: ReviewComment[]
  ): Promise<readonly [FeedbackItem[], ReviewComment[]]> {
    const processedIds = await this.stateStore.getProcessedCommentIds(taskId);

    const newComments = comments.filter(
      (c) => c.unresolved && !processedIds.has(c.id)
    );

    if (newComments.length === 0) {
      log.debug({ taskId, changeId }, "no new actionable comments");
      return [[], []];
    }

    log.info(
      { taskId, changeId, count: newComments.length },
      "new actionable Gerrit comments detected"
    );

    // Mark all as processed before returning — prevents re-processing on restart
    for (const comment of newComments) {
      await this.stateStore.markCommentProcessed(taskId, comment.id);
    }

    const feedbackItems = newComments.map((c) => this.toFeedbackItem(c));
    return [feedbackItems, newComments];
  }

  /** Convert a ReviewComment to a FeedbackItem for agent consumption. */
  private toFeedbackItem(comment: ReviewComment): FeedbackItem {
    return {
      source: "gerrit_review",
      content: comment.message,
      filePath: comment.filePath,
      line: comment.line,
    };
  }
}
