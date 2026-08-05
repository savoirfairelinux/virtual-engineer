import type { ThreadReply } from "../interfaces.js";

/**
 * Should this review pass stay silent instead of re-posting an unchanged
 * verdict? Avoids spamming another summary + vote notification when a
 * re-review finds nothing new (no inline comments, no folded notes) and the
 * overall vote matches the last review cycle. Decoupled from discussion
 * replies: a pending reply is always delivered independently of this gate.
 */
export function shouldSkipReviewPosting(input: {
  /** True for manual relaunches; automatic re-reviews always respect the gate. */
  force: boolean;
  cycleNumber: number;
  /** No new inline comments and no folded notes this pass. */
  hasNothingNew: boolean;
  previousDecision: -1 | 0 | 1 | null;
  decision: -1 | 0 | 1;
}): boolean {
  return (
    !input.force &&
    input.cycleNumber > 1 &&
    input.hasNothingNew &&
    input.previousDecision !== null &&
    input.previousDecision === input.decision
  );
}

export interface EligibleThreadEntry {
  handledHash: string;
}

export interface ThreadReplyToPost {
  threadId: string;
  message: string;
  handledHash: string;
}

/**
 * Validate the agent's replies against the eligible thread set: drop
 * hallucinated threadIds and duplicates, require a non-empty body, and cap
 * the volume. Replies are posted independently of the summary gate.
 */
export function selectRepliesToPost(
  replies: ThreadReply[],
  threadById: ReadonlyMap<string, EligibleThreadEntry>,
  maxReplies: number
): ThreadReplyToPost[] {
  const repliesToPost: ThreadReplyToPost[] = [];
  const seenReplyThreadIds = new Set<string>();
  for (const reply of replies) {
    if (repliesToPost.length >= maxReplies) break;
    if (seenReplyThreadIds.has(reply.threadId)) continue;
    const entry = threadById.get(reply.threadId);
    if (entry === undefined) continue; // hallucinated or already-handled thread
    const message = reply.message.trim();
    if (message.length === 0) continue;
    seenReplyThreadIds.add(reply.threadId);
    repliesToPost.push({ threadId: reply.threadId, message, handledHash: entry.handledHash });
  }
  return repliesToPost;
}
