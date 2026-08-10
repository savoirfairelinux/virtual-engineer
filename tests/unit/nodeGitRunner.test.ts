import { describe, expect, it, vi } from "vitest";
import { GitCommandError } from "../../src/vcs/gitRunner.js";
import { NodeGitRunner } from "../../src/vcs/nodeGitRunner.js";

// `execFile` keeps its real implementation so the behavioural tests below still
// spawn a process; the hardening tests swap in a one-shot fake to inspect argv.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  execFileMock.mockImplementation((...args: unknown[]) =>
    (actual.execFile as unknown as (...a: unknown[]) => unknown)(...args)
  );
  return { ...actual, execFile: execFileMock };
});

const runner = new NodeGitRunner({ executable: process.execPath });

interface CapturedExec {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
}

/** Capture the next `execFile` invocation and complete it successfully. */
function captureNextExec(): { call: () => CapturedExec } {
  let captured: CapturedExec | undefined;
  execFileMock.mockImplementationOnce((
    file: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv | undefined },
    callback: (err: null, stdout: string, stderr: string) => void
  ) => {
    captured = { file, args, env: options.env };
    setImmediate(() => callback(null, "", ""));
    return { kill: () => undefined };
  });
  return {
    call: () => {
      if (!captured) throw new Error("execFile was not invoked");
      return captured;
    },
  };
}

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

  it("caps error message detail while preserving full stderr", async () => {
    const stderr = "failure ".repeat(100);

    const error = await runner.run([
      "-e",
      `process.stderr.write(${JSON.stringify(stderr)}); process.exit(7)`,
    ], { cwd: process.cwd() }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitCommandError);
    expect(error).toMatchObject({ stderr });
    expect((error as Error).message).toBe(
      `Git command exited with code 7: ${stderr.slice(0, 500)}`
    );
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

describe("NodeGitRunner git hardening", () => {
  it("neutralises hooks, include.path and user/system config for the git executable", async () => {
    const captured = captureNextExec();

    await new NodeGitRunner().run(["status", "--porcelain"], { cwd: "/tmp/ws" });

    const call = captured.call();
    expect(call.file).toBe("git");
    expect(call.args).toEqual([
      "-c", "core.hooksPath=/dev/null",
      "-c", "include.path=/dev/null",
      "status", "--porcelain",
    ]);
    expect(call.env).toMatchObject({
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    });
  });

  it("merges a caller-supplied env but keeps the GIT_CONFIG pins", async () => {
    const captured = captureNextExec();

    await new NodeGitRunner().run(["push"], {
      cwd: "/tmp/ws",
      env: {
        GIT_SSH_COMMAND: "ssh -i /secrets/key",
        GIT_CONFIG_GLOBAL: "/workspace/.evil-gitconfig",
        GIT_CONFIG_SYSTEM: "/workspace/.evil-system",
      },
    });

    const call = captured.call();
    expect(call.env?.["GIT_SSH_COMMAND"]).toBe("ssh -i /secrets/key");
    expect(call.env?.["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
    expect(call.env?.["GIT_CONFIG_SYSTEM"]).toBe("/dev/null");
  });

  it("leaves a non-git executable unhardened", async () => {
    const captured = captureNextExec();

    await new NodeGitRunner({ executable: process.execPath }).run(["-e", ""], {
      cwd: "/tmp/ws",
      env: { FOO: "bar" },
    });

    const call = captured.call();
    expect(call.file).toBe(process.execPath);
    expect(call.args).toEqual(["-e", ""]);
    expect(call.env).toEqual({ FOO: "bar" });
  });

  it("passes no env override at all for an unhardened runner without env", async () => {
    const captured = captureNextExec();

    await new NodeGitRunner({ executable: process.execPath }).run(["-e", ""], { cwd: "/tmp/ws" });

    expect(captured.call().env).toBeUndefined();
  });
});