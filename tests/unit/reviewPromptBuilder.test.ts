import { describe, it, expect } from "vitest";
import { buildReviewPrompt } from "../../src/review/reviewPromptBuilder.js";
import { makeExternalChangeId } from "../../src/interfaces.js";
import type {
  ReviewChangeDetails,
  ReviewChangeDiff,
} from "../../src/interfaces.js";

const CHANGE_ID = makeExternalChangeId("p~master~Iabc");

const details: ReviewChangeDetails = {
  changeId: CHANGE_ID,
  changeNumber: 12345,
  subject: "Add feature X",
  description: "Long description",
  ownerAccountId: "42",
  currentPatchset: 3,
  status: "OPEN",
  project: "my-project",
  targetBranch: "main",
  url: "http://gerrit.test/c/12345",
};

const diff: ReviewChangeDiff = {
  changeId: CHANGE_ID,
  patchset: 3,
  files: [
    {
      path: "src/foo.ts",
      status: "modified",
      patch: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new",
    },
    {
      path: "src/bar.ts",
      status: "added",
      patch: "--- /dev/null\n+++ b/src/bar.ts\n@@ +1 @@\n+hello",
    },
  ],
};

describe("buildReviewPrompt", () => {
  it("includes change metadata", () => {
    const prompt = buildReviewPrompt({
      details,
      diff,
      userPrompt: "Review this.",
    });
    expect(prompt).toContain("Project: my-project");
    expect(prompt).toContain("Branch:  main");
    expect(prompt).toContain("Subject: Add feature X");
    expect(prompt).toContain("patchset 3");
    expect(prompt).toContain("http://gerrit.test/c/12345");
  });

  it("lists all files and inlines their unified diffs", () => {
    const prompt = buildReviewPrompt({
      details,
      diff,
      userPrompt: "Review this.",
    });
    expect(prompt).toMatch(/MODIFIED.*src\/foo\.ts/);
    expect(prompt).toMatch(/ADDED.*src\/bar\.ts/);
    expect(prompt).toContain("```diff");
    expect(prompt).toContain("+new");
    expect(prompt).toContain("+hello");
  });

  it("includes user instructions section", () => {
    const prompt = buildReviewPrompt({
      details,
      diff,
      userPrompt: "Review this.",
    });
    expect(prompt).not.toContain("## System Prompt");
    expect(prompt).toContain("## User Instructions");
    expect(prompt).toContain("Review this.");
  });

  it("includes user prompt when provided", () => {
    const prompt = buildReviewPrompt({
      details,
      diff,
      userPrompt: "act as a senior software engineer",
    });
    expect(prompt).toContain("senior software engineer");
  });

  it("substitutes custom instructions when provided", () => {
    const prompt = buildReviewPrompt({
      details,
      diff,
      userPrompt: "Focus exclusively on security issues.",
    });
    expect(prompt).toContain("Focus exclusively on security issues.");
  });

  it("truncates the diff section once the budget is exhausted", () => {
    const huge: ReviewChangeDiff = {
      changeId: CHANGE_ID,
      patchset: 1,
      files: Array.from({ length: 5 }, (_, i) => ({
        path: `src/big-${i}.ts`,
        status: "modified" as const,
        patch: "+x\n".repeat(20_000),
      })),
    };
    const prompt = buildReviewPrompt({
      details,
      diff: huge,
      userPrompt: "Review this.",
    });
    expect(prompt).toContain("diff truncated");
  });

  it("omits the prior-comments section when none are provided", () => {
    const prompt = buildReviewPrompt({
      details,
      diff,
      userPrompt: "Review this.",
    });
    expect(prompt).not.toContain("Already reported");
  });

  it("omits the prior-comments section when the list is empty", () => {
    const prompt = buildReviewPrompt({
      details,
      diff,
      userPrompt: "Review this.",
      priorComments: [],
    });
    expect(prompt).not.toContain("Already reported");
  });

  it("injects previously-posted comments as do-not-repeat memory", () => {
    const prompt = buildReviewPrompt({
      details,
      diff,
      userPrompt: "Review this.",
      priorComments: [
        { file: "src/foo.ts", line: 12, message: "Null check missing here." },
        { file: "src/bar.ts", line: 3, message: "Use   const\ninstead." },
      ],
    });
    expect(prompt).toContain("## Already reported (do not repeat)");
    expect(prompt).toContain("src/foo.ts:12 — Null check missing here.");
    // Whitespace in the stored message is collapsed for a compact checklist.
    expect(prompt).toContain("src/bar.ts:3 — Use const instead.");
  });
});
