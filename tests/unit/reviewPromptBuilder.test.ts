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
      instructionsPrompt: "Review this.",
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
      instructionsPrompt: "Review this.",
    });
    expect(prompt).toMatch(/MODIFIED.*src\/foo\.ts/);
    expect(prompt).toMatch(/ADDED.*src\/bar\.ts/);
    expect(prompt).toContain("```diff");
    expect(prompt).toContain("+new");
    expect(prompt).toContain("+hello");
  });

  it("includes review instructions in the dynamic user prompt", () => {
    const prompt = buildReviewPrompt({
      details,
      diff,
      instructionsPrompt: "Review this.",
    });
    expect(prompt).not.toContain("## System Prompt");
    expect(prompt).toContain("## Review Instructions");
    expect(prompt).toContain("Review this.");
  });

  it("includes instructions when provided", () => {
    const prompt = buildReviewPrompt({
      details,
      diff,
      instructionsPrompt: "act as a senior software engineer",
    });
    expect(prompt).toContain("senior software engineer");
  });

  it("substitutes custom instructions when provided", () => {
    const prompt = buildReviewPrompt({
      details,
      diff,
      instructionsPrompt: "Focus exclusively on security issues.",
    });
    expect(prompt).toContain("Focus exclusively on security issues.");
  });

  it("includes every file in a diff larger than the former 60,000-character limit", () => {
    const large: ReviewChangeDiff = {
      changeId: CHANGE_ID,
      patchset: 1,
      files: Array.from({ length: 5 }, (_, i) => ({
        path: `src/big-${i}.ts`,
        status: "modified" as const,
        patch: `+unique-${i}\n` + "+x\n".repeat(20_000),
      })),
    };
    const prompt = buildReviewPrompt({
      details,
      diff: large,
      instructionsPrompt: "Review this.",
    });
    for (const file of large.files) {
      expect(prompt).toContain(`### ${file.path} (${file.status})`);
      expect(prompt).toContain(file.patch);
    }
    expect(prompt).not.toContain("diff truncated");
  });

  it("omits the prior-comments section when none are provided", () => {
    const prompt = buildReviewPrompt({
      details,
      diff,
      instructionsPrompt: "Review this.",
    });
    expect(prompt).not.toContain("Already reported");
  });

  it("omits the prior-comments section when the list is empty", () => {
    const prompt = buildReviewPrompt({
      details,
      diff,
      instructionsPrompt: "Review this.",
      priorComments: [],
    });
    expect(prompt).not.toContain("Already reported");
  });

  it("injects previously-posted comments as do-not-repeat memory", () => {
    const prompt = buildReviewPrompt({
      details,
      diff,
      instructionsPrompt: "Review this.",
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

  it("asks hosted reviews to reassess numbered active findings", () => {
    const prompt = buildReviewPrompt({
      details,
      diff,
      instructionsPrompt: "Review this.",
      reassessPriorFindings: true,
      priorComments: [
        { id: 17, file: "src/foo.ts", line: 12, message: "Null check missing here." },
      ],
    });
    expect(prompt).toContain("## Previous findings to reassess");
    expect(prompt).toContain("findingId: 17");
    expect(prompt).toContain("still_present, fixed, or uncertain");
    expect(prompt).not.toContain("## Already reported (do not repeat)");
  });
});

describe("buildReviewPrompt commit message", () => {
  it("renders the commit message body when the description is non-empty", () => {
    const prompt = buildReviewPrompt({
      details: { ...details, description: "Implements rate limiting.\n\nCloses #42." },
      diff,
      instructionsPrompt: "Review this.",
    });
    expect(prompt).toContain("## Commit message");
    expect(prompt).toContain("Implements rate limiting.");
    expect(prompt).toContain("Closes #42.");
  });

  it("truncates very large commit message bodies", () => {
    const prompt = buildReviewPrompt({
      details: { ...details, description: "x".repeat(9_000) },
      diff,
      instructionsPrompt: "Review this.",
    });
    expect(prompt).toContain("## Commit message");
    expect(prompt).toContain("commit message truncated");
    expect(prompt).not.toContain("x".repeat(8_500));
    const commitMessageSection = prompt.split("\n## Review Instructions")[0]!.split("## Commit message\n")[1]!.trimEnd();
    expect(commitMessageSection.length).toBeLessThanOrEqual(8_000);
  });

  it("omits the commit message section when the description is empty", () => {
    const prompt = buildReviewPrompt({
      details: { ...details, description: "" },
      diff,
      instructionsPrompt: "Review this.",
    });
    expect(prompt).not.toContain("## Commit message");
  });

  it("omits the commit message section when the description is whitespace only", () => {
    const prompt = buildReviewPrompt({
      details: { ...details, description: "   \n  \n" },
      diff,
      instructionsPrompt: "Review this.",
    });
    expect(prompt).not.toContain("## Commit message");
  });
});

describe("buildReviewPrompt discussion threads", () => {
  it("omits the open-threads section when none are provided", () => {
    const prompt = buildReviewPrompt({ details, diff, instructionsPrompt: "Review this." });
    expect(prompt).not.toContain("## Open discussion threads");
  });

  it("omits the open-threads section when the list is empty", () => {
    const prompt = buildReviewPrompt({
      details,
      diff,
      instructionsPrompt: "Review this.",
      discussionThreads: [],
    });
    expect(prompt).not.toContain("## Open discussion threads");
  });

  it("renders open threads with anchors, threadIds and (you) tags", () => {
    const prompt = buildReviewPrompt({
      details,
      diff,
      instructionsPrompt: "Review this.",
      discussionThreads: [
        {
          threadId: "disc-1",
          file: "src/foo.ts",
          line: 10,
          resolved: false,
          comments: [
            { author: "alice", message: "Why not use a Map here?", isOwn: false },
            { author: "ve-bot", message: "Because order matters.", isOwn: true },
          ],
        },
        {
          threadId: "gerrit-change",
          file: null,
          line: null,
          resolved: false,
          comments: [{ author: "bob", message: "Overall LGTM.", isOwn: false }],
        },
      ],
    });
    expect(prompt).toContain("## Open discussion threads (respond where relevant)");
    expect(prompt).toContain("- threadId: disc-1  [src/foo.ts:10]");
    expect(prompt).toContain("alice: Why not use a Map here?");
    expect(prompt).toContain("ve-bot (you): Because order matters.");
    expect(prompt).toContain("- threadId: gerrit-change  [(change-level)]");
    expect(prompt).toContain("bob: Overall LGTM.");
  });
});

describe("buildReviewPrompt since-last-review delta", () => {
  const deltaDiff: ReviewChangeDiff = {
    changeId: CHANGE_ID,
    patchset: 3,
    files: [
      {
        path: "src/foo.ts",
        status: "modified",
        patch: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-new\n+newer",
      },
    ],
  };

  it("omits the delta section when sinceLastReview is not provided", () => {
    const prompt = buildReviewPrompt({ details, diff, instructionsPrompt: "Review this." });
    expect(prompt).not.toContain("## Changes since last reviewed patchset");
  });

  it("omits the delta section when the delta has no files", () => {
    const prompt = buildReviewPrompt({
      details,
      diff,
      instructionsPrompt: "Review this.",
      sinceLastReview: { fromPatchset: 2, toPatchset: 3, diff: { ...deltaDiff, files: [] } },
    });
    expect(prompt).not.toContain("## Changes since last reviewed patchset");
  });

  it("renders the delta section with the PS range and the delta diff when provided", () => {
    const prompt = buildReviewPrompt({
      details,
      diff,
      instructionsPrompt: "Review this.",
      sinceLastReview: { fromPatchset: 2, toPatchset: 3, diff: deltaDiff },
    });
    expect(prompt).toContain("## Changes since last reviewed patchset (PS 2 → 3)");
    expect(prompt).toContain("+newer");
    // The full diff is still present alongside the delta.
    expect(prompt).toContain("## Unified diffs");
  });

  it("includes the complete delta and full diff on a re-review", () => {
    const hugeDeltaDiff: ReviewChangeDiff = {
      changeId: CHANGE_ID,
      patchset: 3,
      files: [{
        path: "src/delta-big.ts",
        status: "modified",
        patch: "+delta\n".repeat(20_000),
      }],
    };
    const hugeFullDiff: ReviewChangeDiff = {
      ...diff,
      files: [{
        path: "src/full-big.ts",
        status: "modified",
        patch: "+full\n".repeat(20_000),
      }],
    };
    const prompt = buildReviewPrompt({
      details,
      diff: hugeFullDiff,
      instructionsPrompt: "Review this.",
      sinceLastReview: { fromPatchset: 2, toPatchset: 3, diff: hugeDeltaDiff },
    });
    expect(prompt).toContain(hugeDeltaDiff.files[0]!.patch);
    expect(prompt).toContain(hugeFullDiff.files[0]!.patch);
    expect(prompt).not.toContain("diff truncated");
  });
});

describe("buildReviewPrompt — merge commits", () => {
  const mergeDiff: ReviewChangeDiff = {
    changeId: CHANGE_ID,
    patchset: 3,
    files: [{
      path: "kotlin/Server.kt",
      status: "deleted",
      patch: "remerge CONFLICT (modify/delete): kotlin/Server.kt\n-fun b() = 3 // fix",
    }],
    merge: {
      parents: ["1".repeat(40), "2".repeat(40)],
      mergedCommits: [{ sha: "3".repeat(40), subject: "Port the device server to Python" }],
      commentableFiles: ["kotlin/Server.kt", "README.md"],
    },
  };

  it("omits the merge section for a regular change", () => {
    const prompt = buildReviewPrompt({ details, diff, instructionsPrompt: "Review this." });
    expect(prompt).not.toContain("## Merge commit");
  });

  it("scopes the review to the automatic-merge diff and lists merged commits as already reviewed", () => {
    const prompt = buildReviewPrompt({ details, diff: mergeDiff, instructionsPrompt: "Review this." });

    expect(prompt).toContain("## Merge commit");
    expect(prompt).toContain("automatic merge");
    expect(prompt).toContain("1".repeat(12));
    expect(prompt).toContain(`- ${"3".repeat(12)} Port the device server to Python`);
    expect(prompt).toContain("already reviewed");
    expect(prompt).toContain("`kotlin/Server.kt`, `README.md`");
    expect(prompt).toContain("line 0");
    expect(prompt).toContain("-fun b() = 3 // fix");
    expect(prompt.indexOf("## Merge commit")).toBeLessThan(prompt.indexOf("## Files in this patchset"));
  });

  it("asks for summary-only findings when no file accepts inline comments", () => {
    const prompt = buildReviewPrompt({
      details,
      diff: { ...mergeDiff, merge: { ...mergeDiff.merge!, commentableFiles: [] } },
      instructionsPrompt: "Review this.",
    });
    expect(prompt).toContain("report every finding in the summary");
  });

  it("caps the merged-commit list with an explicit remainder", () => {
    const mergedCommits = Array.from({ length: 105 }, (_, i) => ({
      sha: String(i).padStart(40, "0"),
      subject: `merged commit ${i}`,
    }));
    const prompt = buildReviewPrompt({
      details,
      diff: { ...mergeDiff, merge: { ...mergeDiff.merge!, mergedCommits } },
      instructionsPrompt: "Review this.",
    });
    expect(prompt).toContain("merged commit 99\n");
    expect(prompt).not.toContain("merged commit 100");
    expect(prompt).toContain("… and 5 more merged commits");
  });
});
