import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { PassThrough } from "stream";

// Mock child_process.spawn so we can assert argv/env without running goose.
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// Mock fs so the runner's temp-file + config writes don't touch disk.
vi.mock("fs", () => ({
  mkdirSync: vi.fn(),
  mkdtempSync: vi.fn(() => "/tmp/ve-goose-test"),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}));

import { runGooseAgent, GOOSE_PROVIDER } from "../../agent-worker/src/providers/goose.js";
import { writeFileSync, mkdirSync } from "fs";
import type { ChildProcess } from "child_process";

function makeFakeChild(): ChildProcess {
  const ee = new EventEmitter() as ChildProcess;
  ee.stdout = new PassThrough() as unknown as ChildProcess["stdout"];
  ee.stderr = new PassThrough() as unknown as ChildProcess["stderr"];
  ee.kill = vi.fn();
  return ee;
}

describe("runGooseAgent", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    delete process.env["GOOSE_MODEL"];
    delete process.env["GOOSE_MODE"];
    delete process.env["GOOSE_MAX_TURNS"];
    delete process.env["GOOSE_MAX_TOKENS"];
    delete process.env["GOOSE_TEMPERATURE"];
    delete process.env["GOOSE_AUTO_COMPACT_THRESHOLD"];
    vi.mocked(writeFileSync).mockReset();
    vi.mocked(mkdirSync).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("declares the MCP submission transport", () => {
    expect(GOOSE_PROVIDER.submissionTransport).toBe("mcp");
    expect(GOOSE_PROVIDER.id).toBe("goose");
    expect(GOOSE_PROVIDER.adapterLabel).toBe("goose-cli");
  });

  it("spawns goose run --instructions for codegen", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runGooseAgent("do the thing", {
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
    expect(binary).toBe("goose");
    expect(args).toContain("run");
    expect(args).toContain("--instructions");
    expect(args).toContain("--no-tui");
    expect(args).toContain("--no-session");
  });

  it("writes a Goose config.yaml with the VE MCP submission extension for codegen", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runGooseAgent("workflow task", {
      model: "claude-sonnet-4-5",
      agentInstructions: "permanent agent policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    const writes = vi.mocked(writeFileSync).mock.calls;
    // Find the config.yaml write (path ends with config.yaml).
    const configWrite = writes.find((w) => String(w[0]).endsWith("config.yaml"));
    expect(configWrite).toBeDefined();
    const configContent = String(configWrite![1]);
    expect(configContent).toContain("ve-submission");
    expect(configContent).toContain("type: stdio");
    expect(configContent).toContain("/agent-worker/dist/mcpSubmissionServer.js");
    expect(configContent).toContain("VE_SUBMISSION_MODE: \"codegen\"");
    expect(configContent).toContain("VE_SUBMISSION_PATH");
    expect(configContent).toContain("VE_SUBMISSION_SCHEMA_JSON");
    expect(configContent).toContain("developer:");
    expect(configContent).toContain("GOOSE_MODEL: claude-sonnet-4-5");
    expect(configContent).toContain("keyring: false");
  });

  it("disables builtin extensions for review mode and forces GOOSE_MODE=chat", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runGooseAgent("review the diff", {
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
    const configWrite = writes.find((w) => String(w[0]).endsWith("config.yaml"));
    expect(configWrite).toBeDefined();
    const configContent = String(configWrite![1]);
    expect(configContent).toContain("VE_SUBMISSION_MODE: \"review\"");
    // No developer extension in review mode.
    expect(configContent).not.toMatch(/\ndeveloper:/);
    // GOOSE_MODE=chat is forced for review.
    expect(configContent).toContain("GOOSE_MODE: chat");
  });

  it("appends the submission instruction to the agent instructions", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runGooseAgent("task", {
      model: "claude-sonnet-4-5",
      agentInstructions: "base policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    const writes = vi.mocked(writeFileSync).mock.calls;
    const promptWrite = writes.find((w) => String(w[0]).endsWith("prompt.txt"));
    expect(promptWrite).toBeDefined();
    const promptContent = String(promptWrite![1]);
    expect(promptContent).toContain("base policy");
    expect(promptContent).toContain("ve_submit_changes");
    expect(promptContent).toMatch(/Submit the final structured result/);
  });

  it("observes the VE MCP submission tool call and records it in toolCalls", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runGooseAgent("task", {
      model: "claude-sonnet-4-5",
      agentInstructions: "policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    // Emit a line that the parser recognizes as the submission tool call.
    fake.stdout?.emit("data", Buffer.from("mcp__ve-submission__ve_submit_changes\n"));
    fake.emit("close", 0);
    const result = await promise;

    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.name).toBe("mcp__ve-submission__ve_submit_changes");
    expect(result.toolCalls![0]!.success).toBe(true);
  });

  it("emits assistant.usage when a token line is parsed", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const emitSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const promise = runGooseAgent("task", {
      model: "claude-sonnet-4-5",
      agentInstructions: "policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.stdout?.emit("data", Buffer.from("Tokens: 100 sent, 50 received. Cost: $0.01\n"));
    fake.emit("close", 0);
    await promise;

    // The __ve_event for assistant.usage is written to stderr as JSON.
    const writes = emitSpy.mock.calls.map((c) => String(c[0]));
    const usageEvent = writes.find((w) => w.includes('"assistant.usage"'));
    expect(usageEvent).toBeDefined();
    expect(usageEvent).toContain('"inputTokens":100');
    expect(usageEvent).toContain('"outputTokens":50');
    expect(usageEvent).toContain('"costUsd":0.01');
    emitSpy.mockRestore();
  });

  it("rejects on timeout and kills the child", async () => {
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runGooseAgent("task", {
      model: "claude-sonnet-4-5",
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
    const promise = runGooseAgent("task", {
      model: "claude-sonnet-4-5",
      agentInstructions: "policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 1);
    await expect(promise).rejects.toThrow(/Goose exited with code 1/);
  });

  it("forwards provider auth env vars via the allowlist", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-key";
    const fake = makeFakeChild();
    spawnMock.mockReturnValue(fake);
    const promise = runGooseAgent("task", {
      model: "claude-sonnet-4-5",
      agentInstructions: "policy",
      cwd: "/workspace",
      timeoutMs: 1000,
      mode: "codegen",
    });
    await new Promise((r) => setImmediate(r));
    fake.emit("close", 0);
    await promise;

    const env = spawnMock.mock.calls[0]![2] as { env: Record<string, string> };
    expect(env.env["ANTHROPIC_API_KEY"]).toBe("sk-ant-key");
    expect(env.env["GOOSE_DISABLE_KEYRING"]).toBe("true");
    expect(env.env["GIT_AUTHOR_NAME"]).toBe("Virtual Engineer");
    delete process.env["ANTHROPIC_API_KEY"];
  });

  it("throws when review mode has no reviewOutputSchema", async () => {
    await expect(
      runGooseAgent("review", {
        model: "claude-sonnet-4-5",
        agentInstructions: "policy",
        cwd: "/workspace",
        timeoutMs: 1000,
        mode: "review",
      })
    ).rejects.toThrow(/REVIEW_OUTPUT_SCHEMA is required/);
  });
});