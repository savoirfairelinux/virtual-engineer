import { execFileSync } from "child_process";

/**
 * Run a git subcommand in the given directory; throws on non-zero exit.
 * The underlying git error output is truncated to 500 characters (before the
 * `git <subcommand>:` prefix is prepended) to keep logs readable.
 */
export function execGit(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    const message = error.message || "git command failed";
    throw new Error(`git ${args[0]}: ${message.slice(0, 500)}`);
  }
}
