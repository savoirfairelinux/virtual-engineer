import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { PassThrough } from "stream";

// Mock child_process.spawn so we can assert argv/env without running aider.
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// Mock fs so the runner's temp-file writes don't touch disk.
vi.mock("fs", () => ({
  mkdtempSync: vi.fn(() => "/tmp/ve-aider-test"),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}));

import { runAiderAgent } from "../../agent-worker/src/providers/aider.js";
import { writeFileSync } from "fs";
import type { ChildProcess } from "child_process";

function makeFakeChild(): ChildProcess {
  const ee = new EventEmitter() as ChildProcess;
  ee.stdout = new PassThrough() as unknown as ChildProcess["stdout"];
  ee.stderr = new PassThrough() as unknown as ChildProcess["stderr"];
  ee.kill = vi.fn();
  return ee;
}

describe("runAiderAgent", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    delete process.env["AIDER_CHAT_MODE"];
    delete process.env["AIDER_REASONING_EFFORT"];
    delete process.env["AIDER_THINKING_TOKENS"];
    delete process.env["AIDER_MAP_TOKENS"];
    delete process.env["AIDER_AUTO_LINT"];
    delete process.env["AIDER_AUTO_TEST"];
  });

  it("spawns aider with conventional-commit, --yes, --no-pretty, --auto-commits for codegen", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runAiderAgent("do the thing", {
      model: "gpt-4o",
      agentInstructions: "sys",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    // Allow spawn to register handlers, then close successfully.
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain("--yes");
    expect(args).toContain("--no-pretty");
    expect(args).toContain("--no-stream");
    expect(args).toContain("--auto-commits");
    expect(args).toContain("--commit-prompt");
    expect(args).toContain("--model");
    expect(args).toContain("gpt-4o");
    expect(args).not.toContain("--no-auto-commits");
  });

  it("loads agent instructions as read-only conventions instead of merging them into the user message", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runAiderAgent("workflow task", {
      model: "gpt-4o",
      agentInstructions: "permanent agent policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0]![1] as string[];
    const writes = vi.mocked(writeFileSync).mock.calls;
    expect(args).toContain("--read");
    expect(args).toContain("/tmp/ve-aider-test/agent-instructions.md");
    expect(writes).toContainEqual([
      "/tmp/ve-aider-test/agent-instructions.md",
      "permanent agent policy",
      "utf8",
    ]);
    expect(writes).toContainEqual([
      "/tmp/ve-aider-test/prompt.txt",
      "workflow task",
      "utf8",
    ]);
  });

  it("maps advanced coding options to native Aider flags", async () => {
    process.env["AIDER_CHAT_MODE"] = "architect";
    process.env["AIDER_REASONING_EFFORT"] = "high";
    process.env["AIDER_THINKING_TOKENS"] = "16000";
    process.env["AIDER_MAP_TOKENS"] = "4096";
    process.env["AIDER_AUTO_LINT"] = "1";
    process.env["AIDER_AUTO_TEST"] = "1";
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runAiderAgent("workflow task", {
      model: "o3",
      agentInstructions: "policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toEqual(expect.arrayContaining([
      "--chat-mode", "architect",
      "--reasoning-effort", "high",
      "--thinking-tokens", "16000",
      "--map-tokens", "4096",
      "--auto-lint",
      "--auto-test",
    ]));
    expect(args).not.toContain("--no-auto-lint");
    expect(args).not.toContain("--no-auto-test");
  });

  it("disables git and auto-commits for review mode (read-only workspace)", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runAiderAgent("review this", {
      model: "",
      agentInstructions: "sys",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "review",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0]![1] as string[];
    // --no-git is required: the review container mounts /workspace read-only,
    // and Aider's setup_git() would otherwise crash writing .git/config.lock.
    expect(args).toContain("--no-git");
    expect(args).toContain("--no-auto-commits");
    expect(args).toContain("--no-dirty-commits");
    expect(args).not.toContain("--auto-commits");
    // No --model arg when model is empty.
    expect(args).not.toContain("--model");
  });

  it("forwards only whitelisted env vars to the subprocess", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test";
    process.env["SECRET_LEAK"] = "should-not-leak";
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runAiderAgent("hi", {
      model: "gpt-4o",
      agentInstructions: "sys",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    const env = spawnMock.mock.calls[0]![2] as { env: Record<string, string> };
    expect(env.env["OPENAI_API_KEY"]).toBe("sk-test");
    expect(env.env["SECRET_LEAK"]).toBeUndefined();
    expect(env.env["GIT_AUTHOR_NAME"]).toBeDefined();
    delete process.env["OPENAI_API_KEY"];
    delete process.env["SECRET_LEAK"];
  });

  it("does not forward unrelated cloud credentials (AWS/Azure/Vertex/Gemini)", async () => {
    process.env["AWS_SECRET_ACCESS_KEY"] = "aws-secret";
    process.env["AZURE_API_KEY"] = "azure-secret";
    process.env["GEMINI_API_KEY"] = "gemini-secret";
    process.env["VERTEX_PROJECT"] = "vertex-proj";
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runAiderAgent("hi", {
      model: "gpt-4o",
      agentInstructions: "sys",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    const env = spawnMock.mock.calls[0]![2] as { env: Record<string, string> };
    expect(env.env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
    expect(env.env["AZURE_API_KEY"]).toBeUndefined();
    expect(env.env["GEMINI_API_KEY"]).toBeUndefined();
    expect(env.env["VERTEX_PROJECT"]).toBeUndefined();
    delete process.env["AWS_SECRET_ACCESS_KEY"];
    delete process.env["AZURE_API_KEY"];
    delete process.env["GEMINI_API_KEY"];
    delete process.env["VERTEX_PROJECT"];
  });

  it("emits an edit event with the bare path for an 'Editing file:' announcement", async () => {
    const events: Array<Record<string, unknown>> = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      const text = String(chunk);
      for (const line of text.split("\n")) {
        if (line.includes('"__ve_event"')) {
          try {
            events.push(JSON.parse(line) as Record<string, unknown>);
          } catch {
            /* ignore non-JSON stderr lines */
          }
        }
      }
      return true;
    });
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runAiderAgent("edit please", {
      model: "gpt-4o",
      agentInstructions: "sys",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    (fake.stdout as PassThrough).write("Editing file: src/foo.ts\n");
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;
    stderrSpy.mockRestore();

    const editEvent = events.find(
      (e) => e["type"] === "tool.execution_start" && (e["data"] as Record<string, unknown>)?.["name"] === "edit"
    );
    expect(editEvent).toBeDefined();
    expect((editEvent!["data"] as { input: { path: string } }).input.path).toBe("src/foo.ts");
  });

  it("rejects with exit code and last stderr error line when aider exits non-zero", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runAiderAgent("hi", {
      model: "gpt-4o",
      agentInstructions: "sys",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    (fake.stderr as PassThrough).write("Traceback (most recent call last):\n  File \"main.py\"\nOSError: [Errno 30] Read-only file system: '/workspace/.git/config.lock'\n");
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 1);
    await expect(promise).rejects.toThrow(/exited with code 1.*OSError.*Read-only file system/);
  });

  it("rejects with just the exit code when aider exits non-zero with no stderr", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runAiderAgent("hi", {
      model: "gpt-4o",
      agentInstructions: "sys",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 2);
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Aider exited with code 2");
  });
});