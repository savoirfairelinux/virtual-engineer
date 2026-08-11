import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { PassThrough } from "stream";

// Mock child_process.spawn so we can assert argv/env without running gemini.
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// Mock fs so the runner's settings.json write doesn't touch disk.
vi.mock("fs", () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}));

import { runGeminiAgent, GEMINI_PROVIDER } from "../../agent-worker/src/providers/gemini.js";
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

describe("runGeminiAgent", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    delete process.env["GEMINI_MODEL"];
    delete process.env["GEMINI_API_KEY"];
    delete process.env["GOOGLE_API_KEY"];
    process.env["HOME"] = "/sandbox";
    vi.mocked(writeFileSync).mockReset();
    vi.mocked(mkdirSync).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("declares the MCP submission transport", () => {
    expect(GEMINI_PROVIDER.submissionTransport).toBe("mcp");
    expect(GEMINI_PROVIDER.id).toBe("gemini");
    expect(GEMINI_PROVIDER.adapterLabel).toBe("gemini-cli");
  });

  it("spawns gemini with stream-json output and yolo approval mode for codegen", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runGeminiAgent("do the thing", {
      model: "gemini-2.5-pro",
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
    expect(binary).toBe("gemini");
    expect(args).toEqual(expect.arrayContaining(["--output-format", "stream-json"]));
    expect(args).toEqual(expect.arrayContaining(["--approval-mode", "yolo"]));
    expect(args).toContain("--skip-trust");
    expect(args).toEqual(expect.arrayContaining(["--model", "gemini-2.5-pro"]));
  });

  it("uses plan approval mode for review", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runGeminiAgent("review the diff", {
      model: "gemini-2.5-pro",
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
    expect(args).toEqual(expect.arrayContaining(["--approval-mode", "plan"]));
  });

  it("omits --model when no model is configured", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runGeminiAgent("task", {
      model: "",
      agentInstructions: "policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).not.toContain("--model");
  });

  it("writes a gemini settings.json with the trusted VE MCP submission server", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runGeminiAgent("workflow task", {
      model: "gemini-2.5-pro",
      agentInstructions: "permanent agent policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    const writes = vi.mocked(writeFileSync).mock.calls;
    const settingsWrite = writes.find((w) => String(w[0]).endsWith("settings.json"));
    expect(settingsWrite).toBeDefined();
    expect(String(settingsWrite![0])).toBe("/sandbox/.gemini/settings.json");
    const settingsContent = JSON.parse(String(settingsWrite![1])) as {
      mcpServers: { "ve-submission": { command: string; args: string[]; trust: boolean } };
    };
    expect(settingsContent.mcpServers["ve-submission"].trust).toBe(true);
    expect(settingsContent.mcpServers["ve-submission"].args).toContain(
      "/app/agent-worker/dist/mcpSubmissionServer.js"
    );
  });

  it("pipes the prompt with the submission instruction via stdin", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const endSpy = vi.spyOn(fake.stdin!, "end");
    const promise = runGeminiAgent("base task", {
      model: "gemini-2.5-pro",
      agentInstructions: "base policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    expect(endSpy).toHaveBeenCalled();
    const written = String(endSpy.mock.calls[0]![0]);
    expect(written).toContain("base task");
    expect(written).toContain("base policy");
    expect(written).toContain("ve_submit_changes");
  });

  it("parses message and tool_use/tool_result events into content and tool calls", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runGeminiAgent("task", {
      model: "gemini-2.5-pro",
      agentInstructions: "policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.stdout?.emit("data", Buffer.from(
      `${JSON.stringify({ type: "tool_use", name: "ve_submit_changes" })}\n`
    ));
    fake.stdout?.emit("data", Buffer.from(
      `${JSON.stringify({ type: "tool_result", name: "ve_submit_changes", success: true })}\n`
    ));
    fake.stdout?.emit("data", Buffer.from(
      `${JSON.stringify({ type: "message", role: "assistant", content: "done" })}\n`
    ));
    fake.emit("close", 0);
    const result = await promise;

    expect(result.content).toBe("done");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.name).toBe("ve_submit_changes");
    expect(result.toolCalls![0]!.success).toBe(true);
  });

  it("treats stream error events as non-fatal", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runGeminiAgent("task", {
      model: "gemini-2.5-pro",
      agentInstructions: "policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.stdout?.emit("data", Buffer.from(`${JSON.stringify({ type: "error", message: "transient warning" })}\n`));
    fake.stdout?.emit("data", Buffer.from(`${JSON.stringify({ type: "message", role: "assistant", content: "done" })}\n`));
    fake.emit("close", 0);
    const result = await promise;

    expect(result.content).toBe("done");
  });

  it("rejects with a descriptive error on a non-zero exit code", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runGeminiAgent("task", {
      model: "gemini-2.5-pro",
      agentInstructions: "policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 42);
    await expect(promise).rejects.toThrow("invalid prompt or arguments");
  });
});
