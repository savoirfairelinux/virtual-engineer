import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeExternalChangeId } from "../../src/interfaces.js";
import type { InlineReviewComment } from "../../src/interfaces.js";

// ─── GerritSshClient mock ─────────────────────────────────────────────────────

const mockQuery = vi.fn(async (_args: string[]) => "");
const mockReviewJson = vi.fn(async (_changeSpec: string, _input: string) => {
  return;
});
const mockGetDiscussionComments = vi.fn(
  async (_changeId: string): Promise<import("../../src/connectors/gerritSshClient.js").GerritDiscussionComment[]> => []
);

vi.mock("../../src/connectors/gerritSshClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/connectors/gerritSshClient.js")>();
  return {
    ...actual,
    GerritSshClient: vi.fn().mockImplementation(function () {
      return {
        query: mockQuery,
        reviewJson: mockReviewJson,
        getDiscussionComments: mockGetDiscussionComments,
      };
    }),
  };
});

// ─── Git (execFile) mock — covers git init/remote/fetch/checkout/diff ─────────

const gitFileCalls: Array<{ args: string[]; opts: Record<string, unknown> }> = [];
let gitFileResults: Array<{ stdout: string; stderr: string } | Error> = [];
let gitFileCallIndex = 0;

vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      args: string[],
      opts: Record<string, unknown>,
      callback: (err: Error | null, result: { stdout: string; stderr: string }) => void
    ) => {
      gitFileCalls.push({ args, opts });
      const result = gitFileResults[gitFileCallIndex];
      gitFileCallIndex++;
      if (result instanceof Error) {
        callback(result, { stdout: "", stderr: "" });
      } else {
        callback(null, result ?? { stdout: "", stderr: "" });
      }
    }
  ),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  mkdtemp: vi.fn().mockResolvedValue("/tmp/test-diffs/diff-42-abc"),
  rm: vi.fn().mockReturnValue(Promise.resolve(undefined)),
}));

import {
  GerritSshReviewProvider,
  type GerritSshReviewProviderConfig,
} from "../../src/connectors/gerritSshReviewProvider.js";
import { rm } from "node:fs/promises";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SSH_HOST = "gerrit.test";
const SSH_PORT = 29418;
const SSH_USER = "ve-bot";
const REVIEWER_ACCOUNT_ID = "948";
const CHANGE_ID = makeExternalChangeId(
  "jami-client-qt~master~I8473b95934b5732ac55d26311a706c9c2bde9940"
);

function makeProvider(overrides: Partial<GerritSshReviewProviderConfig> = {}): GerritSshReviewProvider {
  return new GerritSshReviewProvider({
    sshHost: SSH_HOST,
    sshPort: SSH_PORT,
    sshUser: SSH_USER,
    reviewerAccountId: REVIEWER_ACCOUNT_ID,
    workspaceBaseDir: "/tmp/test-diffs",
    ...overrides,
  });
}

function sshNdjson(...objects: unknown[]): string {
  return [
    ...objects.map((o) => JSON.stringify(o)),
    JSON.stringify({ type: "stats", rowCount: objects.length }),
  ].join("\n");
}

function setGitResults(results: Array<string | Error>): void {
  gitFileResults = results.map((r) =>
    r instanceof Error ? r : { stdout: r, stderr: "" }
  );
}

const SAMPLE_CHANGE = {
  id: "jami-client-qt~master~I8473b95934b5732ac55d26311a706c9c2bde9940",
  number: 42,
  project: "jami-client-qt",
  branch: "master",
  subject: "Add feature X",
  commitMessage: "Add feature X\n\nThis is the commit body.\n\nChange-Id: I8473b95934b5732ac55d26311a706c9c2bde9940\n",
  status: "NEW",
  url: "https://gerrit.test/c/42",
  owner: { name: "Alice", email: "alice@test.com", username: "alice" },
  currentPatchSet: {
    number: 3,
    revision: "abc123def",
    ref: "refs/changes/42/42/3",
  },
  lastUpdated: Math.floor(Date.now() / 1000),
};

