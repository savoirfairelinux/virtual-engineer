import { execFile } from "child_process";
import type { ExecFileException } from "child_process";
import { redactUrls } from "../utils/redactUrl.js";
import { trustedGitArgs, trustedGitEnv } from "../utils/gitExec.js";
import {
  GitCommandError,
  type GitCommandFailureReason,
  type GitCommandResult,
  type GitRunOptions,
  type GitRunner,
} from "./gitRunner.js";

const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_ERROR_DETAIL_CHARS = 500;

interface NodeGitRunnerOptions {
  executable?: string | undefined;
  defaultTimeoutMs?: number | undefined;
  defaultMaxBufferBytes?: number | undefined;
  /** Disable the git hardening prefix/env. Only for tests that spawn a non-git executable. */
  hardened?: boolean | undefined;
}

export class NodeGitRunner implements GitRunner {
  private readonly executable: string;
  private readonly defaultTimeoutMs: number | undefined;
  private readonly defaultMaxBufferBytes: number;
  private readonly hardened: boolean;

  constructor(options: NodeGitRunnerOptions = {}) {
    this.executable = options.executable ?? "git";
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.defaultMaxBufferBytes = options.defaultMaxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.hardened = options.hardened ?? this.executable === "git";
  }

  run(args: readonly string[], options: GitRunOptions): Promise<GitCommandResult> {
    const maxBufferBytes = options.maxBufferBytes ?? this.defaultMaxBufferBytes;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<GitCommandResult>((resolve, reject) => {
      let forcedReason: "timeout" | "cancelled" | undefined;
      let timer: NodeJS.Timeout | undefined;
      let settled = false;

      // The working directory came back from the agent sandbox, so neutralise
      // git's config-driven code-execution vectors (hooks, `include.path`, and
      // user/system config) on every invocation that carries push credentials.
      const child = execFile(
        this.executable,
        this.hardened ? trustedGitArgs(args) : [...args],
        {
          cwd: options.cwd,
          ...(this.hardened
            ? { env: trustedGitEnv(options.env) }
            : options.env !== undefined ? { env: options.env } : {}),
          encoding: "utf8",
          maxBuffer: maxBufferBytes,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          options.signal?.removeEventListener("abort", cancel);

          const safeStdout = sanitizeOutput(stdout, maxBufferBytes);
          const safeStderr = sanitizeOutput(stderr, maxBufferBytes);
          if (!error && forcedReason === undefined) {
            resolve({ stdout: safeStdout, stderr: safeStderr });
            return;
          }

          const reason = forcedReason ?? classifyFailure(error);
          const exitCode = numericExitCode(error);
          const exitSignal = error?.signal ?? null;
          reject(new GitCommandError(
            buildErrorMessage(reason, exitCode, safeStderr),
            {
              reason,
              exitCode,
              signal: exitSignal,
              stdout: safeStdout,
              stderr: safeStderr,
              ...(error !== null ? { cause: error } : {}),
            }
          ));
        }
      );

      const terminate = (reason: "timeout" | "cancelled"): void => {
        if (settled || forcedReason !== undefined) return;
        forcedReason = reason;
        child.kill("SIGTERM");
      };
      const cancel = (): void => terminate("cancelled");

      if (options.signal?.aborted) {
        cancel();
      } else {
        options.signal?.addEventListener("abort", cancel, { once: true });
      }
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => terminate("timeout"), timeoutMs);
      }
    });
  }
}

function classifyFailure(error: ExecFileException | null): GitCommandFailureReason {
  if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "max-buffer";
  return typeof error?.code === "number" ? "non-zero-exit" : "spawn-error";
}

function numericExitCode(error: ExecFileException | null): number | null {
  return typeof error?.code === "number" ? error.code : null;
}

function sanitizeOutput(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  const bounded = buffer.length <= maxBytes ? value : buffer.subarray(0, maxBytes).toString("utf8");
  return redactUrls(bounded);
}

function buildErrorMessage(
  reason: GitCommandFailureReason,
  exitCode: number | null,
  stderr: string
): string {
  const detail = stderr.trim().slice(0, MAX_ERROR_DETAIL_CHARS);
  switch (reason) {
    case "timeout":
      return "Git command timed out";
    case "cancelled":
      return "Git command was cancelled";
    case "max-buffer":
      return "Git command exceeded the output limit";
    case "non-zero-exit":
      return `Git command exited with code ${exitCode ?? "unknown"}${detail ? `: ${detail}` : ""}`;
    case "spawn-error":
      return `Git command could not be started${detail ? `: ${detail}` : ""}`;
  }
}