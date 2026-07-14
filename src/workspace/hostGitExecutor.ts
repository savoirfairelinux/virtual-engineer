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
import { lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "path";

/** Runs a git argv in `cwd` with an optional explicit env; resolves stdout, rejects on non-zero exit. */
export type GitRunner = (args: string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise<string>;

const defaultGitRunner: GitRunner = (args, cwd, env) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: env ?? process.env },
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

function credentialFreeUrl(repoUrl: string): string | null {
  try {
    const parsed = new URL(repoUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    const cleanUrl = parsed.toString();
    return cleanUrl !== repoUrl ? cleanUrl : null;
  } catch {
    return null;
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

  /** Clone `repoUrl` at `branch` into `dir` (single-branch). Injects GIT_SSH_COMMAND when SSH params are provided. */
  async cloneRepo(
    dir: string,
    repoUrl: string,
    branch: string,
    subPath = ".",
    sshKeyPath?: string | null,
    sshKnownHostsPath?: string | null,
  ): Promise<void> {
    const cloneDir = resolveWorkspacePath(dir, subPath);
    const env = buildSshGitEnv(sshKeyPath, sshKnownHostsPath);
    await this.git(["clone", "--branch", branch, "--single-branch", repoUrl, subPath], dir, env);
    const cleanUrl = credentialFreeUrl(repoUrl);
    if (cleanUrl) {
      try {
        await this.git(["remote", "set-url", "origin", cleanUrl], cloneDir);
      } catch (err) {
        await rm(cloneDir, { recursive: true, force: true });
        throw err;
      }
    }
  }

  /** Run an arbitrary git command in `dir` (optionally within a sub-path). */
  async execGit(dir: string, args: string[], subPath?: string): Promise<string> {
    return this.git(args, subPath ? resolveWorkspacePath(dir, subPath) : dir);
  }

  /** Fetch a ref and check it out as detached HEAD. */
  async fetchAndCheckout(
    dir: string,
    remoteUrl: string,
    ref: string,
    subPath = ".",
    sshKeyPath?: string | null,
    sshKnownHostsPath?: string | null,
  ): Promise<void> {
    const cwd = resolveWorkspacePath(dir, subPath);
    const env = buildSshGitEnv(sshKeyPath, sshKnownHostsPath);
    await this.git(["fetch", remoteUrl, ref], cwd, env);
    await this.git(["checkout", "FETCH_HEAD"], cwd);
  }

  /** Fetch a ref and cherry-pick it onto the current HEAD. */
  async fetchAndCherryPick(
    dir: string,
    remoteUrl: string,
    ref: string,
    subPath = ".",
    sshKeyPath?: string | null,
    sshKnownHostsPath?: string | null,
  ): Promise<void> {
    const cwd = resolveWorkspacePath(dir, subPath);
    const env = buildSshGitEnv(sshKeyPath, sshKnownHostsPath);
    await this.git(["fetch", remoteUrl, ref], cwd, env);
    await this.git(["cherry-pick", "FETCH_HEAD"], cwd);
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
