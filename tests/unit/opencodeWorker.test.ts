import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { PassThrough } from "stream";

// Mock child_process.spawn so we can assert argv/env without running opencode.
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// Mock fs so the runner's temp-dir + config writes don't touch disk.
vi.mock("fs", () => ({
  mkdirSync: vi.fn(),
  mkdtempSync: vi.fn(() => "/tmp/ve-opencode-test"),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}));

import { runOpenCodeAgent, OPENCODE_PROVIDER } from "../../agent-worker/src/providers/opencode.js";
import { writeFileSync, mkdirSync } from "fs";
import type { ChildProcess } from "child_process";

function makeFakeChild(): ChildProcess {
  const ee = new EventEmitter() as ChildProcess;
  ee.stdin = new PassThrough() as unknown as ChildProcess["stdin"];
  ee.stdout = new PassThrough() as unknown as ChildProcess["stdout"];
  ee.stderr = new PassThrough() as unknown as ChildProcess["stderr"];
  ee.kill = vi.fn();
  return ee;
}

describe("runOpenCodeAgent", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    delete process.env["OPENCODE_MODEL"];
    delete process.env["OPENCODE_PROVIDER"];
    delete process.env["OPENCODE_VARIANT"];
    delete process.env["ANTHROPIC_API_KEY"];
    vi.mocked(writeFileSync).mockReset();
    vi.mocked(mkdirSync).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("declares the MCP submission transport", () => {
    expect(OPENCODE_PROVIDER.submissionTransport).toBe("mcp");
    expect(OPENCODE_PROVIDER.id).toBe("opencode");
    expect(OPENCODE_PROVIDER.adapterLabel).toBe("opencode-cli");
  });

  it("spawns opencode run --format json with the provider/model pair for codegen", async () => {
    process.env["OPENCODE_PROVIDER"] = "anthropic";
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runOpenCodeAgent("do the thing", {
      model: "claude-sonnet-4-5",
      agentInstructions: "sys",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    const binary = spawnMock.mock.calls[0]![0] as string;
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(binary).toBe("opencode");
    expect(args).toContain("run");
    expect(args).toEqual(expect.arrayContaining(["--format", "json"]));
    expect(args).toContain("--auto");
    expect(args).toEqual(expect.arrayContaining(["--model", "anthropic/claude-sonnet-4-5"]));
  });

  it("maps the gemini selector to the google provider id", async () => {
    process.env["OPENCODE_PROVIDER"] = "gemini";
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runOpenCodeAgent("do the thing", {
      model: "gemini-2.5-pro",
      agentInstructions: "sys",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toEqual(expect.arrayContaining(["--model", "google/gemini-2.5-pro"]));
  });

  it("omits --model for opencode_native review (CLI-managed)", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runOpenCodeAgent("review the diff", {
      model: "claude-sonnet-4-5",
      agentInstructions: "review policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "review",
      reviewStrategy: "opencode_native",
      reviewOutputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).not.toContain("--model");
  });

  it("writes an opencode.json config with the VE MCP submission server and review permission posture", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runOpenCodeAgent("review the diff", {
      model: "claude-sonnet-4-5",
      agentInstructions: "review policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "review",
      reviewOutputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    const writes = vi.mocked(writeFileSync).mock.calls;
    const configWrite = writes.find((w) => String(w[0]).endsWith("opencode.json"));
    expect(configWrite).toBeDefined();
    const config = JSON.parse(String(configWrite![1])) as {
      mcp: { "ve-submission": { command: string[] } };
      permission: unknown;
    };
    expect(config.mcp["ve-submission"].command[0]).toBe("node");
    expect(config.mcp["ve-submission"].command[1]).toContain("mcpSubmissionServer.js");
    expect(config.permission).toEqual({ "*": "allow", edit: "deny", bash: "deny" });
  });

  it("uses blanket allow permission for codegen", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runOpenCodeAgent("do the thing", {
      model: "claude-sonnet-4-5",
      agentInstructions: "sys",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    const writes = vi.mocked(writeFileSync).mock.calls;
    const configWrite = writes.find((w) => String(w[0]).endsWith("opencode.json"));
    const config = JSON.parse(String(configWrite![1])) as { permission: unknown };
    expect(config.permission).toBe("allow");
  });

  it("rejects with a timeout error and kills the process when the session exceeds timeoutMs", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runOpenCodeAgent("task", {
      model: "claude-sonnet-4-5",
      agentInstructions: "sys",
      cwd: "/workspace",
      timeoutMs: 50,
      mode: "codegen",
    });
    await expect(promise).rejects.toThrow("OpenCode session timed out after 50ms");
    expect(fake.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
