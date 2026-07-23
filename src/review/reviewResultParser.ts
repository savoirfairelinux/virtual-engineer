import type { ReviewAgentResult } from "../interfaces.js";
import {
  REVIEW_RESULT_END_MARKER,
  REVIEW_RESULT_START_MARKER,
  parseReviewPayload,
} from "./reviewOutputContract.js";

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
 *     "vote": -1
 *   }
 *   REVIEW_RESULT_END
 */

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
export function parseReviewResult(raw: string, providerKind = "gerrit"): ReviewAgentResult {
  const startIdx = raw.indexOf(REVIEW_RESULT_START_MARKER);
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
        const fallbackParsed = parseReviewPayload(providerKind, fallbackJson);
        if (fallbackParsed) {
          return fallbackParsed;
        }
      }
    }
    throw new ReviewResultParseError(
      `Missing ${REVIEW_RESULT_START_MARKER} marker in agent output`,
      raw
    );
  }
  const endIdx = raw.indexOf(
    REVIEW_RESULT_END_MARKER,
    startIdx + REVIEW_RESULT_START_MARKER.length,
  );
  if (endIdx === -1) {
    // The model output was truncated — likely a repetition loop that hit the
    // max-tokens cap, or a context-window overflow. Rather than throwing (which
    // causes the task to fail and retry, leading to the same loop), return a
    // result with a summary that explains the situation. The score is negative
    // so a truncated/incomplete review is never treated as a positive decision.
    return {
      comments: [],
      summary:
        "Review output was truncated (missing REVIEW_RESULT_END marker). " +
        "The model may have hit token limits or entered a repetition loop. " +
        "Re-run the review or switch to a model with better instruction-following.",
      score: -1,
      replies: [],
    };
  }

  const between = raw.slice(startIdx + REVIEW_RESULT_START_MARKER.length, endIdx).trim();
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

  const parsed = parseReviewPayload(providerKind, json);
  if (!parsed) {
    throw new ReviewResultParseError(
      `REVIEW_RESULT block does not match the ${providerKind} review schema`,
      stripped
    );
  }
  return parsed;
}

/**
 * Return the provider-neutral decision normalized by the output contract.
 */
export function getReviewDecision(result: ReviewAgentResult): -1 | 0 | 1 {
  return result.score;
}
