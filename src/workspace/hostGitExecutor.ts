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
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";

/** Runs a git argv in `cwd`; resolves stdout, rejects on non-zero exit. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise<string>((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args[0]}: ${(stderr || err.message).slice(0, 500)}`));
        return;
      }
      resolve(stdout);
    });
  });

export interface HostWorkspace {
  /** Absolute path to the ephemeral working directory. */
  dir: string;
}

export interface HostGitExecutorOptions {
  /** Base directory under which ephemeral workspaces are created. */
  baseDir: string;
  git?: GitRunner;
}

export class HostGitExecutor {
  private readonly baseDir: string;
  private readonly git: GitRunner;

  constructor(options: HostGitExecutorOptions) {
    this.baseDir = options.baseDir;
    this.git = options.git ?? defaultGitRunner;
  }

  /** Create an ephemeral working directory. */
  async createWorkspace(prefix: string): Promise<HostWorkspace> {
    const dir = await mkdtemp(join(this.baseDir, `${prefix}-`));
    return { dir };
  }

  /** Clone `repoUrl` at `branch` into `dir` (single-branch, depth-1 when shallow). */
  async cloneRepo(dir: string, repoUrl: string, branch: string, subPath = "."): Promise<void> {
    await this.git(["clone", "--branch", branch, "--single-branch", repoUrl, subPath], dir);
  }

  /** Run an arbitrary git command in `dir` (optionally within a sub-path). */
  async execGit(dir: string, args: string[], subPath?: string): Promise<string> {
    return this.git(args, subPath ? join(dir, subPath) : dir);
  }

  /** Fetch a ref and check it out as detached HEAD. */
  async fetchAndCheckout(dir: string, remoteUrl: string, ref: string, subPath = "."): Promise<void> {
    const cwd = join(dir, subPath);
    await this.git(["fetch", remoteUrl, ref], cwd);
    await this.git(["checkout", "FETCH_HEAD"], cwd);
  }

  /** Fetch a ref and cherry-pick it onto the current HEAD. */
  async fetchAndCherryPick(dir: string, remoteUrl: string, ref: string, subPath = "."): Promise<void> {
    const cwd = join(dir, subPath);
    await this.git(["fetch", remoteUrl, ref], cwd);
    await this.git(["cherry-pick", "FETCH_HEAD"], cwd);
  }

  /** List files changed relative to `baseRef` (default: staged+unstaged vs HEAD). */
  async listModifiedFiles(dir: string, baseRef = "HEAD", subPath = "."): Promise<string[]> {
    const out = await this.git(["diff", "--name-only", baseRef], join(dir, subPath));
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
