import { describe, it, expect } from "vitest";
import {
  ReviewResultParseError,
  computeVote,
  parseReviewResult,
} from "../../src/review/reviewResultParser.js";
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

describe("parseReviewResult", () => {
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

  it("throws ReviewResultParseError when the start marker is missing", () => {
    expect(() => parseReviewResult("no marker here")).toThrow(ReviewResultParseError);
  });

  it("throws ReviewResultParseError when the end marker is missing", () => {
    expect(() => parseReviewResult("REVIEW_RESULT_START\n{}")).toThrow(ReviewResultParseError);
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

describe("computeVote", () => {
  const make = (overrides: Partial<ReviewAgentResult>): ReviewAgentResult => ({
    comments: [],
    summary: "",
    score: 0,
    ...overrides,
  });

  it("honours an explicit -1 score", () => {
    expect(computeVote(make({ score: -1 }))).toBe(-1);
  });

  it("honours an explicit +1 score", () => {
    expect(computeVote(make({ score: 1 }))).toBe(1);
  });

  it("returns -1 when score=0 but at least one error comment is present", () => {
    expect(
      computeVote(
        make({
          comments: [{ file: "a.ts", line: 1, message: "x", severity: "error" }],
        })
      )
    ).toBe(-1);
  });

  it("returns -1 when score=0 but at least one warning comment is present", () => {
    expect(
      computeVote(
        make({
          comments: [{ file: "a.ts", line: 1, message: "x", severity: "warning" }],
        })
      )
    ).toBe(-1);
  });

  it("returns +1 when score=0 and only non-blocking severities are present", () => {
    expect(
      computeVote(
        make({
          comments: [{ file: "a.ts", line: 1, message: "x", severity: "Good" }],
        })
      )
    ).toBe(1);
  });

  it("returns +1 for an empty review", () => {
    expect(computeVote(make({}))).toBe(1);
  });
});
