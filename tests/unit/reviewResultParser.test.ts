import { describe, it, expect } from "vitest";
import {
  ReviewResultParseError,
  getReviewDecision,
  parseReviewResult,
} from "../../src/review/reviewResultParser.js";
import { getReviewOutputContract } from "../../src/review/reviewOutputContract.js";
import type { ReviewAgentResult } from "../../src/interfaces.js";

function wrap(json: unknown): string {
  return [
    "Hello, here is the review.",
    "REVIEW_RESULT_START",
    JSON.stringify(json),
    "REVIEW_RESULT_END",
    "Thanks!",
  ].join("\n");
}

describe("review output contracts", () => {
  it("uses the native decision field for each review integration", () => {
    const gerrit = getReviewOutputContract("gerrit");
    const github = getReviewOutputContract("github");
    const gitlab = getReviewOutputContract("gitlab");

    expect(gerrit).toContain('"vote"');
    expect(gerrit).not.toContain('"reviewAction"');
    expect(github).toContain('"reviewAction"');
    expect(github).not.toContain('"vote"');
    expect(gitlab).toContain('"approvalAction"');
    expect(gitlab).not.toContain('"vote"');
  });

  it("rejects integrations without a defined output contract", () => {
    expect(() => getReviewOutputContract("unknown")).toThrow(
      "Unsupported review output contract: unknown"
    );
  });
});

describe("parseReviewResult", () => {
  it("parses the native Gerrit vote contract", () => {
    const result = parseReviewResult(
      wrap({ comments: [], summary: "needs work", vote: -1, replies: [] }),
      "gerrit"
    );
    expect(result.score).toBe(-1);
  });

  it("normalizes GitHub review actions without treating COMMENT as a vote", () => {
    const result = parseReviewResult(
      wrap({ comments: [], summary: "notes only", reviewAction: "COMMENT", replies: [] }),
      "github"
    );
    expect(result.score).toBe(0);
  });

  it("normalizes GitLab approval actions", () => {
    const result = parseReviewResult(
      wrap({ comments: [], summary: "ready", approvalAction: "APPROVE", replies: [] }),
      "gitlab"
    );
    expect(result.score).toBe(1);
  });

  it("rejects a native contract belonging to another integration", () => {
    expect(() =>
      parseReviewResult(
        wrap({ comments: [], summary: "ready", reviewAction: "APPROVE", replies: [] }),
        "gerrit"
      )
    ).toThrow(ReviewResultParseError);
  });

  it("extracts and parses a well-formed REVIEW_RESULT block", () => {
    const result = parseReviewResult(
      wrap({
        comments: [
          { file: "src/foo.ts", line: 10, message: "Possible NPE", severity: "error" },
        ],
        summary: "One blocking issue.",
        score: -1,
      })
    );

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.severity).toBe("error");
    expect(result.summary).toBe("One blocking issue.");
    expect(result.score).toBe(-1);
  });

  it("strips ```json fences inside the marker block", () => {
    const raw = [
      "REVIEW_RESULT_START",
      "```json",
      JSON.stringify({ comments: [], summary: "ok", score: 1 }),
      "```",
      "REVIEW_RESULT_END",
    ].join("\n");
    expect(parseReviewResult(raw).score).toBe(1);
  });

  it("defaults missing score to 0", () => {
    const result = parseReviewResult(wrap({ comments: [], summary: "ok" }));
    expect(result.score).toBe(0);
  });

  it("defaults missing replies to an empty array", () => {
    const result = parseReviewResult(wrap({ comments: [], summary: "ok", score: 1 }));
    expect(result.replies).toEqual([]);
  });

  it("parses thread replies", () => {
    const result = parseReviewResult(
      wrap({
        comments: [],
        summary: "ok",
        score: 1,
        replies: [
          { threadId: "disc-1", message: "Good point, fixed." },
          { threadId: "disc-2", message: "I disagree because X." },
        ],
      })
    );
    expect(result.replies).toHaveLength(2);
    expect(result.replies[0]).toEqual({ threadId: "disc-1", message: "Good point, fixed." });
    expect(result.replies[1]?.threadId).toBe("disc-2");
  });

  it("drops replies with empty threadId or message via schema validation", () => {
    expect(() =>
      parseReviewResult(
        wrap({ comments: [], summary: "ok", score: 1, replies: [{ threadId: "", message: "x" }] })
      )
    ).toThrow(ReviewResultParseError);
  });

  it("throws ReviewResultParseError when the start marker is missing", () => {
    expect(() => parseReviewResult("no marker here")).toThrow(ReviewResultParseError);
  });

  it("returns a non-passing fallback result when the end marker is missing (truncated output)", () => {
    const result = parseReviewResult("REVIEW_RESULT_START\n{}");
    // Truncated output must not yield a passing (+1) vote.
    expect(result.score).toBe(-1);
    expect(getReviewDecision(result)).toBe(-1);
    expect(result.comments).toEqual([]);
    expect(result.summary).toMatch(/truncated/i);
  });

  it("throws ReviewResultParseError on invalid JSON", () => {
    expect(() => parseReviewResult(wrap("not-json"))).toThrow(ReviewResultParseError);
  });

  it("accepts arbitrary severity values", () => {
    const raw = wrap({
      comments: [{ file: "a.ts", line: 1, message: "x", severity: "Good" }],
      summary: "",
      score: -1,
    });
    expect(parseReviewResult(raw).comments[0]?.severity).toBe("Good");
  });
});

describe("getReviewDecision", () => {
  const make = (overrides: Partial<ReviewAgentResult>): ReviewAgentResult => ({
    comments: [],
    summary: "",
    score: 0,
    replies: [],
    ...overrides,
  });

  it("honours an explicit -1 score", () => {
    expect(getReviewDecision(make({ score: -1 }))).toBe(-1);
  });

  it("honours an explicit +1 score", () => {
    expect(getReviewDecision(make({ score: 1 }))).toBe(1);
  });

  it("preserves an explicit neutral decision", () => {
    expect(getReviewDecision(make({ score: 0 }))).toBe(0);
  });

  it("does not turn a neutral decision into a rejection based on error severity", () => {
    expect(
      getReviewDecision(
        make({
          comments: [{ file: "a.ts", line: 1, message: "x", severity: "error" }],
        })
      )
    ).toBe(0);
  });

  it("does not turn a neutral decision into a rejection based on warning severity", () => {
    expect(
      getReviewDecision(
        make({
          comments: [{ file: "a.ts", line: 1, message: "x", severity: "warning" }],
        })
      )
    ).toBe(0);
  });

  it("does not turn a neutral decision into an approval based on non-blocking severities", () => {
    expect(
      getReviewDecision(
        make({
          comments: [{ file: "a.ts", line: 1, message: "x", severity: "Good" }],
        })
      )
    ).toBe(0);
  });

  it("keeps an empty neutral review neutral", () => {
    expect(getReviewDecision(make({}))).toBe(0);
  });
});
