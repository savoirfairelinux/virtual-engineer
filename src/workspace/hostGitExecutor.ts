/**
 * HostGitExecutor — native git plumbing for the OpenShell / Kubernetes runtime.
 *
 * Replaces the Docker helper-container git operations with git run directly by
 * the orchestrator (pod or host) in an ephemeral working directory. This keeps
 * clone/checkout/cherry-pick and — crucially — push credentials in the
 * orchestrator, never inside the agent sandbox.
 *
 * The git runner is injectable so the executor is unit-testable without git.
 */

import { execFile } from "child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "fs/promises";
import { lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { trustedGitArgs, trustedGitEnv } from "../utils/gitExec.js";

/** Runs a git argv in `cwd` with an optional explicit env; resolves stdout, rejects on non-zero exit. */
export type GitRunner = (args: string[], cwd: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<string>;

const DEFAULT_CLONE_MAX_ATTEMPTS = 3;
const DEFAULT_CLONE_RETRY_DELAY_MS = 1_000;
const DEFAULT_CLONE_TIMEOUT_MS = 5 * 60 * 1_000;
const TRANSIENT_CLONE_ERROR = /(?:RPC failed|early EOF|invalid index-pack|index-pack failed|remote end hung up|could not resolve host|network is unreachable|connection (?:timed out|reset|closed|refused)|curl \d+.*(?:timed out|recv failure|reset))/i;

const defaultGitRunner: GitRunner = (args, cwd, env, signal) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      trustedGitArgs(args),
      { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: trustedGitEnv(env), signal },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`git ${args[0]}: ${(stderr || err.message).slice(0, 500)}`));
          return;
        }
        resolve(stdout);
      }
    );
  });

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function resolveWorkspacePath(dir: string, subPath: string): string {
  if (isAbsolute(subPath)) {
    throw new Error(`Path must stay within workspace: ${subPath}`);
  }
  const workspace = resolve(dir);
  const target = resolve(workspace, subPath);
  const relativePath = relative(workspace, target);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`Path must stay within workspace: ${subPath}`);
  }
  let current = workspace;
  for (const component of relativePath.split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Path must not traverse a symbolic link: ${subPath}`);
      }
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") break;
      throw err;
    }
  }
  return target;
}

async function assertNoSymlinks(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Untrusted Git metadata contains a symbolic link: ${entry.name}`);
    }
    if (entry.isDirectory()) await assertNoSymlinks(entryPath);
  }
}

function trustedGitConfig(remoteUrl: string): string {
  return [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tfilemode = true",
    "\tbare = false",
    "\tlogallrefupdates = true",
    "[remote \"origin\"]",
    `\turl = ${remoteUrl}`,
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    "",
  ].join("\n");
}

export function credentialFreeUrl(repoUrl: string): string {
  try {
    const parsed = new URL(repoUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return repoUrl;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    const cleanUrl = parsed.toString();
    return cleanUrl;
  } catch {
    return repoUrl;
  }
}

/**
 * Build a process env that injects GIT_SSH_COMMAND for a given key + known-hosts policy.
 * When no knownHostsPath is provided SSH falls back to StrictHostKeyChecking=no so that
 * first-time connections (host key not yet in system known_hosts) do not fail.
 * Setting GIT_SSH_COMMAND is harmless for HTTPS URLs — git ignores it.
 */
function buildSshGitEnv(
  sshKeyPath?: string | null,
  sshKnownHostsPath?: string | null,
): NodeJS.ProcessEnv {
  const keyPart = sshKeyPath
    ? `-i ${shellQuote(sshKeyPath)} -o IdentitiesOnly=yes`
    : "";
  const hostKeyPart = sshKnownHostsPath
    ? `-o StrictHostKeyChecking=yes -o UserKnownHostsFile=${shellQuote(sshKnownHostsPath)}`
    : "-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null";
  const sshCmd = ["ssh", keyPart, hostKeyPart].filter(Boolean).join(" ");
  return { ...process.env, GIT_SSH_COMMAND: sshCmd };
}

function normalizedOption(value: number | undefined, fallback: number, minimum: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(minimum, Math.floor(value));
}

function isTransientCloneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_CLONE_ERROR.test(message);
}

