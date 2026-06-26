import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// ─── Mock state ───────────────────────────────────────────────────────────────

const execFileCalls: Array<{ args: string[]; opts: Record<string, unknown> }> = [];
let execFileResults: Array<{ stdout: string; stderr: string } | Error> = [];
let execFileCallIndex = 0;

const spawnCalls: Array<{ args: string[]; stdinData: string }> = [];
let spawnExitCode = 0;

vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      args: string[],
      opts: Record<string, unknown>,
      callback: (err: Error | null, result: { stdout: string; stderr: string }) => void
    ) => {
      execFileCalls.push({ args, opts });
      const result = execFileResults[execFileCallIndex];
      execFileCallIndex++;
      if (result instanceof Error) {
        callback(result, { stdout: "", stderr: "" });
      } else {
        callback(null, result ?? { stdout: "", stderr: "" });
      }
    }
  ),
  spawn: vi.fn((_cmd: string, args: string[]) => {
    const child = new EventEmitter() as ReturnType<typeof import("node:child_process").spawn>;
    const stdin = new PassThrough();
    let stdinData = "";
    stdin.on("data", (chunk: Buffer) => { stdinData += chunk.toString(); });
    Object.assign(child, {
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 12345,
      kill: vi.fn(),
    });
    process.nextTick(() => {
      child.emit("spawn");
      stdin.on("finish", () => {
        spawnCalls.push({ args, stdinData });
        child.emit("close", spawnExitCode);
      });
    });
    return child;
  }),
}));

import { GerritSshClient, parseSshNdjson } from "../../src/connectors/gerritSshClient.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sshNdjson(...objects: unknown[]): string {
  return [
    ...objects.map((o) => JSON.stringify(o)),
    JSON.stringify({ type: "stats", rowCount: objects.length }),
  ].join("\n");
}

const SSH_CONFIG = { host: "gerrit.test", port: 29418, user: "ve", keyPath: "/key" };

