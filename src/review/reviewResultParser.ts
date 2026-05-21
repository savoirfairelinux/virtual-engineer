import { z } from "zod";
import type { InlineReviewComment, ReviewAgentResult, ReviewSeverity } from "../interfaces.js";

/**
 * Parser for the structured block emitted by the code-review agent.
 *
 * The agent is required to produce a single JSON block delimited by
 * `REVIEW_RESULT_START` and `REVIEW_RESULT_END` markers. Anything outside
 * the markers (chat-style preamble, tool traces, ...) is ignored.
 *
 * Example expected payload:
 *
 *   REVIEW_RESULT_START
 *   {
 *     "comments": [
 *       {"file": "src/foo.ts", "line": 42, "message": "...", "severity": "error"}
 *     ],
 *     "summary": "Overall assessment...",
 *     "score": -1
 *   }
 *   REVIEW_RESULT_END
 */

const START_MARKER = "REVIEW_RESULT_START";
const END_MARKER = "REVIEW_RESULT_END";

const SeveritySchema: z.ZodType<ReviewSeverity> = z.string().min(1);

const InlineCommentSchema: z.ZodType<InlineReviewComment> = z.object({
  file: z.string().min(1),
  line: z.number().int().nonnegative(),
  message: z.string().min(1),
  severity: SeveritySchema,
});

const PayloadSchema = z.object({
  comments: z.array(InlineCommentSchema).default([]),
  summary: z.string().default(""),
  score: z.union([z.literal(-1), z.literal(0), z.literal(1)]).default(0),
});

export class ReviewResultParseError extends Error {
  constructor(message: string, public readonly raw?: string) {
    super(message);
    this.name = "ReviewResultParseError";
  }
}

/**
 * Extract and parse the REVIEW_RESULT_* block from the agent's output.
 * Throws ReviewResultParseError if no block is found or the JSON is invalid.
 */
export function parseReviewResult(raw: string): ReviewAgentResult {
  const startIdx = raw.indexOf(START_MARKER);
  if (startIdx === -1) {
    // Fallback: the model may have emitted bare JSON without markers.
    // Try to parse the entire output (or first JSON object) as a valid payload.
    // Guard: never accept agent-worker error envelopes (status: "failed") as
    // review results — those should have been caught by the caller already.
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      let fallbackJson: unknown;
      try {
        fallbackJson = JSON.parse(jsonMatch[0]);
      } catch {
        // not valid JSON either — fall through to the original error
      }
      if (
        fallbackJson !== undefined &&
        (fallbackJson as Record<string, unknown>)["status"] !== "failed"
      ) {
        const fallbackParsed = PayloadSchema.safeParse(fallbackJson);
        if (fallbackParsed.success) {
          return fallbackParsed.data;
        }
      }
    }
    throw new ReviewResultParseError(
      `Missing ${START_MARKER} marker in agent output`,
      raw
    );
  }
  const endIdx = raw.indexOf(END_MARKER, startIdx + START_MARKER.length);
  if (endIdx === -1) {
    throw new ReviewResultParseError(
      `Missing ${END_MARKER} marker in agent output`,
      raw
    );
  }

  const between = raw.slice(startIdx + START_MARKER.length, endIdx).trim();
  // Allow the agent to wrap the JSON in ```json ... ``` fences.
  const stripped = between
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let json: unknown;
  try {
    json = JSON.parse(stripped);
  } catch (err) {
    throw new ReviewResultParseError(
      `Invalid JSON in REVIEW_RESULT block: ${(err as Error).message}`,
      stripped
    );
  }

  const parsed = PayloadSchema.safeParse(json);
  if (!parsed.success) {
    throw new ReviewResultParseError(
      `REVIEW_RESULT block does not match schema: ${parsed.error.message}`,
      stripped
    );
  }
  return parsed.data;
}

/**
 * Compute a Code-Review-style vote from the agent result.
 *
 * Rules:
 * - If the agent provided an explicit non-zero score, honour it.
 * - score=0: any `error` or `warning` → -1; otherwise → +1.
 * - Empty comments → +1.
 */
export function computeVote(result: ReviewAgentResult): -1 | 1 {
  if (result.score < 0) return -1;
  if (result.score > 0) return 1;

  let hasBlocking = false;
  for (const c of result.comments) {
    const severity = c.severity.trim().toLowerCase();
    if (severity === "error" || severity === "warning") {
      hasBlocking = true;
      break;
    }
  }
  return hasBlocking ? -1 : 1;
}
