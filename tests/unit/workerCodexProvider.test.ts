import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { PassThrough } from "stream";

// Mock child_process.spawn so we can assert argv/env without running codex.
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// Mock fs so the runner's temp-dir + config writes don't touch disk.
vi.mock("fs", () => ({
  mkdirSync: vi.fn(),
  mkdtempSync: vi.fn(() => "/tmp/ve-codex-test"),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}));

import { runCodexAgent, CODEX_PROVIDER } from "../../agent-worker/src/providers/codex.js";
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

describe("runCodexAgent", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    delete process.env["CODEX_MODEL"];
    delete process.env["CODEX_REASONING_EFFORT"];
    delete process.env["CODEX_API_KEY"];
    delete process.env["CODEX_ACCESS_TOKEN"];
    vi.mocked(writeFileSync).mockReset();
    vi.mocked(mkdirSync).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("declares the MCP submission transport", () => {
    expect(CODEX_PROVIDER.submissionTransport).toBe("mcp");
    expect(CODEX_PROVIDER.id).toBe("codex");
    expect(CODEX_PROVIDER.adapterLabel).toBe("codex-cli");
  });

  it("spawns codex exec --json for codegen with danger-full-access sandbox", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runCodexAgent("do the thing", {
      model: "gpt-5.5",
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
    expect(binary).toBe("codex");
    expect(args).toContain("exec");
    expect(args).toContain("--json");
    expect(args).toEqual(expect.arrayContaining(["--sandbox", "danger-full-access"]));
    expect(args).toEqual(expect.arrayContaining(["--ask-for-approval", "never"]));
    expect(args).toEqual(expect.arrayContaining(["--model", "gpt-5.5"]));
    expect(args[args.length - 1]).toBe("-");
  });

  it("uses a read-only sandbox for review mode", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runCodexAgent("review the diff", {
      model: "gpt-5.5",
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
    expect(args).toEqual(expect.arrayContaining(["--sandbox", "read-only"]));
  });

  it("omits --model and reasoning effort for codex_native review (CLI-managed)", async () => {
    process.env["CODEX_REASONING_EFFORT"] = "high";
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runCodexAgent("review the diff", {
      model: "gpt-5.5",
      agentInstructions: "review policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "review",
      reviewStrategy: "codex_native",
      reviewOutputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).not.toContain("--model");
    expect(args.join(" ")).not.toContain("model_reasoning_effort");
  });

  it("applies -c model_reasoning_effort when configured", async () => {
    process.env["CODEX_REASONING_EFFORT"] = "high";
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runCodexAgent("task", {
      model: "gpt-5.5",
      agentInstructions: "policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toEqual(expect.arrayContaining(["-c", "model_reasoning_effort=high"]));
  });

  it("writes a Codex config.toml with the VE MCP submission server", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runCodexAgent("workflow task", {
      model: "gpt-5.5",
      agentInstructions: "permanent agent policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    const writes = vi.mocked(writeFileSync).mock.calls;
    const configWrite = writes.find((w) => String(w[0]).endsWith("config.toml"));
    expect(configWrite).toBeDefined();
    const configContent = String(configWrite![1]);
    expect(configContent).toContain("[mcp_servers.ve-submission]");
    expect(configContent).toContain("/app/agent-worker/dist/mcpSubmissionServer.js");
    expect(configContent).toContain("required = true");
    expect(configContent).toContain("VE_SUBMISSION_MODE");
  });

  it("pipes the prompt with the submission instruction via stdin", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const endSpy = vi.spyOn(fake.stdin!, "end");
    const promise = runCodexAgent("base task", {
      model: "gpt-5.5",
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

  it("parses agent_message items into content and observes mcp_tool_call submissions", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runCodexAgent("task", {
      model: "gpt-5.5",
      agentInstructions: "policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.stdout?.emit("data", Buffer.from(
      `${JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", tool: "ve_submit_changes", status: "completed" } })}\n`
    ));
    fake.stdout?.emit("data", Buffer.from(
      `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } })}\n`
    ));
    fake.emit("close", 0);
    const result = await promise;

    expect(result.content).toBe("done");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.name).toBe("ve_submit_changes");
    expect(result.toolCalls![0]!.success).toBe(true);
  });

  it("emits assistant.usage from turn.completed", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const emitSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const promise = runCodexAgent("task", {
      model: "gpt-5.5",
      agentInstructions: "policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.stdout?.emit("data", Buffer.from(
      `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 10 } })}\n`
    ));
    fake.emit("close", 0);
    await promise;

    const writes = emitSpy.mock.calls.map((c) => String(c[0]));
    const usageEvent = writes.find((w) => w.includes('"assistant.usage"'));
    expect(usageEvent).toBeDefined();
    expect(usageEvent).toContain('"inputTokens":100');
    expect(usageEvent).toContain('"outputTokens":50');
    expect(usageEvent).toContain('"cacheReadTokens":10');
    emitSpy.mockRestore();
  });

  it("throws on turn.failed", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runCodexAgent("task", {
      model: "gpt-5.5",
      agentInstructions: "policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.stdout?.emit("data", Buffer.from(
      `${JSON.stringify({ type: "turn.failed", message: "boom" })}\n`
    ));
    await expect(promise).rejects.toThrow(/boom/);
  });

  it("rejects on timeout and kills the child", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runCodexAgent("task", {
      model: "gpt-5.5",
      agentInstructions: "policy",
      cwd: "/workspace",
      timeoutMs: 50,
      mode: "codegen",
    });
    await expect(promise).rejects.toThrow(/timed out/);
    expect(fake.kill).toHaveBeenCalled();
  });

  it("rejects on non-zero exit with a descriptive error", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runCodexAgent("task", {
      model: "gpt-5.5",
      agentInstructions: "policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 1);
    await expect(promise).rejects.toThrow(/exited with code 1/);
  });

  it("throws when review mode has no reviewOutputSchema", async () => {
    await expect(
      runCodexAgent("review", {
        model: "gpt-5.5",
        agentInstructions: "policy",
        cwd: "/workspace",
        timeoutMs: 1000,
        mode: "review",
      })
    ).rejects.toThrow(/REVIEW_OUTPUT_SCHEMA is required/);
  });

  it("bootstraps a subscription access-token login before exec", async () => {
    process.env["CODEX_ACCESS_TOKEN"] = "codex-access-xyz";
    const loginChild = makeFakeChild();
    const execChild = makeFakeChild();
    const loginStdinEnd = vi.spyOn(loginChild.stdin!, "end");
    spawnMock.mockReturnValueOnce(loginChild).mockReturnValueOnce(execChild);

    const promise = runCodexAgent("task", {
      model: "gpt-5.5",
      agentInstructions: "policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    loginChild.emit("close", 0);
    await new Promise((r) => setImmediate(r));
    execChild.emit("close", 0);
    await promise;

    expect(spawnMock.mock.calls[0]![1]).toEqual(["login", "--with-access-token"]);
    expect(loginStdinEnd).toHaveBeenCalledWith("codex-access-xyz\n");
    expect(spawnMock.mock.calls[1]![1]).toContain("exec");
  });
});
