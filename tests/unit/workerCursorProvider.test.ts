import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { PassThrough } from "stream";

// Mock child_process.spawn so we can assert argv/env without running cursor-agent.
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// Mock fs so the runner's config writes don't touch disk.
vi.mock("fs", () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}));

import { runCursorAgent, CURSOR_PROVIDER } from "../../agent-worker/src/providers/cursor.js";
import { writeFileSync, mkdirSync } from "fs";
import type { ChildProcess } from "child_process";

function makeFakeChild(): ChildProcess {
  const ee = new EventEmitter() as ChildProcess;
  ee.stdout = new PassThrough() as unknown as ChildProcess["stdout"];
  ee.stderr = new PassThrough() as unknown as ChildProcess["stderr"];
  ee.kill = vi.fn();
  return ee;
}

describe("runCursorAgent", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    delete process.env["CURSOR_MODEL"];
    delete process.env["CURSOR_API_KEY"];
    delete process.env["HOME"];
    vi.mocked(writeFileSync).mockReset();
    vi.mocked(mkdirSync).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("declares the MCP submission transport", () => {
    expect(CURSOR_PROVIDER.submissionTransport).toBe("mcp");
    expect(CURSOR_PROVIDER.id).toBe("cursor");
    expect(CURSOR_PROVIDER.adapterLabel).toBe("cursor-cli");
  });

  it("spawns cursor-agent for codegen with --force and a disabled sandbox", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runCursorAgent("do the thing", {
      model: "gpt-5",
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
    expect(binary).toBe("cursor-agent");
    expect(args[0]).toBe("-p");
    expect(args).toEqual(expect.arrayContaining(["--output-format", "stream-json"]));
    expect(args).toEqual(expect.arrayContaining(["--approve-mcps"]));
    expect(args).toEqual(expect.arrayContaining(["--trust"]));
    expect(args).toEqual(expect.arrayContaining(["--force"]));
    expect(args).toEqual(expect.arrayContaining(["--sandbox", "disabled"]));
    expect(args).toEqual(expect.arrayContaining(["--model", "gpt-5"]));
  });

  it("uses --mode ask (no --force) for review mode", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runCursorAgent("review the diff", {
      model: "gpt-5",
      agentInstructions: "review policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "review",
      reviewOutputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toEqual(expect.arrayContaining(["--mode", "ask"]));
    expect(args).not.toContain("--force");
  });

  it("passes the prompt as the -p positional argument, not via stdin", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runCursorAgent("base task", {
      model: "gpt-5",
      agentInstructions: "base policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args[1]).toContain("base task");
    expect(args[1]).toContain("base policy");
  });

  it("writes a Cursor mcp.json under HOME/.cursor with the VE MCP submission server", async () => {
    process.env["HOME"] = "/sandbox";
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runCursorAgent("workflow task", {
      model: "gpt-5",
      agentInstructions: "permanent agent policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    const writes = vi.mocked(writeFileSync).mock.calls;
    const configWrite = writes.find((w) => String(w[0]) === "/sandbox/.cursor/mcp.json");
    expect(configWrite).toBeDefined();
    const configContent = String(configWrite![1]);
    expect(configContent).toContain("ve-submission");
    expect(configContent).toContain("/app/agent-worker/dist/mcpSubmissionServer.js");
  });

  it("parses assistant and tool_call stream-json events", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runCursorAgent("task", {
      model: "gpt-5",
      agentInstructions: "policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));

    fake.stdout!.emit("data", Buffer.from(
      `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } })}\n`
    ));
    fake.stdout!.emit("data", Buffer.from(
      `${JSON.stringify({ type: "tool_call", subtype: "started", call_id: "1", tool_call: { readToolCall: { args: { path: "a.ts" } } } })}\n`
    ));
    fake.stdout!.emit("data", Buffer.from(
      `${JSON.stringify({ type: "tool_call", subtype: "completed", call_id: "1", tool_call: { readToolCall: { args: { path: "a.ts" }, result: { success: {} } } } })}\n`
    ));
    fake.emit("close", 0);
    const run = await promise;

    expect(run.content).toContain("hello");
    expect(run.toolCallCount).toBe(1);
    expect(run.toolsByKind["read_file"]).toBe(1);
    expect(run.toolCalls?.[0]).toMatchObject({ name: "read_file", success: true });
  });

  it("rejects with the tail of stderr on a non-zero exit code", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runCursorAgent("task", {
      model: "gpt-5",
      agentInstructions: "policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.stderr!.emit("data", Buffer.from("boom\n"));
    fake.emit("close", 1);

    await expect(promise).rejects.toThrow(/exited with code 1/);
  });
});
