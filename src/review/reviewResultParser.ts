import type { ReviewAgentResult } from "../interfaces.js";
import {
  REVIEW_RESULT_END_MARKER,
  REVIEW_RESULT_START_MARKER,
  parseReviewPayload,
} from "./reviewOutputContract.js";

/**
 * Parser for integration-specific structured review output.
 *
 * Every payload requires comments, summary, and replies. The decision field is
 * provider-specific: Gerrit uses vote, GitHub uses reviewAction, and GitLab uses
 * approvalAction. Delimited output is preferred; balanced bare JSON remains an
 * Aider transport fallback.
 */

export class ReviewResultParseError extends Error {
  constructor(message: string, public readonly raw?: string) {
    super(message);
    this.name = "ReviewResultParseError";
  }
}

function extractJsonObjects(raw: string): unknown[] {
  const parsedObjects: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      if (depth === 0) start = index;
      depth++;
    } else if (character === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          parsedObjects.push(JSON.parse(raw.slice(start, index + 1)) as unknown);
        } catch {
          // Keep scanning for a later balanced object that matches the contract.
        }
        start = -1;
      }
    }
  }

  return parsedObjects;
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
    for (const fallbackJson of extractJsonObjects(raw)) {
      if (
        typeof fallbackJson === "object" &&
        fallbackJson !== null &&
        !Array.isArray(fallbackJson) &&
        (fallbackJson as Record<string, unknown>)["status"] === "failed"
      ) {
        const summary = (fallbackJson as Record<string, unknown>)["summary"];
        throw new ReviewResultParseError(
          typeof summary === "string" && summary.trim()
            ? summary
            : "Agent worker reported a failed review execution",
          raw
        );
      }
      if (
        fallbackJson !== undefined &&
        typeof fallbackJson === "object" &&
        fallbackJson !== null &&
        !Array.isArray(fallbackJson)
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
    throw new ReviewResultParseError(
      `Missing ${REVIEW_RESULT_END_MARKER} marker in agent output`,
      raw,
    );
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
