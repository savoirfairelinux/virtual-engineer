export type GitCommandFailureReason =
  | "non-zero-exit"
  | "timeout"
  | "cancelled"
  | "max-buffer"
  | "spawn-error";

export interface GitRunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  maxBufferBytes?: number | undefined;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitRunner {
  run(args: readonly string[], options: GitRunOptions): Promise<GitCommandResult>;
}

interface GitCommandErrorOptions {
  reason: GitCommandFailureReason;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  cause?: unknown;
}

export class GitCommandError extends Error {
  readonly reason: GitCommandFailureReason;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(message: string, options: GitCommandErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "GitCommandError";
    this.reason = options.reason;
    this.exitCode = options.exitCode;
    this.signal = options.signal;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
  }
}