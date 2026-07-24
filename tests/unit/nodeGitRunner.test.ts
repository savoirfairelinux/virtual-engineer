import { describe, expect, it } from "vitest";
import { GitCommandError } from "../../src/vcs/gitRunner.js";
import { NodeGitRunner } from "../../src/vcs/nodeGitRunner.js";

const runner = new NodeGitRunner({ executable: process.execPath });

describe("NodeGitRunner", () => {
  it("returns stdout and stderr without using a shell", async () => {
    const result = await runner.run([
      "-e",
      "process.stdout.write('abc\\n'); process.stderr.write('warning\\n')",
    ], { cwd: process.cwd() });

    expect(result).toEqual({ stdout: "abc\n", stderr: "warning\n" });
  });

  it("reports a non-zero exit with bounded redacted output", async () => {
    const credential = "https://oauth2:super-secret@git.example.test/group/repo.git";

    const error = await runner.run([
      "-e",
      `process.stderr.write(${JSON.stringify(`fatal: ${credential}`)}); process.exit(7)`,
    ], { cwd: process.cwd() }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitCommandError);
    expect(error).toMatchObject({
      reason: "non-zero-exit",
      exitCode: 7,
      stdout: "",
      stderr: "fatal: https://<redacted>@git.example.test/group/repo.git",
    });
    expect((error as Error).message).not.toContain("super-secret");
  });

  it("terminates and reports commands that exceed their timeout", async () => {
    const error = await runner.run([
      "-e",
      "setInterval(() => {}, 1000)",
    ], {
      cwd: process.cwd(),
      timeoutMs: 25,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitCommandError);
    expect(error).toMatchObject({ reason: "timeout", exitCode: null });
  });

  it("terminates and reports commands cancelled by an AbortSignal", async () => {
    const controller = new AbortController();
    const promise = runner.run([
      "-e",
      "setInterval(() => {}, 1000)",
    ], {
      cwd: process.cwd(),
      signal: controller.signal,
    }).catch((caught: unknown) => caught);

    controller.abort();
    const error = await promise;

    expect(error).toBeInstanceOf(GitCommandError);
    expect(error).toMatchObject({ reason: "cancelled", exitCode: null });
  });

  it("rejects output that exceeds the configured buffer", async () => {
    const error = await runner.run([
      "-e",
      "process.stdout.write('x'.repeat(4096))",
    ], {
      cwd: process.cwd(),
      maxBufferBytes: 128,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitCommandError);
    expect(error).toMatchObject({ reason: "max-buffer" });
    expect((error as GitCommandError).stdout.length).toBeLessThanOrEqual(128);
  });

  it("redacts successful output and never includes credential-bearing args in errors", async () => {
    const credential = "https://oauth2:another-secret@git.example.test/group/repo.git";
    const success = await runner.run([
      "-e",
      `process.stdout.write(${JSON.stringify(credential)})`,
    ], { cwd: process.cwd() });
    expect(success.stdout).toBe(
      "https://<redacted>@git.example.test/group/repo.git"
    );

    const error = await runner.run([
      "-e",
      "process.exit(2)",
      credential,
    ], { cwd: process.cwd() }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitCommandError);
    expect((error as Error).message).not.toContain("another-secret");
  });
});