const SAMPLE_DETAILS = {
  changeId: CHANGE_ID,
  changeNumber: 42,
  subject: "Add feature X",
  description: "This is the commit body.",
  ownerAccountId: "42",
  currentPatchset: 3,
  status: "OPEN" as const,
  project: "jami-client-qt",
  targetBranch: "master",
  url: "https://gerrit.test/c/42",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GerritSshReviewProvider", () => {
  beforeEach(() => {
    gitFileCalls.length = 0;
    gitFileResults = [];
    gitFileCallIndex = 0;
    mockQuery.mockReset();
    mockReviewJson.mockReset();
    mockGetDiscussionComments.mockReset();
    mockGetDiscussionComments.mockResolvedValue([]);
    vi.mocked(rm).mockReturnValue(Promise.resolve(undefined) as unknown as ReturnType<typeof rm>);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("kind", () => {
    it("identifies as 'gerrit'", () => {
      expect(makeProvider().kind).toBe("gerrit");
    });
  });

  describe("getChangeDetails", () => {
    it("returns structured change details", async () => {
      mockQuery.mockResolvedValueOnce(sshNdjson(SAMPLE_CHANGE));

      const details = await makeProvider().getChangeDetails(CHANGE_ID);

      expect(details.changeNumber).toBe(42);
      expect(details.subject).toBe("Add feature X");
      expect(details.description).toBe("This is the commit body.\n\nChange-Id: I8473b95934b5732ac55d26311a706c9c2bde9940");
      expect(details.currentPatchset).toBe(3);
      expect(details.status).toBe("OPEN");
      expect(details.project).toBe("jami-client-qt");
    });

    it("uses empty description when commitMessage has no body", async () => {
      const changeWithoutBody = { ...SAMPLE_CHANGE, commitMessage: "Add feature X\n" };
      mockQuery.mockResolvedValueOnce(sshNdjson(changeWithoutBody));

      const details = await makeProvider().getChangeDetails(CHANGE_ID);
      expect(details.description).toBe("");
    });

    it("uses empty description when commitMessage is absent", async () => {
      const changeWithoutMsg = { ...SAMPLE_CHANGE, commitMessage: undefined };
      mockQuery.mockResolvedValueOnce(sshNdjson(changeWithoutMsg));

      const details = await makeProvider().getChangeDetails(CHANGE_ID);
      expect(details.description).toBe("");
    });

    it("throws when change is not found", async () => {
      mockQuery.mockResolvedValueOnce(sshNdjson());
      await expect(makeProvider().getChangeDetails(CHANGE_ID)).rejects.toThrow(/change not found/);
    });
  });

  describe("hasReviewedCurrentPatchset", () => {
    it("returns true when VE's SSH username has an approval on the current patch set", async () => {
      const change = {
        ...SAMPLE_CHANGE,
        currentPatchSet: {
          ...SAMPLE_CHANGE.currentPatchSet,
          approvals: [
            { type: "Code-Review", value: "-1", by: { username: SSH_USER, email: "ve-bot@test.com" } },
          ],
        },
      };
      mockQuery.mockResolvedValueOnce(sshNdjson(change));

      expect(await makeProvider().hasReviewedCurrentPatchset(CHANGE_ID)).toBe(true);
    });

    it("returns false when only other reviewers have voted on the current patch set", async () => {
      const change = {
        ...SAMPLE_CHANGE,
        currentPatchSet: {
          ...SAMPLE_CHANGE.currentPatchSet,
          approvals: [
            { type: "Code-Review", value: "+2", by: { username: "someone-else", email: "other@test.com" } },
          ],
        },
      };
      mockQuery.mockResolvedValueOnce(sshNdjson(change));

      expect(await makeProvider().hasReviewedCurrentPatchset(CHANGE_ID)).toBe(false);
    });

    it("returns false when the current patch set has no approvals", async () => {
      mockQuery.mockResolvedValueOnce(sshNdjson(SAMPLE_CHANGE));
      expect(await makeProvider().hasReviewedCurrentPatchset(CHANGE_ID)).toBe(false);
    });

    it("returns false when the SSH query fails", async () => {
      mockQuery.mockRejectedValueOnce(new Error("ssh timeout"));
      expect(await makeProvider().hasReviewedCurrentPatchset(CHANGE_ID)).toBe(false);
    });
  });

  describe("getChangeDiff", () => {
    const DIFF_OUTPUT = [
      "diff --git a/src/main.ts b/src/main.ts",
      "--- a/src/main.ts",
      "+++ b/src/main.ts",
      "@@ -1,3 +1,4 @@",
      " import { foo } from './foo';",
      "+import { bar } from './bar';",
      " ",
      " console.log(foo);",
    ].join("\n");

    it("clones via SSH and computes diff", async () => {
      // getChangeDetails via GerritSshClient.query; git operations via execFile
      mockQuery.mockResolvedValueOnce(sshNdjson(SAMPLE_CHANGE));
      setGitResults(["", "", "", "", DIFF_OUTPUT]); // git init, remote add, fetch, checkout, diff

      const result = await makeProvider().getChangeDiff(CHANGE_ID);

      expect(result.changeId).toBe(CHANGE_ID);
      expect(result.patchset).toBe(3);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.path).toBe("src/main.ts");
      expect(result.files[0]!.status).toBe("modified");
      expect(result.files[0]!.patch).toContain("+import { bar }");
    });

    it("detects added files", async () => {
      const diff = [
        "diff --git a/newfile.ts b/newfile.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/newfile.ts",
        "@@ -0,0 +1 @@",
        "+console.log('hello');",
      ].join("\n");
      mockQuery.mockResolvedValueOnce(sshNdjson(SAMPLE_CHANGE));
      setGitResults(["", "", "", "", diff]);

      const result = await makeProvider().getChangeDiff(CHANGE_ID);
      expect(result.files[0]!.status).toBe("added");
    });

    it("detects deleted files", async () => {
      const diff = [
        "diff --git a/old.ts b/old.ts",
        "deleted file mode 100644",
        "--- a/old.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-console.log('bye');",
      ].join("\n");
      mockQuery.mockResolvedValueOnce(sshNdjson(SAMPLE_CHANGE));
      setGitResults(["", "", "", "", diff]);

      const result = await makeProvider().getChangeDiff(CHANGE_ID);
      expect(result.files[0]!.status).toBe("deleted");
    });

    it("cleans up temp directory on error", async () => {
      mockQuery.mockResolvedValueOnce(sshNdjson(SAMPLE_CHANGE));
      setGitResults([new Error("git init failed")]);

      await expect(makeProvider().getChangeDiff(CHANGE_ID)).rejects.toThrow("git init failed");
      expect(rm).toHaveBeenCalledWith("/tmp/test-diffs/diff-42-abc", { recursive: true, force: true });
    });
  });

  describe("getInterPatchsetDiff", () => {
    const DELTA_OUTPUT = [
      "diff --git a/src/main.ts b/src/main.ts",
      "--- a/src/main.ts",
      "+++ b/src/main.ts",
      "@@ -1,3 +1,4 @@",
      " import { foo } from './foo';",
      "+import { baz } from './baz';",
      " ",
      " console.log(foo);",
    ].join("\n");

    it("fetches both patchset refs and diffs their tips", async () => {
      // init, remote add, fetch(from), rev-parse(from), fetch(to), rev-parse(to), diff
      setGitResults(["", "", "", "shaFrom\n", "", "shaTo\n", DELTA_OUTPUT]);

      const result = await makeProvider().getInterPatchsetDiff(SAMPLE_DETAILS, 2, 3);

      expect(result.changeId).toBe(CHANGE_ID);
      expect(result.patchset).toBe(3);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.path).toBe("src/main.ts");
      expect(result.files[0]!.patch).toContain("+import { baz }");

      // Verify it fetched the from-ref, the to-ref, then diffed the resolved SHAs.
      const fetchArgs = gitFileCalls.filter((c) => c.args[0] === "fetch").map((c) => c.args);
      expect(fetchArgs).toHaveLength(2);
      expect(fetchArgs[0]).toContain("refs/changes/42/42/2");
      expect(fetchArgs[1]).toContain("refs/changes/42/42/3");
      const diffCall = gitFileCalls.find((c) => c.args[0] === "diff");
      expect(diffCall!.args).toContain("shaFrom..shaTo");
    });

    it("cleans up temp directory on error", async () => {
      setGitResults([new Error("git init failed")]);

      await expect(makeProvider().getInterPatchsetDiff(SAMPLE_DETAILS, 2, 3)).rejects.toThrow(
        "git init failed"
      );
      expect(rm).toHaveBeenCalledWith("/tmp/test-diffs/diff-42-abc", { recursive: true, force: true });
    });

    it("returns an empty file list when the two patchsets are identical (empty diff output)", async () => {
      // init, remote add, fetch(from), rev-parse(from), fetch(to), rev-parse(to), diff → empty
      setGitResults(["", "", "", "shaA\n", "", "shaA\n", ""]);

      const result = await makeProvider().getInterPatchsetDiff(SAMPLE_DETAILS, 3, 3);

      expect(result.patchset).toBe(3);
      expect(result.files).toHaveLength(0);
    });

    it("pads the two-digit shard correctly for a single-digit change number", async () => {
      setGitResults(["", "", "", "sha1\n", "", "sha2\n", ""]);

      await makeProvider().getInterPatchsetDiff({ ...SAMPLE_DETAILS, changeNumber: 7 }, 1, 2);

      const fetchRefs = gitFileCalls
        .filter((c) => c.args[0] === "fetch")
        .map((c) => c.args.find((a) => a.startsWith("refs/changes/")));
      expect(fetchRefs[0]).toBe("refs/changes/07/7/1");
      expect(fetchRefs[1]).toBe("refs/changes/07/7/2");
    });
  });

  describe("postReviewWithComments", () => {
    it("posts review via SSH gerrit review --json", async () => {
      mockQuery.mockResolvedValueOnce(sshNdjson(SAMPLE_CHANGE));
      mockReviewJson.mockResolvedValueOnce(undefined);

      const comments: InlineReviewComment[] = [
        { file: "src/main.ts", line: 10, message: "Use const here", severity: "warning" },
        { file: "src/main.ts", line: 20, message: "Consider refactoring", severity: "suggestion" },
      ];

      await makeProvider().postReviewWithComments(CHANGE_ID, 3, comments, "Overall looks good", 1);

      expect(mockReviewJson).toHaveBeenCalledOnce();
      const callArgs = mockReviewJson.mock.calls[0] as [string, string] | undefined;
      const changeSpec = callArgs?.[0];
      const rawInput = callArgs?.[1] ?? "{}";
      expect(changeSpec).toBe("42,3");

      const input = JSON.parse(rawInput) as Record<string, unknown>;
      expect(input["labels"]).toEqual({ "Code-Review": 1 });
      expect(input["message"]).toBe("Overall looks good");
      const fileComments = (input["comments"] as Record<string, unknown[]>)["src/main.ts"]!;
      expect(fileComments).toHaveLength(2);
      expect((fileComments[0] as Record<string, unknown>)["message"]).toBe("[warning] Line 10: Use const here");
      expect((fileComments[1] as Record<string, unknown>)["message"]).toBe("Line 20: Consider refactoring");
    });
  });

  describe("postReviewComments", () => {
    it("skips when no comments and no summary", async () => {
      await makeProvider().postReviewComments(CHANGE_ID, 3, [], "");
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockReviewJson).not.toHaveBeenCalled();
    });

    it("posts summary-only review", async () => {
      mockQuery.mockResolvedValueOnce(sshNdjson(SAMPLE_CHANGE));
      mockReviewJson.mockResolvedValueOnce(undefined);

      await makeProvider().postReviewComments(CHANGE_ID, 3, [], "LGTM");

      expect(mockReviewJson).toHaveBeenCalledOnce();
      const input = JSON.parse(mockReviewJson.mock.calls[0]![1]) as Record<string, unknown>;
      expect(input["message"]).toBe("LGTM");
      expect(input["comments"]).toBeUndefined();
    });
  });

  describe("allowedFiles filtering", () => {
    it("drops comments whose file is not in allowedFiles, keeps the rest", async () => {
      mockQuery.mockResolvedValueOnce(sshNdjson(SAMPLE_CHANGE));
      mockReviewJson.mockResolvedValueOnce(undefined);

      const comments: InlineReviewComment[] = [
        { file: "src/vkms.c", line: 12, message: "ok", severity: "warning" },
        { file: "src/main.c", line: 5, message: "hallucinated path", severity: "error" },
      ];
      const allowed = new Set(["src/vkms.c"]);

      await makeProvider().postReviewWithComments(CHANGE_ID, 3, comments, "summary", -1, allowed);

      const input = JSON.parse(mockReviewJson.mock.calls[0]![1]) as Record<string, unknown>;
      const grouped = input["comments"] as Record<string, unknown[]>;
      expect(Object.keys(grouped)).toEqual(["src/vkms.c"]);
      expect(grouped["src/main.c"]).toBeUndefined();
    });

    it("still submits vote+summary when ALL comments are filtered out", async () => {
      mockQuery.mockResolvedValueOnce(sshNdjson(SAMPLE_CHANGE));
      mockReviewJson.mockResolvedValueOnce(undefined);

      const comments: InlineReviewComment[] = [
        { file: "ghost.c", line: 1, message: "nope", severity: "error" },
      ];

      await makeProvider().postReviewWithComments(CHANGE_ID, 3, comments, "still summary", -1, new Set(["real.c"]));

      expect(mockReviewJson).toHaveBeenCalledOnce();
      const input = JSON.parse(mockReviewJson.mock.calls[0]![1]) as Record<string, unknown>;
      expect(input["labels"]).toEqual({ "Code-Review": -1 });
      expect(input["message"]).toBe("still summary");
      expect(input["comments"]).toBeUndefined();
    });

    it("postReviewComments: skips SSH call when all comments filtered and summary empty", async () => {
      await makeProvider().postReviewComments(
        CHANGE_ID,
        3,
        [{ file: "ghost.c", line: 1, message: "x", severity: "error" }],
        "",
        new Set(["real.c"])
      );
      expect(mockReviewJson).not.toHaveBeenCalled();
    });

    it("undefined allowedFiles preserves legacy behaviour (no filtering)", async () => {
      mockQuery.mockResolvedValueOnce(sshNdjson(SAMPLE_CHANGE));
      mockReviewJson.mockResolvedValueOnce(undefined);

      const comments: InlineReviewComment[] = [
        { file: "any/path.ts", line: 1, message: "kept", severity: "warning" },
      ];
      await makeProvider().postReviewWithComments(CHANGE_ID, 3, comments, "", 1);

      const input = JSON.parse(mockReviewJson.mock.calls[0]![1]) as Record<string, unknown>;
      const grouped = input["comments"] as Record<string, unknown[]>;
      expect(grouped["any/path.ts"]).toBeDefined();
    });
  });

  describe("vote", () => {
    it("submits a Code-Review vote via SSH", async () => {
      mockQuery.mockResolvedValueOnce(sshNdjson(SAMPLE_CHANGE));
      mockReviewJson.mockResolvedValueOnce(undefined);

      await makeProvider().vote(CHANGE_ID, 3, -1, "Needs work");

      expect(mockReviewJson).toHaveBeenCalledOnce();
      const input = JSON.parse(mockReviewJson.mock.calls[0]![1]) as Record<string, unknown>;
      expect(input["labels"]).toEqual({ "Code-Review": -1 });
      expect(input["message"]).toBe("Needs work");
    });
  });

  describe("discussion threads", () => {
    it("getDiscussionThreads groups comments by file:line and change-level", async () => {
      mockGetDiscussionComments.mockResolvedValueOnce([
        {
          author: "alice",
          isOwn: false,
          message: "Inline question?",
          file: "src/a.ts",
          line: 5,
          patchSet: 3,
          timestampMs: 1000,
        },
        {
          author: "ve-bot",
          isOwn: true,
          message: "Inline answer.",
          file: "src/a.ts",
          line: 5,
          patchSet: 3,
          timestampMs: 2000,
        },
        {
          author: "bob",
          isOwn: false,
          message: "Change-level note.",
          file: null,
          line: null,
          patchSet: 3,
          timestampMs: 1500,
        },
      ]);

      const threads = await makeProvider().getDiscussionThreads(CHANGE_ID);

      expect(threads).toHaveLength(2);
      const inline = threads.find((t) => t.threadId === "gerrit-line:src/a.ts:5");
      expect(inline?.file).toBe("src/a.ts");
      expect(inline?.line).toBe(5);
      expect(inline?.resolved).toBe(false);
      // Sorted by timestamp ascending.
      expect(inline?.comments.map((c) => c.message)).toEqual(["Inline question?", "Inline answer."]);
      expect(inline?.comments[1]?.isOwn).toBe(true);

      const change = threads.find((t) => t.threadId === "gerrit-change");
      expect(change?.file).toBeNull();
      expect(change?.comments[0]?.author).toBe("bob");
    });

    it("postThreadReply posts a change message for the change-level thread", async () => {
      mockQuery.mockResolvedValueOnce(sshNdjson(SAMPLE_CHANGE));
      mockReviewJson.mockResolvedValueOnce(undefined);

      await makeProvider().postThreadReply(CHANGE_ID, 3, "gerrit-change", "Thanks for the note.");

      const input = JSON.parse(mockReviewJson.mock.calls[0]![1]) as Record<string, unknown>;
      expect(input["message"]).toBe("Thanks for the note.");
      expect(input["comments"]).toBeUndefined();
    });

    it("postThreadReply posts an inline comment for a file:line thread", async () => {
      mockQuery.mockResolvedValueOnce(sshNdjson(SAMPLE_CHANGE));
      mockReviewJson.mockResolvedValueOnce(undefined);

      await makeProvider().postThreadReply(CHANGE_ID, 3, "gerrit-line:src/a.ts:5", "Inline reply.");

      const input = JSON.parse(mockReviewJson.mock.calls[0]![1]) as Record<string, unknown>;
      const grouped = input["comments"] as Record<string, Array<{ line: number; message: string }>>;
      expect(grouped["src/a.ts"]).toEqual([{ line: 5, message: "Inline reply.", unresolved: false }]);
      expect(input["message"]).toBeUndefined();
    });
  });
});
