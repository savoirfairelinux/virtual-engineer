import { describe, expect, it } from "vitest";
import { isReviewBranchSelected, normalizeReviewBranchName, normalizeReviewBranches } from "../../src/domain/reviewRepository.js";

describe("normalizeReviewBranchName", () => {
  it("returns the short name, which is empty for a bare refs/heads/ prefix", () => {
    expect(normalizeReviewBranchName(" refs/heads/python ")).toBe("python");
    expect(normalizeReviewBranchName("refs/heads/")).toBe("");
  });
});

describe("normalizeReviewBranches", () => {
  it("trims names, strips refs/heads/, drops blanks, and removes duplicates in order", () => {
    expect(normalizeReviewBranches([" python ", "refs/heads/main", "", "  ", "python", "main"]))
      .toEqual(["python", "main"]);
  });
});

describe("isReviewBranchSelected", () => {
  it("selects every branch when no branch list is configured", () => {
    expect(isReviewBranchSelected(undefined, "python")).toBe(true);
    expect(isReviewBranchSelected([], "python")).toBe(true);
  });

  it("selects only exactly listed branches", () => {
    expect(isReviewBranchSelected(["main", "python"], "python")).toBe(true);
    expect(isReviewBranchSelected(["main"], "python")).toBe(false);
    expect(isReviewBranchSelected(["main"], "Main")).toBe(false);
    expect(isReviewBranchSelected(["release"], "release/1.0")).toBe(false);
  });

  it("compares short names when either side uses a full refs/heads/ ref", () => {
    expect(isReviewBranchSelected(["refs/heads/python"], "python")).toBe(true);
    expect(isReviewBranchSelected(["python"], "refs/heads/python")).toBe(true);
  });
});