interface CloneAttemptSignal {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}

function createCloneAttemptSignal(parentSignal: AbortSignal | undefined, timeoutMs: number): CloneAttemptSignal {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onParentAbort = (): void => {
    controller.abort(parentSignal?.reason);
  };

  if (parentSignal?.aborted === true) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  if (!controller.signal.aborted && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`git clone timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    timedOut: (): boolean => timedOut,
    dispose: (): void => {
      if (timer !== undefined) clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

async function waitForCloneRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (delayMs === 0) {
    signal?.throwIfAborted();
    return;
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      rejectPromise(new Error("git clone retry aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}

export interface HostWorkspace {
  /** Absolute path to the ephemeral working directory. */
  dir: string;
}

export interface HostGitExecutorOptions {
  /** Base directory under which ephemeral workspaces are created. */
  baseDir: string;
  git?: GitRunner;
  /** Maximum number of attempts for a transient clone failure. Defaults to 3. */
  cloneMaxAttempts?: number | undefined;
  /** Delay between transient clone attempts in milliseconds. Defaults to 1000. */
  cloneRetryDelayMs?: number | undefined;
  /** Timeout for each clone attempt in milliseconds. Defaults to five minutes; 0 disables it. */
  cloneTimeoutMs?: number | undefined;
}

export class HostGitExecutor {
  private readonly baseDir: string;
  private readonly git: GitRunner;
  private readonly cloneMaxAttempts: number;
  private readonly cloneRetryDelayMs: number;
  private readonly cloneTimeoutMs: number;

  constructor(options: HostGitExecutorOptions) {
    this.baseDir = options.baseDir;
    this.git = options.git ?? defaultGitRunner;
    this.cloneMaxAttempts = normalizedOption(options.cloneMaxAttempts, DEFAULT_CLONE_MAX_ATTEMPTS, 1);
    this.cloneRetryDelayMs = normalizedOption(options.cloneRetryDelayMs, DEFAULT_CLONE_RETRY_DELAY_MS, 0);
    this.cloneTimeoutMs = normalizedOption(options.cloneTimeoutMs, DEFAULT_CLONE_TIMEOUT_MS, 0);
  }

  /** Create an ephemeral working directory. */
  async createWorkspace(prefix: string, signal?: AbortSignal): Promise<HostWorkspace> {
    signal?.throwIfAborted();
    const dir = await mkdtemp(join(this.baseDir, `${prefix}-`));
    if (signal?.aborted === true) {
      await rm(dir, { recursive: true, force: true });
      signal.throwIfAborted();
    }
    return { dir };
  }

  /** Clone `repoUrl` at `branch` into `dir` (single-branch). Injects GIT_SSH_COMMAND when SSH params are provided. */
  async cloneRepo(
    dir: string,
    repoUrl: string,
    branch: string,
    subPath = ".",
    sshKeyPath?: string | null,
    sshKnownHostsPath?: string | null,
    signal?: AbortSignal,
  ): Promise<void> {
    const cloneDir = resolveWorkspacePath(dir, subPath);
    const env = buildSshGitEnv(sshKeyPath, sshKnownHostsPath);
    let lastError: unknown;
    let cloneSucceeded = false;

    for (let attempt = 1; attempt <= this.cloneMaxAttempts; attempt += 1) {
      signal?.throwIfAborted();
      const attemptSignal = createCloneAttemptSignal(signal, this.cloneTimeoutMs);
      try {
        await this.git(
          ["clone", "--branch", branch, "--single-branch", "--depth", "1", repoUrl, subPath],
          dir,
          env,
          attemptSignal.signal,
        );
        if (signal?.aborted === true) signal.throwIfAborted();
        if (attemptSignal.timedOut()) {
          throw new Error(`git clone timed out after ${this.cloneTimeoutMs}ms`);
        }
        attemptSignal.dispose();
        cloneSucceeded = true;
        break;
      } catch (err) {
        const cloneError = attemptSignal.timedOut()
          ? new Error(`git clone timed out after ${this.cloneTimeoutMs}ms`)
          : err;
        lastError = cloneError;
        await this.resetCloneDestination(cloneDir);
        attemptSignal.dispose();

        if (signal?.aborted === true) signal.throwIfAborted();
        const isTransientFailure = attemptSignal.timedOut() || isTransientCloneError(cloneError);
        if (attempt >= this.cloneMaxAttempts || !isTransientFailure) {
          throw cloneError;
        }
        await waitForCloneRetry(this.cloneRetryDelayMs, signal);
      }
    }

    if (!cloneSucceeded) {
      throw lastError instanceof Error ? lastError : new Error("git clone failed");
    }

    const cleanUrl = credentialFreeUrl(repoUrl);
    if (cleanUrl !== repoUrl) {
      try {
        await this.git(["remote", "set-url", "origin", cleanUrl], cloneDir, undefined, signal);
      } catch (err) {
        await rm(cloneDir, { recursive: true, force: true });
        throw err;
      }
    }
  }

  private async resetCloneDestination(cloneDir: string): Promise<void> {
    await rm(cloneDir, { recursive: true, force: true });
    await mkdir(cloneDir, { recursive: true });
  }

  /** Run an arbitrary git command in `dir` (optionally within a sub-path). */
  async execGit(dir: string, args: string[], subPath?: string, signal?: AbortSignal): Promise<string> {
    return this.git(args, subPath ? resolveWorkspacePath(dir, subPath) : dir, undefined, signal);
  }

  /** Replace sandbox-returned Git configuration with host-trusted metadata. */
  async rebuildTrustedMetadata(dir: string, remotes: ReadonlyMap<string, string>): Promise<void> {
    for (const [subPath, remoteUrl] of remotes) {
      const repoDir = resolveWorkspacePath(dir, subPath);
      const gitDir = join(repoDir, ".git");
      if (!lstatSync(gitDir).isDirectory()) {
        throw new Error(`Untrusted Git metadata is not a directory: ${subPath}`);
      }
      await assertNoSymlinks(gitDir);
      await Promise.all([
        rm(join(gitDir, "hooks"), { recursive: true, force: true }),
        rm(join(gitDir, "objects", "info", "alternates"), { force: true }),
        rm(join(gitDir, "config.worktree"), { force: true }),
        rm(join(gitDir, "info", "attributes"), { force: true }),
        rm(join(gitDir, "config"), { force: true }),
      ]);
      await writeFile(join(gitDir, "config"), trustedGitConfig(remoteUrl), { encoding: "utf8", mode: 0o600 });
    }
  }

  /** Fetch a ref and check it out as detached HEAD. */
  async fetchAndCheckout(
    dir: string,
    remoteUrl: string,
    ref: string,
    subPath = ".",
    sshKeyPath?: string | null,
    sshKnownHostsPath?: string | null,
    signal?: AbortSignal,
  ): Promise<void> {
    const cwd = resolveWorkspacePath(dir, subPath);
    const env = buildSshGitEnv(sshKeyPath, sshKnownHostsPath);
    await this.git(["fetch", remoteUrl, ref], cwd, env, signal);
    await this.git(["checkout", "FETCH_HEAD"], cwd, undefined, signal);
  }

  /** Fetch a ref and cherry-pick it onto the current HEAD. */
  async fetchAndCherryPick(
    dir: string,
    remoteUrl: string,
    ref: string,
    subPath = ".",
    sshKeyPath?: string | null,
    sshKnownHostsPath?: string | null,
    signal?: AbortSignal,
  ): Promise<void> {
    const cwd = resolveWorkspacePath(dir, subPath);
    const env = buildSshGitEnv(sshKeyPath, sshKnownHostsPath);
    await this.git(["fetch", remoteUrl, ref], cwd, env, signal);
    await this.git(["cherry-pick", "FETCH_HEAD"], cwd, undefined, signal);
  }

  /** List files changed relative to `baseRef` (default: staged+unstaged vs HEAD). */
  async listModifiedFiles(dir: string, baseRef = "HEAD", subPath = "."): Promise<string[]> {
    const out = await this.git(["diff", "--name-only", baseRef], resolveWorkspacePath(dir, subPath));
    return out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  }

  /** Remove an ephemeral working directory. Best-effort; never throws. */
  async destroyWorkspace(dir: string): Promise<void> {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