function makeClient(): GerritSshClient {
  return new GerritSshClient(SSH_CONFIG);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("parseSshNdjson", () => {
  it("returns empty array for empty input", () => {
    expect(parseSshNdjson("")).toEqual([]);
  });

  it("filters out the trailing stats line", () => {
    const raw = sshNdjson({ number: 42, status: "NEW" });
    const result = parseSshNdjson(raw);
    expect(result).toHaveLength(1);
    expect((result[0] as Record<string, unknown>)["number"]).toBe(42);
  });

  it("trims whitespace and ignores non-JSON lines", () => {
    const raw = `  \n${JSON.stringify({ id: "x" })}\n  not json  \n${JSON.stringify({ type: "stats", rowCount: 1 })}`;
    expect(parseSshNdjson(raw)).toHaveLength(1);
  });

  it("returns multiple records", () => {
    const raw = sshNdjson({ a: 1 }, { b: 2 });
    expect(parseSshNdjson(raw)).toHaveLength(2);
  });
});

describe("GerritSshClient", () => {
  beforeEach(() => {
    execFileCalls.length = 0;
    execFileResults = [];
    execFileCallIndex = 0;
    spawnCalls.length = 0;
    spawnExitCode = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("query", () => {
    it("builds the correct SSH args and returns stdout", async () => {
      execFileResults = [{ stdout: "output", stderr: "" }];

      const result = await makeClient().query(["ls-projects", "--format", "JSON"]);

      expect(result).toBe("output");
      expect(execFileCalls[0]!.args).toEqual([
        "-p", "29418",
        "-i", "/key",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "ve@gerrit.test",
        "gerrit", "ls-projects", "--format", "JSON",
      ]);
    });

    it("uses StrictHostKeyChecking=yes with UserKnownHostsFile when knownHostsPath is set", async () => {
      execFileResults = [{ stdout: "output", stderr: "" }];

      const client = new GerritSshClient({ ...SSH_CONFIG, knownHostsPath: "/etc/ssh/known_hosts" });
      await client.query(["ls-projects"]);

      expect(execFileCalls[0]!.args).toEqual([
        "-p", "29418",
        "-i", "/key",
        "-o", "StrictHostKeyChecking=yes",
        "-o", "UserKnownHostsFile=/etc/ssh/known_hosts",
        "ve@gerrit.test",
        "gerrit", "ls-projects",
      ]);
    });

    it("propagates execFile errors", async () => {
      execFileResults = [new Error("SSH connection refused")];
      await expect(makeClient().query(["ls-projects"])).rejects.toThrow("SSH connection refused");
    });
  });

  describe("queryChange", () => {
    it("returns Zod-validated change info", async () => {
      execFileResults = [{
        stdout: sshNdjson({ number: 42, status: "NEW", currentPatchSet: { number: 3, revision: "abc" } }),
        stderr: "",
      }];

      const info = await makeClient().queryChange("I8473");

      expect(info.number).toBe(42);
      expect(info.status).toBe("NEW");
      expect(info.currentPatchSet?.number).toBe(3);
    });

    it("throws when change is not found", async () => {
      execFileResults = [{ stdout: sshNdjson(), stderr: "" }];
      await expect(makeClient().queryChange("Imissing")).rejects.toThrow("change not found");
    });

    it("throws when response fails Zod validation", async () => {
      execFileResults = [{ stdout: sshNdjson({ number: "not-a-number", status: "NEW" }), stderr: "" }];
      await expect(makeClient().queryChange("Ibad")).rejects.toThrow();
    });
  });

  describe("getUnresolvedComments", () => {
    const BASE_COMMENT = {
      timestamp: 1710000000,
      reviewer: { email: "reviewer@example.com" },
      message: "Fix this",
      file: "src/main.ts",
      line: 12,
      patchSet: 3,
    };

    const BASE_CHANGE_MESSAGE = {
      timestamp: 1710000100,
      reviewer: { name: "Alice", email: "alice@example.com", username: "alice" },
      message: "Patch Set 1:\n\n(2 comments)\n\nPlease fix the error handling",
    };

    function makeChangeRow(
      comments: unknown[] = [BASE_COMMENT],
      changeMessages?: unknown[],
    ): unknown {
      return {
        number: 42,
        status: "NEW",
        currentPatchSet: { number: 3, revision: "abc", comments },
        ...(changeMessages !== undefined ? { comments: changeMessages } : {}),
      };
    }

    it("maps SSH comments to ReviewComment shape", async () => {
      execFileResults = [{ stdout: sshNdjson(makeChangeRow()), stderr: "" }];

      const comments = await makeClient().getUnresolvedComments("I8473");

      expect(comments).toHaveLength(1);
      expect(comments[0]!.author).toBe("reviewer@example.com");
      expect(comments[0]!.filePath).toBe("src/main.ts");
      expect(comments[0]!.line).toBe(12);
      expect(comments[0]!.unresolved).toBe(true);
      expect(comments[0]!.patchset).toBe(3);
      expect(comments[0]!.updatedAt).toEqual(new Date(1710000000 * 1000));
    });

    it("sets filePath to undefined for patchset-level comments", async () => {
      const patchsetComment = { ...BASE_COMMENT, file: "/PATCHSET_LEVEL" };
      execFileResults = [{ stdout: sshNdjson(makeChangeRow([patchsetComment])), stderr: "" }];

      const comments = await makeClient().getUnresolvedComments("I8473");

      expect(comments[0]!.filePath).toBeUndefined();
    });

    it("filters comments by sincePatchset — keeps only comments >= threshold", async () => {
      const old = { ...BASE_COMMENT, patchSet: 1 };
      const current = { ...BASE_COMMENT, patchSet: 3 };
      execFileResults = [{ stdout: sshNdjson(makeChangeRow([old, current])), stderr: "" }];

      const comments = await makeClient().getUnresolvedComments("I8473", 3);

      expect(comments).toHaveLength(1);
      expect(comments[0]!.patchset).toBe(3);
    });

    it("returns empty array when there are no rows", async () => {
      execFileResults = [{ stdout: sshNdjson(), stderr: "" }];
      const comments = await makeClient().getUnresolvedComments("Ino-change");
      expect(comments).toHaveLength(0);
    });

    it("falls back to reviewer name when email is absent", async () => {
      const nameOnly = { ...BASE_COMMENT, reviewer: { name: "Alice" } };
      execFileResults = [{ stdout: sshNdjson(makeChangeRow([nameOnly])), stderr: "" }];

      const comments = await makeClient().getUnresolvedComments("I8473");

      expect(comments[0]!.author).toBe("Alice");
    });

    it("falls back to 'unknown' when both name and email are absent", async () => {
      const noReviewer = { ...BASE_COMMENT, reviewer: {} };
      execFileResults = [{ stdout: sshNdjson(makeChangeRow([noReviewer])), stderr: "" }];

      const comments = await makeClient().getUnresolvedComments("I8473");

      expect(comments[0]!.author).toBe("unknown");
    });

    it("extracts top-level change messages when currentPatchSet has no comments", async () => {
      const row = makeChangeRow([], [BASE_CHANGE_MESSAGE]);
      execFileResults = [{ stdout: sshNdjson(row), stderr: "" }];

      const comments = await makeClient().getUnresolvedComments("I8473");

      expect(comments).toHaveLength(1);
      expect(comments[0]!.author).toBe("alice@example.com");
      expect(comments[0]!.message).toBe("Please fix the error handling");
      expect(comments[0]!.filePath).toBeUndefined();
      expect(comments[0]!.line).toBeUndefined();
      expect(comments[0]!.unresolved).toBe(true);
      expect(comments[0]!.id).toMatch(/^gerrit-msg-/);
    });

    it("merges top-level change messages with inline currentPatchSet comments", async () => {
      const row = makeChangeRow([BASE_COMMENT], [BASE_CHANGE_MESSAGE]);
      execFileResults = [{ stdout: sshNdjson(row), stderr: "" }];

      const comments = await makeClient().getUnresolvedComments("I8473");

      expect(comments).toHaveLength(2);
      const inlineComment = comments.find((c) => c.id.startsWith("ssh-") && !c.id.startsWith("gerrit-msg-"));
      const changeMessage = comments.find((c) => c.id.startsWith("gerrit-msg-"));
      expect(inlineComment).toBeDefined();
      expect(changeMessage).toBeDefined();
    });

    it("filters out VE's own change messages when sshUser is provided", async () => {
      const veMessage = {
        ...BASE_CHANGE_MESSAGE,
        reviewer: { name: "VE Bot", email: "ve@gerrit.test", username: "ve" },
      };
      const humanMessage = BASE_CHANGE_MESSAGE;
      const row = makeChangeRow([], [veMessage, humanMessage]);
      execFileResults = [{ stdout: sshNdjson(row), stderr: "" }];

      const comments = await makeClient().getUnresolvedComments("I8473", undefined, "ve");

      expect(comments).toHaveLength(1);
      expect(comments[0]!.author).toBe("alice@example.com");
    });

    it("filters out system-generated 'Uploaded patch set' messages", async () => {
      const systemMessage = {
        ...BASE_CHANGE_MESSAGE,
        message: "Uploaded patch set 2.",
        reviewer: { name: "Alice", email: "alice@example.com", username: "alice" },
      };
      const humanMessage = BASE_CHANGE_MESSAGE;
      const row = makeChangeRow([], [systemMessage, humanMessage]);
      execFileResults = [{ stdout: sshNdjson(row), stderr: "" }];

      const comments = await makeClient().getUnresolvedComments("I8473");

      expect(comments).toHaveLength(1);
      expect(comments[0]!.message).toContain("Please fix");
    });

    it("filters out system-generated merge messages", async () => {
      const mergeMessage = {
        ...BASE_CHANGE_MESSAGE,
        message: "Change has been successfully merged",
      };
      const row = makeChangeRow([], [mergeMessage]);
      execFileResults = [{ stdout: sshNdjson(row), stderr: "" }];

      const comments = await makeClient().getUnresolvedComments("I8473");

      expect(comments).toHaveLength(0);
    });

    it("extracts body from a vote+comment message, discarding the preamble", async () => {
      const voteAndComment = {
        timestamp: 1710000200,
        reviewer: { name: "Bob", email: "bob@example.com", username: "bob" },
        message: "Patch Set 1: Code-Review+2\n\n(1 comment)\n\nLooks good, but please fix the indentation",
      };
      const row = makeChangeRow([], [voteAndComment]);
      execFileResults = [{ stdout: sshNdjson(row), stderr: "" }];

      const comments = await makeClient().getUnresolvedComments("I8473");

      expect(comments).toHaveLength(1);
      expect(comments[0]!.message).toBe("Looks good, but please fix the indentation");
    });

    it("skips pure vote messages with no body after preamble stripping", async () => {
      const pureVote = {
        timestamp: 1710000200,
        reviewer: { name: "Bob", email: "bob@example.com", username: "bob" },
        message: "Patch Set 1: Code-Review+2\n\n",
      };
      const row = makeChangeRow([], [pureVote]);
      execFileResults = [{ stdout: sshNdjson(row), stderr: "" }];

      const comments = await makeClient().getUnresolvedComments("I8473");

      expect(comments).toHaveLength(0);
    });

    it("deduplicates change messages with the same timestamp (id == timestamp)", async () => {
      // Same-timestamp messages collapse to the same ID. This is intentional
      // — it lets stream-event comments and SSH-polled comments dedupe naturally
      // through the feedbackProcessor's processed_comments table.
      const msg1 = { ...BASE_CHANGE_MESSAGE, timestamp: 1710000100 };
      const msg2 = { ...BASE_CHANGE_MESSAGE, timestamp: 1710000100, reviewer: { name: "Bob", email: "bob@example.com", username: "bob" } };
      const row = makeChangeRow([], [msg1, msg2]);
      execFileResults = [{ stdout: sshNdjson(row), stderr: "" }];

      const comments = await makeClient().getUnresolvedComments("I8473");

      expect(comments).toHaveLength(2);
      expect(comments[0]!.id).toBe(comments[1]!.id);
    });
  });

  describe("getDiscussionComments", () => {
    const INLINE = {
      timestamp: 1710000000,
      reviewer: { name: "Alice", email: "alice@example.com", username: "alice" },
      message: "Why this approach?",
      file: "src/main.ts",
      line: 12,
      patchSet: 3,
    };

    const OWN_INLINE = {
      timestamp: 1710000050,
      reviewer: { name: "VE Bot", email: "ve@gerrit.test", username: "ve" },
      message: "Because of X.",
      file: "src/main.ts",
      line: 12,
      patchSet: 3,
    };

    const CHANGE_MESSAGE = {
      timestamp: 1710000100,
      reviewer: { name: "Bob", email: "bob@example.com", username: "bob" },
      message: "Patch Set 3:\n\n(1 comment)\n\nOverall looks reasonable.",
    };

    function makeRow(comments: unknown[] = [], changeMessages?: unknown[]): unknown {
      return {
        number: 42,
        status: "NEW",
        currentPatchSet: { number: 3, revision: "abc", comments },
        ...(changeMessages !== undefined ? { comments: changeMessages } : {}),
      };
    }

    it("maps inline comments and tags isOwn against the configured user", async () => {
      execFileResults = [{ stdout: sshNdjson(makeRow([INLINE, OWN_INLINE])), stderr: "" }];

      const result = await makeClient().getDiscussionComments("I8473");

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        author: "alice",
        isOwn: false,
        message: "Why this approach?",
        file: "src/main.ts",
        line: 12,
        patchSet: 3,
      });
      expect(result[0]!.timestampMs).toBe(1710000000 * 1000);
      expect(result[1]!.isOwn).toBe(true);
    });

    it("maps top-level change messages with file/line null and strips the preamble", async () => {
      execFileResults = [{ stdout: sshNdjson(makeRow([], [CHANGE_MESSAGE])), stderr: "" }];

      const result = await makeClient().getDiscussionComments("I8473");

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        author: "bob",
        isOwn: false,
        message: "Overall looks reasonable.",
        file: null,
        line: null,
        patchSet: 0,
      });
    });

    it("treats /PATCHSET_LEVEL inline comments as change-level (file null)", async () => {
      const patchsetLevel = { ...INLINE, file: "/PATCHSET_LEVEL" };
      execFileResults = [{ stdout: sshNdjson(makeRow([patchsetLevel])), stderr: "" }];

      const result = await makeClient().getDiscussionComments("I8473");

      expect(result[0]!.file).toBeNull();
    });

    it("skips system messages and empty bodies", async () => {
      const system = { ...CHANGE_MESSAGE, message: "Uploaded patch set 2." };
      const pureVote = { ...CHANGE_MESSAGE, message: "Patch Set 3: Code-Review+2\n\n" };
      execFileResults = [{ stdout: sshNdjson(makeRow([], [system, pureVote])), stderr: "" }];

      const result = await makeClient().getDiscussionComments("I8473");

      expect(result).toHaveLength(0);
    });
  });

  describe("resolveComments", () => {
    const CHANGE_ROW = {
      number: 42,
      status: "NEW",
      currentPatchSet: { number: 2, revision: "abc" },
    };

    it("groups comments by file and posts via reviewJson (spawn)", async () => {
      execFileResults = [
        { stdout: sshNdjson(CHANGE_ROW), stderr: "" }, // queryChange
      ];
      spawnExitCode = 0;

      await makeClient().resolveComments("I8473", [
        { id: "c1", author: "a@b.com", message: "Fix", filePath: "src/main.ts", line: 10, unresolved: true, patchset: 2, updatedAt: new Date() },
        { id: "c2", author: "a@b.com", message: "Here too", filePath: "src/main.ts", line: 20, unresolved: true, patchset: 2, updatedAt: new Date() },
      ]);

      expect(spawnCalls).toHaveLength(1);
      const reviewCall = spawnCalls[0]!;
      expect(reviewCall.args).toContain("--json");
      expect(reviewCall.args).toContain("42,2");

      const input = JSON.parse(reviewCall.stdinData) as {
        comments: Record<string, Array<{ unresolved: boolean }>>;
      };
      expect(input.comments["src/main.ts"]).toHaveLength(2);
      expect(input.comments["src/main.ts"]?.[0]?.unresolved).toBe(false);
    });

    it("is a no-op when comments array is empty", async () => {
      await makeClient().resolveComments("I8473", []);
      expect(execFileCalls).toHaveLength(0);
    });
  });

  describe("reviewJson", () => {
    it("pipes input to spawn stdin and resolves on exit code 0", async () => {
      spawnExitCode = 0;

      await makeClient().reviewJson("42,3", '{"labels":{"Code-Review":1}}');

      expect(spawnCalls).toHaveLength(1);
      const call = spawnCalls[0]!;
      expect(call.args).toContain("gerrit");
      expect(call.args).toContain("--json");
      expect(call.args).toContain("42,3");
      expect(call.stdinData).toBe('{"labels":{"Code-Review":1}}');
    });

    it("rejects on non-zero exit code", async () => {
      spawnExitCode = 1;
      await expect(makeClient().reviewJson("42,3", "{}")).rejects.toThrow("exited with code 1");
    });
  });
});
