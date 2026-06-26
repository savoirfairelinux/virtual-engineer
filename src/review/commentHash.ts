import { createHash } from "node:crypto";
import type { InlineReviewComment } from "../interfaces.js";

/**
 * Compute a stable deduplication hash for a review comment.
 *
 * The hash is derived from the file path and a normalized form of the message
 * only — the line number is intentionally excluded so the same logical comment
 * is still recognized as a duplicate after a later patchset shifts its line.
 *
 * Normalization collapses runs of whitespace, trims, and lowercases the message
 * so trivial reformatting by the model does not defeat deduplication.
 */
export function computeCommentHash(
  comment: Pick<InlineReviewComment, "file" | "message">
): string {
  const normalizedFile = comment.file.trim();
  const normalizedMessage = normalizeMessage(comment.message);
  return createHash("sha1")
    .update(`${normalizedFile}\n${normalizedMessage}`)
    .digest("hex");
}

function normalizeMessage(message: string): string {
  return message.trim().replace(/\s+/g, " ").toLowerCase();
}
