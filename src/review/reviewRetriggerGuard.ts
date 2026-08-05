import { TERMINAL_STATES, type TaskState } from "../interfaces.js";

/**
 * Decision produced by `evaluateExistingReviewTask` for a single existing
 * code-review task found during `ReviewOrchestrator.startReviewTask`.
 *
 * - `skip-already-reviewed`: VE already reviewed this exact patchset (or a
 *   legacy REVIEW_DONE row with an unrecorded patchset); do not create or
 *   reuse a task for an automatic trigger.
 * - `reuse-manual-retrigger`: same patchset, already reviewed, but the caller
 *   explicitly forced a re-run (e.g. a human re-added VE as a reviewer).
 * - `skip-watching`: same patchset, task is REVIEW_WATCHING — already
 *   reviewed and idle; a second trigger would be redundant.
 * - `skip-in-flight`: same patchset, a review is actively running or
 *   commenting — skip to avoid a concurrent second pass.
 * - `reuse-pending`: same patchset, task is REVIEW_PENDING (created but not
 *   yet run) — reuse it so the caller runs it.
 * - `requeue-new-patchset`: a new patchset arrived while the task was
 *   REVIEW_WATCHING — re-queue for a fresh review pass.
 * - `await-in-flight-new-patchset`: a new patchset arrived while the task was
 *   REVIEW_PENDING/REVIEW_RUNNING — a run is already in flight and will pick
 *   up the new patchset itself; no second trigger needed.
 * - `fallthrough`: the existing task is terminal (and not a duplicate of an
 *   already-reviewed patchset) — proceed to create a fresh review task.
 */
export type ExistingReviewTaskAction =
  | "skip-already-reviewed"
  | "reuse-manual-retrigger"
  | "skip-watching"
  | "skip-in-flight"
  | "reuse-pending"
  | "requeue-new-patchset"
  | "await-in-flight-new-patchset"
  | "fallthrough";

export interface EvaluateExistingReviewTaskInput {
  existingState: TaskState;
  /** `reviewedPatchset` recorded on the existing task, or null if never reviewed. */
  reviewedPatchset: number | null;
  /** `currentPatchset` recorded on the existing task. */
  existingCurrentPatchset: number;
  /** The change's actual current patchset, per fresh provider details. */
  detailsCurrentPatchset: number;
  /** True for manual relaunches (e.g. reviewer re-add); automatic triggers omit this. */
  force: boolean;
}

/**
 * Pure decision function for the duplicate-review guard in `startReviewTask`.
 * See `ExistingReviewTaskAction` for the meaning of each outcome. Automatic
 * triggers (stream backfill, polling, webhook re-deliveries) must never
 * re-review a patchset VE has already reviewed; only `force === true` bypasses
 * that guard.
 */
export function evaluateExistingReviewTask(
  input: EvaluateExistingReviewTaskInput
): ExistingReviewTaskAction {
  const alreadyReviewedThisPatchset =
    input.reviewedPatchset !== null && input.reviewedPatchset === input.detailsCurrentPatchset;

  // Legacy or interrupted REVIEW_DONE rows may have never recorded
  // reviewedPatchset. Treat a completed review with an unknown patchset as
  // already-reviewed so a startup backfill does not spawn a duplicate review,
  // guarded on the stored currentPatchset still matching the change's current
  // patchset so a NEW patchset is still reviewed. REVIEW_FAILED is
  // intentionally excluded so failed reviews can still retry.
  const doneWithUnknownPatchset =
    input.existingState === "REVIEW_DONE" &&
    input.reviewedPatchset === null &&
    input.existingCurrentPatchset === input.detailsCurrentPatchset;

  if ((alreadyReviewedThisPatchset || doneWithUnknownPatchset) && input.force !== true) {
    return "skip-already-reviewed";
  }

  if (!TERMINAL_STATES.has(input.existingState)) {
    if (input.existingCurrentPatchset === input.detailsCurrentPatchset) {
      if (alreadyReviewedThisPatchset && input.force === true) return "reuse-manual-retrigger";
      if (input.existingState === "REVIEW_WATCHING") return "skip-watching";
      if (input.existingState === "REVIEW_RUNNING" || input.existingState === "REVIEW_COMMENTING") {
        return "skip-in-flight";
      }
      return "reuse-pending";
    }
    // New patchset arrived while a task is still active.
    return input.existingState === "REVIEW_WATCHING" ? "requeue-new-patchset" : "await-in-flight-new-patchset";
  }

  // Terminal existing task that is NOT a duplicate of an already-reviewed
  // patchset (e.g. REVIEW_FAILED retry, or a manual force on a change whose
  // prior review is DONE): fall through to create a fresh review task.
  return "fallthrough";
}
