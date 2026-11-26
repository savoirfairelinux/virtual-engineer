import { describe, expect, it } from "vitest";
import { runDeepReview, type DeepStageOutput, type DeepStageRecord, type DeepStageRequest } from "../../src/review/deepReview.js";
import { ONION_LAYERS, PANEL_SPECIALISTS, rankerInstructions, renderFindings, withOuterNotes } from "../../src/review/deepReviewPrompts.js";
import type { InlineReviewComment } from "../../src/interfaces.js";

const comment = (file: string, line: number, message: string, severity = "warning"): InlineReviewComment =>
  ({ file, line, message, severity });

function output(comments: InlineReviewComment[] = [], summary = ""): DeepStageOutput {
  return { rawOutput: JSON.stringify({ summary }), result: { comments, summary, score: 0, replies: [] } };
}

function pipeline(
  stage: (request: DeepStageRequest) => Promise<DeepStageOutput>,
  extra: { signal?: AbortSignal; records?: DeepStageRecord[] } = {},
): { calls: DeepStageRequest[]; run: Promise<DeepStageOutput> } {
  const calls: DeepStageRequest[] = [];
  const run = runDeepReview({
    signal: extra.signal ?? new AbortController().signal,
    runStage: async (request) => {
      calls.push(request);
      return stage(request);
    },
    selectCandidates: (comments) => comments.filter((c) => c.severity !== "nit"),
    records: extra.records,
  });
  return { calls, run };
}

describe("deep review stage prompts", () => {
  it("keep the measured stage texts", () => {
    expect(ONION_LAYERS.map((layer) => layer.id)).toEqual(["intent"]);
    expect(PANEL_SPECIALISTS.map((specialist) => specialist.id)).toEqual(["logic", "state", "contracts", "maintainability"]);
    expect(ONION_LAYERS[0]?.instructions).toMatch(/^# Review Workflow\n\n- Inspect enough surrounding code/);
    expect(ONION_LAYERS[0]?.instructions).toContain("## Scope of this pass: intent and scope");
    expect(PANEL_SPECIALISTS[3]?.instructions).toContain("Give convention findings severity `info`, or `nit` when purely cosmetic.");
    expect(rankerInstructions([])).toContain("# Consolidation Workflow");
    expect(rankerInstructions([])).toMatch(/## Candidate findings\n\n\(none\)$/);
    expect(withOuterNotes("base", [])).toBe("base");
  });
});

describe("runDeepReview", () => {
  it("runs intent, then the specialists with the intent notes, then the final stage", async () => {
    const intentNote = comment("a.c", 3, "does more than the message says");
    const records: DeepStageRecord[] = [];
    const { calls, run } = pipeline(async (request) => {
      if (request.stageId === "intent") return output([intentNote]);
      if (request.stageId === "logic") return output([comment("a.c", 9, "off by one"), comment("a.c", 1, "cosmetic", "nit")]);
      if (request.stageId === "state") return output([comment("a.c", 9, "off by one"), comment("b.c", 2, "leak")]);
      if (request.stageId === "rank") return output([comment("a.c", 9, "ranked")], "final");
      return output();
    }, { records });

    const result = await run;

    expect(calls.map((call) => call.stageId)).toEqual(["intent", "logic", "state", "contracts", "maintainability", "rank"]);
    expect(calls.map((call) => call.context)).toEqual(["finding", "finding", "finding", "finding", "finding", "full"]);
    for (const [index, specialist] of PANEL_SPECIALISTS.entries()) {
      expect(calls[index + 1]?.instructions).toBe(withOuterNotes(specialist.instructions, [intentNote]));
    }
    // Stage order, exact repeats dropped, and filtered comments never reach the final stage.
    expect(calls[5]?.instructions).toBe(rankerInstructions([intentNote, comment("a.c", 9, "off by one"), comment("b.c", 2, "leak")]));
    expect(calls[5]?.instructions).toContain(renderFindings([intentNote], 1200));
    expect(result.result.summary).toBe("final");
    expect(records.map((record) => [record.id, record.comments, record.failed])).toEqual([
      ["intent", 1, false], ["logic", 1, false], ["state", 2, false], ["contracts", 0, false],
      ["maintainability", 0, false], ["rank", 1, false],
    ]);
  });

  it("runs the final stage with zero candidates", async () => {
    const { calls, run } = pipeline(async (request) => output([], request.stageId === "rank" ? "clean" : ""));
    expect((await run).result.summary).toBe("clean");
    expect(calls.at(-1)?.instructions).toBe(rankerInstructions([]));
  });

  it("retries once, then degrades: intent failure drops the notes and a failed specialist is skipped", async () => {
    const records: DeepStageRecord[] = [];
    const { calls, run } = pipeline(async (request) => {
      if (request.stageId === "intent" || request.stageId === "state") throw new Error(`${request.stageId} broke`);
      if (request.stageId === "logic" && request.attempt === 1) throw new Error("transient");
      return output(request.stageId === "logic" ? [comment("a.c", 1, "found")] : []);
    }, { records });

    await run;

    expect(calls.filter((call) => call.stageId === "intent").map((call) => call.attempt)).toEqual([1, 2]);
    expect(calls.filter((call) => call.stageId === "logic").map((call) => call.attempt)).toEqual([1, 2]);
    expect(calls.find((call) => call.stageId === "contracts")?.instructions).toBe(PANEL_SPECIALISTS[2]?.instructions);
    expect(calls.at(-1)?.instructions).toBe(rankerInstructions([comment("a.c", 1, "found")]));
    expect(records.find((record) => record.id === "state")).toMatchObject({ attempts: 2, failed: true });
    expect(records.find((record) => record.id === "logic")).toMatchObject({ attempts: 2, failed: false });
  });

  it("fails the pass when every finding stage fails or the final stage fails", async () => {
    const allFail = pipeline(async (request) => {
      if (request.stageId === "rank") return output();
      throw new Error(`${request.stageId} down`);
    });
    await expect(allFail.run).rejects.toThrow(/every finding stage failed \(intent: intent down; logic: logic down/);
    expect(allFail.calls.some((call) => call.stageId === "rank")).toBe(false);

    const rankFails = pipeline(async (request) => {
      if (request.stageId === "rank") throw new Error("rank down");
      return output();
    });
    await expect(rankFails.run).rejects.toThrow(/final stage failed: rank down/);
    expect(rankFails.calls.filter((call) => call.stageId === "rank")).toHaveLength(2);
  });

  it("never retries an aborted stage and waits for running specialists before failing", async () => {
    const controller = new AbortController();
    const settled: string[] = [];
    const { calls, run } = pipeline(async (request) => {
      if (request.stageId === "intent") return output();
      if (request.stageId === "logic") {
        await new Promise((resolve) => setTimeout(resolve, 1));
        controller.abort(new Error("cancelled"));
        throw new Error("aborted mid-run");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      settled.push(request.stageId);
      throw new Error("aborted too");
    }, { signal: controller.signal });

    await expect(run).rejects.toThrow(/aborted mid-run/);
    expect(calls.filter((call) => call.stageId === "logic")).toHaveLength(1);
    expect(calls.some((call) => call.stageId === "rank")).toBe(false);
    expect(settled.sort()).toEqual(["contracts", "maintainability", "state"]);
  });
});
