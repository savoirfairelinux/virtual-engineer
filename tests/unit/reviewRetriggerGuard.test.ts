import { describe, it, expect } from "vitest";
import {
  evaluateExistingReviewTask,
  type EvaluateExistingReviewTaskInput,
} from "../../src/review/reviewRetriggerGuard.js";

function makeInput(
  overrides: Partial<EvaluateExistingReviewTaskInput> = {}
): EvaluateExistingReviewTaskInput {
  return {
    existingState: "REVIEW_WATCHING",
    reviewedPatchset: 2,
    existingCurrentPatchset: 2,
    detailsCurrentPatchset: 2,
    force: false,
    ...overrides,
  };
}

describe("evaluateExistingReviewTask", () => {
  it("skips an automatic trigger when the current patchset was already reviewed", () => {
    expect(evaluateExistingReviewTask(makeInput())).toBe("skip-already-reviewed");
  });

  it("skips a terminal REVIEW_DONE row with an unrecorded (null) reviewedPatchset on the same patchset", () => {
    expect(
      evaluateExistingReviewTask(
        makeInput({ existingState: "REVIEW_DONE", reviewedPatchset: null, existingCurrentPatchset: 2, detailsCurrentPatchset: 2 })
      )
    ).toBe("skip-already-reviewed");
  });

  it("falls through for a REVIEW_DONE row with a null reviewedPatchset when the patchset advanced", () => {
    expect(
      evaluateExistingReviewTask(
        makeInput({ existingState: "REVIEW_DONE", reviewedPatchset: null, existingCurrentPatchset: 2, detailsCurrentPatchset: 3 })
      )
    ).toBe("fallthrough");
  });

  it("reuses (manual retrigger) an already-reviewed same-patchset task when force is set", () => {
    expect(evaluateExistingReviewTask(makeInput({ force: true }))).toBe("reuse-manual-retrigger");
  });

  it("skips a REVIEW_WATCHING task on the same patchset when not yet reviewed (still watching)", () => {
    expect(
      evaluateExistingReviewTask(
        makeInput({ existingState: "REVIEW_WATCHING", reviewedPatchset: null })
      )
    ).toBe("skip-watching");
  });

  it("skips an in-flight REVIEW_RUNNING task on the same patchset", () => {
    expect(
      evaluateExistingReviewTask(
        makeInput({ existingState: "REVIEW_RUNNING", reviewedPatchset: null })
      )
    ).toBe("skip-in-flight");
  });

  it("skips an in-flight REVIEW_COMMENTING task on the same patchset", () => {
    expect(
      evaluateExistingReviewTask(
        makeInput({ existingState: "REVIEW_COMMENTING", reviewedPatchset: null })
      )
    ).toBe("skip-in-flight");
  });

  it("reuses a REVIEW_PENDING task on the same patchset", () => {
    expect(
      evaluateExistingReviewTask(
        makeInput({ existingState: "REVIEW_PENDING", reviewedPatchset: null })
      )
    ).toBe("reuse-pending");
  });

  it("requeues a REVIEW_WATCHING task when a new patchset arrives", () => {
    expect(
      evaluateExistingReviewTask(
        makeInput({ existingState: "REVIEW_WATCHING", reviewedPatchset: 2, existingCurrentPatchset: 2, detailsCurrentPatchset: 3 })
      )
    ).toBe("requeue-new-patchset");
  });

  it("awaits an in-flight REVIEW_PENDING task when a new patchset arrives", () => {
    expect(
      evaluateExistingReviewTask(
        makeInput({ existingState: "REVIEW_PENDING", reviewedPatchset: null, existingCurrentPatchset: 2, detailsCurrentPatchset: 3 })
      )
    ).toBe("await-in-flight-new-patchset");
  });

  it("awaits an in-flight REVIEW_RUNNING task when a new patchset arrives", () => {
    expect(
      evaluateExistingReviewTask(
        makeInput({ existingState: "REVIEW_RUNNING", reviewedPatchset: null, existingCurrentPatchset: 2, detailsCurrentPatchset: 3 })
      )
    ).toBe("await-in-flight-new-patchset");
  });

  it("falls through for a terminal REVIEW_FAILED row (retry)", () => {
    expect(
      evaluateExistingReviewTask(
        makeInput({ existingState: "REVIEW_FAILED", reviewedPatchset: null })
      )
    ).toBe("fallthrough");
  });

  it("falls through for a terminal REVIEW_DONE row whose reviewed patchset does not match", () => {
    expect(
      evaluateExistingReviewTask(
        makeInput({ existingState: "REVIEW_DONE", reviewedPatchset: 1, existingCurrentPatchset: 2, detailsCurrentPatchset: 2 })
      )
    ).toBe("fallthrough");
  });

  it("falls through for a terminal REVIEW_DONE row when force is set even though the patchset matches", () => {
    expect(
      evaluateExistingReviewTask(
        makeInput({ existingState: "REVIEW_DONE", reviewedPatchset: 2, force: true })
      )
    ).toBe("fallthrough");
  });
});
