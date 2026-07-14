import { execFileSync } from "child_process";

export const TRUSTED_GIT_PREFIX = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "include.path=/dev/null",
] as const;

export function trustedGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

export function trustedGitArgs(args: readonly string[]): string[] {
  return [...TRUSTED_GIT_PREFIX, ...args];
}

/**
 * Run a git subcommand in the given directory; throws on non-zero exit.
 * The underlying git error output is truncated to 500 characters (before the
 * `git <subcommand>:` prefix is prepended) to keep logs readable.
 */
export function execGit(args: string[], cwd: string): string {
  try {
    return execFileSync("git", trustedGitArgs(args), {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: trustedGitEnv(),
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    const message = error.message || "git command failed";
    throw new Error(`git ${args[0]}: ${message.slice(0, 500)}`);
  }
}
