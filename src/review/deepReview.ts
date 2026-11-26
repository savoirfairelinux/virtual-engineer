/**
 * Deep review: a staged alternative to the single review run.
 *
 * An intent stage checks what the change is meant to do; four specialist
 * stages, told what the intent stage raised, cover one aspect each; a final
 * stage merges and orders their candidate findings and produces the complete
 * review. This module only orchestrates: the caller supplies `runStage`, which
 * owns slots, workspaces, the sandbox run, and parsing.
 */
import type { InlineReviewComment, ReviewAgentResult } from "../interfaces.js";
import { ONION_LAYERS, PANEL_SPECIALISTS, rankerInstructions, withOuterNotes, type SpecialistId } from "./deepReviewPrompts.js";

export type DeepStageId = "intent" | SpecialistId | "rank";

export interface DeepStageRequest {
  stageId: DeepStageId;
  /** 1 for the first try, 2 for the retry. */
  attempt: number;
  /** Workflow Instructions of the stage, used in place of the agent's bound prompt. */
  instructions: string;
  /**
   * `finding`: the change, diff, prior comments without reassessment, and the
   * inter-patchset delta. `full`: the same inputs as a standard single pass.
   */
  context: "finding" | "full";
}

export interface DeepStageOutput {
  rawOutput: string;
  result: ReviewAgentResult;
}

export interface DeepStageRecord {
  id: DeepStageId;
  attempts: number;
  /** Candidate comments kept from a finding stage, or comments of the final stage. */
  comments: number;
  durationMs: number;
  failed: boolean;
}

export interface DeepReviewInput {
  /** Aborts the whole pass; an aborted stage is never retried. */
  signal: AbortSignal;
  runStage: (request: DeepStageRequest) => Promise<DeepStageOutput>;
  /** Keep only finding-stage comments that could be posted (in the diff, at or above the severity floor). */
  selectCandidates: (comments: readonly InlineReviewComment[]) => InlineReviewComment[];
  /** Runs before the final stage; throw to stop the pass, for example when the change moved on. */
  beforeRank?: (() => Promise<void>) | undefined;
  emit?: ((type: string, data: Record<string, unknown>) => void) | undefined;
  /** Receives one record per stage as stages finish. */
  records?: DeepStageRecord[] | undefined;
  now?: (() => number) | undefined;
}

const MAX_ATTEMPTS = 2;

interface StageRun {
  output: DeepStageOutput | undefined;
  errors: string[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Concatenate comments in stage order, dropping exact repeats of (file, line, message). */
export function mergeCandidates(groups: ReadonlyArray<readonly InlineReviewComment[]>): InlineReviewComment[] {
  const seen = new Set<string>();
  const merged: InlineReviewComment[] = [];
  for (const comments of groups) {
    for (const comment of comments) {
      const key = `${comment.file}\0${comment.line}\0${comment.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(comment);
    }
  }
  return merged;
}

/** Run the deep review pipeline and return the final stage's output as the pass result. */
export async function runDeepReview(input: DeepReviewInput): Promise<DeepStageOutput> {
  const now = input.now ?? Date.now;
  const emit = input.emit ?? ((): void => undefined);
  const records = input.records ?? [];

  const runStage = async (
    stageId: DeepStageId,
    instructions: string,
    context: DeepStageRequest["context"],
    countComments: (output: DeepStageOutput) => number,
  ): Promise<StageRun & { record: DeepStageRecord }> => {
    const startedAt = now();
    const errors: string[] = [];
    let attempts = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      input.signal.throwIfAborted();
      attempts = attempt;
      emit("review.stage_started", { stageId, attempt });
      try {
        const output = await input.runStage({ stageId, attempt, instructions, context });
        const comments = countComments(output);
        const durationMs = now() - startedAt;
        emit("review.stage_completed", { stageId, comments, durationMs });
        return { output, errors, record: { id: stageId, attempts, comments, durationMs, failed: false } };
      } catch (err) {
        if (input.signal.aborted) throw err;
        errors.push(errorMessage(err));
        emit("review.stage_failed", { stageId, attempt, error: errorMessage(err) });
      }
    }
    return {
      output: undefined,
      errors,
      record: { id: stageId, attempts, comments: 0, durationMs: now() - startedAt, failed: true },
    };
  };

  const candidatesOf = new Map<DeepStageId, InlineReviewComment[]>();
  const runFindingStage = (stageId: DeepStageId, instructions: string): Promise<StageRun & { record: DeepStageRecord }> =>
    runStage(stageId, instructions, "finding", (output) => {
      const candidates = input.selectCandidates(output.result.comments);
      candidatesOf.set(stageId, candidates);
      return candidates.length;
    });

  const intentLayer = ONION_LAYERS[0];
  if (intentLayer === undefined) throw new Error("Deep review has no intent stage");
  const intent = await runFindingStage("intent", intentLayer.instructions);
  records.push(intent.record);
  const intentComments = candidatesOf.get("intent") ?? [];

  // allSettled: every specialist ends, and cleans up, before an abort propagates.
  const specialists = await Promise.allSettled(PANEL_SPECIALISTS.map((specialist) =>
    runFindingStage(specialist.id, withOuterNotes(specialist.instructions, intentComments))));
  const findingRuns: Array<{ id: DeepStageId; run: StageRun }> = [{ id: "intent", run: intent }];
  for (const settled of specialists) {
    if (settled.status === "rejected") throw settled.reason;
    records.push(settled.value.record);
    findingRuns.push({ id: settled.value.record.id, run: settled.value });
  }
  input.signal.throwIfAborted();

  if (findingRuns.every(({ run }) => run.output === undefined)) {
    const details = findingRuns.map(({ id, run }) => `${id}: ${run.errors.at(-1) ?? "failed"}`).join("; ");
    throw new Error(`Deep review failed: every finding stage failed (${details})`);
  }

  const candidates = mergeCandidates(findingRuns.map(({ id }) => candidatesOf.get(id) ?? []));

  await input.beforeRank?.();
  const rank = await runStage("rank", rankerInstructions(candidates), "full", (output) => output.result.comments.length);
  records.push(rank.record);
  if (rank.output === undefined) {
    throw new Error(`Deep review final stage failed: ${rank.errors.at(-1) ?? "unknown error"}`);
  }
  return rank.output;
}
