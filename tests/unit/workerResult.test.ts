import { PassThrough, Writable } from "node:stream";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWorker } from "../../agent-worker/src/workerResult.js";

describe("worker result transport", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("masks session credentials in worker errors before emitting live events", async () => {
    vi.stubEnv("GITHUB_TOKEN", "private-session-value");
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    await runWorker(() => Promise.reject(new Error("Failed private-session-value Bearer another-value")), {}, {
      stdout, stderr, exit: vi.fn(),
    });
    const output = String(stdout.read()) + String(stderr.read());
    expect(output).not.toContain("private-session-value");
    expect(output).not.toContain("another-value");
    expect(output).toContain("<redacted>");
  });

  it("gives review sessions a fifteen-minute budget", () => {
    const source = readFileSync(new URL("../../agent-worker/src/index.ts", import.meta.url), "utf8");
    expect(source).toContain("runAgent(PROMPTS.userPrompt, 15 * 60 * 1000, 'review')");
  });

  it.each(["success", "failure"])("flushes a large %s envelope through a real process pipe", async (mode) => {
    const moduleUrl = new URL("../../agent-worker/src/workerResult.ts", import.meta.url).href;
    const script = `import(${JSON.stringify(moduleUrl)}).then(({ default: { runWorker } }) => runWorker(async () => {
      if (${JSON.stringify(mode)} === "failure") throw new Error("timeout " + "x".repeat(512000));
      return { status: "success", modifiedFiles: [], summary: "x".repeat(512000), agentLogs: "", metadata: {} };
    }, {}));`;
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--import", "tsx", "-e", script], {
      maxBuffer: 8 * 1024 * 1024, timeout: 10000,
    });
    const parsed = JSON.parse(stdout) as { status: string; summary: string };
    expect(parsed.status).toBe(mode === "success" ? "success" : "failed");
    expect(parsed.summary).toContain("x".repeat(512000));
    if (mode === "failure") expect(stderr).toContain('"type":"worker.error"');
  });

  it("waits for a large result to finish writing before exiting", async () => {
    let finishWrite: (() => void) | undefined;
    let stdout = "";
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        stdout += chunk.toString();
        finishWrite = callback;
      },
    });
    const exit = vi.fn();
    const result = { status: "success" as const, modifiedFiles: [], summary: "x".repeat(512_000), agentLogs: "", metadata: {} };
    const completion = runWorker(() => Promise.resolve(result), {}, {
      stdout: output, stderr: new PassThrough(), exit,
    });
    await vi.waitFor(() => expect(finishWrite).toBeDefined());
    expect(exit).not.toHaveBeenCalled();
    finishWrite?.();
    await completion;
    expect(JSON.parse(stdout)).toEqual(result);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("emits the original timeout on stderr and in the failure envelope", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const exit = vi.fn();
    await runWorker(() => Promise.reject(new Error("Review timed out after 540000ms")), {
      adapter: "copilot",
    }, { stdout, stderr, exit });
    expect(JSON.parse(String(stderr.read()))).toMatchObject({
      __ve_event: true, type: "worker.error", data: { message: "Review timed out after 540000ms" },
    });
    expect(JSON.parse(String(stdout.read()))).toMatchObject({
      status: "failed", summary: "Agent worker error: Review timed out after 540000ms",
      metadata: { adapter: "copilot" },
    });
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("exits nonzero when stdout cannot be written", async () => {
    const stdout = new Writable({
      write(_chunk, _encoding, callback) { callback(new Error("broken pipe")); },
    });
    const stderr = new PassThrough();
    const exit = vi.fn();
    await runWorker(() => Promise.resolve({ status: "success", modifiedFiles: [], summary: "ok", agentLogs: "", metadata: {} }), {}, {
      stdout, stderr, exit,
    });
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(String(stderr.read())).toContain("broken pipe");
  });
});