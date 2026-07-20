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
  });

  it("spawns aider with conventional-commit, --yes, --no-pretty, --auto-commits for codegen", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runAiderAgent("do the thing", {
      model: "gpt-4o",
      systemPrompt: "sys",
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

  it("disables auto-commits but keeps git for review mode (repo-map)", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runAiderAgent("review this", {
      model: "",
      systemPrompt: "sys",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "review",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain("--no-auto-commits");
    expect(args).not.toContain("--no-git");
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
      systemPrompt: "sys",
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

  it("rejects when aider exits non-zero", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runAiderAgent("hi", {
      model: "gpt-4o",
      systemPrompt: "sys",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 2);
    await expect(promise).rejects.toThrow(/exited with code 2/);
  });
});