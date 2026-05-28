import type { InlineReviewComment } from "../interfaces.js";
import { getLogger } from "../logger.js";

const log = getLogger("review-comment-filter");

export function filterCommentsByAllowedFiles(
  comments: InlineReviewComment[],
  allowedFiles: ReadonlySet<string> | undefined,
  ctx: Record<string, unknown>
): InlineReviewComment[] {
  if (allowedFiles === undefined) return comments;
  const kept: InlineReviewComment[] = [];
  const dropped: string[] = [];
  for (const c of comments) {
    if (allowedFiles.has(c.file)) kept.push(c);
    else dropped.push(c.file);
  }
  if (dropped.length > 0) {
    log.warn(
      { ...ctx, droppedCount: dropped.length, droppedFiles: Array.from(new Set(dropped)) },
      "dropped review comments referencing files outside the patchset"
    );
  }
  return kept;
}
