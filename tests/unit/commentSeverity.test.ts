import { describe, it, expect } from "vitest";
import {
  severityRank,
  applyVolumeAndSeverityGate,
  buildFoldedSummary,
} from "../../src/review/commentSeverity.js";
import type { InlineReviewComment } from "../../src/interfaces.js";

function c(
  file: string,
  line: number,
  severity: string,
  message = "msg"
): InlineReviewComment {
  return { file, line, message, severity };
}

describe("severityRank", () => {
  it("ranks the canonical ladder error > warning > info > nit", () => {
    expect(severityRank("error")).toBeGreaterThan(severityRank("warning"));
    expect(severityRank("warning")).toBeGreaterThan(severityRank("info"));
    expect(severityRank("info")).toBeGreaterThan(severityRank("nit"));
  });

  it("is case- and whitespace-insensitive", () => {
    expect(severityRank("  ERROR ")).toBe(severityRank("error"));
  });

  it("treats synonyms equivalently", () => {
    expect(severityRank("critical")).toBe(severityRank("error"));
    expect(severityRank("blocker")).toBe(severityRank("error"));
    expect(severityRank("warn")).toBe(severityRank("warning"));
    expect(severityRank("suggestion")).toBe(severityRank("info"));
    expect(severityRank("nitpick")).toBe(severityRank("nit"));
  });

  it("treats unknown severities as info", () => {
    expect(severityRank("whatever")).toBe(severityRank("info"));
  });
});

describe("applyVolumeAndSeverityGate", () => {
  it("folds comments below the minimum severity into the summary", () => {
    const comments = [c("a.ts", 1, "error"), c("b.ts", 2, "nit"), c("c.ts", 3, "info")];
    const { posted, folded } = applyVolumeAndSeverityGate(comments, {
      minSeverity: "warning",
      maxComments: 10,
    });
    expect(posted.map((x) => x.file)).toEqual(["a.ts"]);
    expect(folded.map((x) => x.file).sort()).toEqual(["b.ts", "c.ts"]);
  });

  it("keeps the most severe comments when the cap is exceeded", () => {
    const comments = [
      c("low.ts", 1, "info"),
      c("high.ts", 2, "error"),
      c("mid.ts", 3, "warning"),
    ];
    const { posted, folded } = applyVolumeAndSeverityGate(comments, {
      minSeverity: "info",
      maxComments: 2,
    });
    expect(posted.map((x) => x.file)).toEqual(["high.ts", "mid.ts"]);
    expect(folded.map((x) => x.file)).toEqual(["low.ts"]);
  });

  it("is a no-op when everything fits and meets the threshold", () => {
    const comments = [c("a.ts", 1, "error"), c("b.ts", 2, "warning")];
    const { posted, folded } = applyVolumeAndSeverityGate(comments, {
      minSeverity: "info",
      maxComments: 10,
    });
    expect(posted).toHaveLength(2);
    expect(folded).toHaveLength(0);
  });
});

describe("buildFoldedSummary", () => {
  it("returns an empty string when nothing is folded", () => {
    expect(buildFoldedSummary([])).toBe("");
  });

  it("renders a compact appendix with file, line, severity and message", () => {
    const summary = buildFoldedSummary([c("a.ts", 7, "nit", "Use   const\nhere")]);
    expect(summary).toContain("Additional notes (not posted inline):");
    expect(summary).toContain("a.ts:7 (nit) — Use const here");
  });

  it("renders file-level comments (line 0) without a :0 suffix", () => {
    const summary = buildFoldedSummary([c("a.ts", 0, "warning", "File-level note")]);
    expect(summary).toContain("- a.ts (warning) — File-level note");
    expect(summary).not.toContain("a.ts:0");
  });
});
