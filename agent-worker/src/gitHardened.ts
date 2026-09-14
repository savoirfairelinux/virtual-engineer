/**
 * Centralized hardened git invocation for the agent worker.
 *
 * All git calls inside the agent container go through this module so that
 * every invocation is consistently hardened against:
 *   - global/system config injection  (GIT_CONFIG_GLOBAL=/dev/null,
 *                                      GIT_CONFIG_SYSTEM=/dev/null,
 *                                      GIT_CONFIG_NOSYSTEM=1)
 *   - git hooks                       (-c core.hooksPath=/dev/null)
 *   - signing helper programs         (-c commit.gpgsign=false)
 *   - filesystem monitor extensions   (-c core.fsmonitor=false)
 *   - unexpected protocol helpers     (-c protocol.allow=never)
 *   - external diff / textconv helpers declared by the repository
 *                                     (--no-ext-diff --no-textconv)
 *
 * Note on repository-local config: `.git/config` and `.gitattributes` live in
 * the workspace the agent can write, and git offers no switch to ignore them.
 * The `-c` flags above therefore override the *specific* directives that make
 * git execute a helper program, rather than trying to block config loading.
 *
 * The environment is reduced to a minimal allowlist so that provider
 * credentials (GITHUB_TOKEN, ANTHROPIC_API_KEY, …) never leak into git
 * subprocesses.
 *
 * Usage:
 *   const out = hardenedGit(['log', '--oneline'], '/path/to/repo');
 */

import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'child_process';

/**
 * Hardened -c flags prepended to every git invocation.
 * Mirrors what HostGitExecutor / NodeGitRunner already apply on the host.
 */
const GIT_HARDENED_FLAGS: readonly string[] = [
  '-c', 'core.hooksPath=/dev/null',
  // Only neutralises an inherited include chain; a repo-local `[include]` in
  // .git/config is still read. Kept for parity with the host trustedGitArgs.
  '-c', 'include.path=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'protocol.allow=never',
  // A repo-set gpg.program would otherwise run when signing is turned on.
  '-c', 'commit.gpgsign=false',
];

/**
 * Subcommands that render a diff and can therefore execute the helper programs
 * named by `diff.external` (.git/config) or `diff.<driver>.textconv`
 * (.gitattributes). Setting `-c diff.external=` is not an option: git then
 * aborts with "external diff died" instead of falling back to the internal
 * diff, so the per-command flags below are used instead.
 */
const DIFF_PRODUCING_SUBCOMMANDS = new Set([
  'diff',
  'diff-tree',
  'diff-index',
  'log',
  'show',
  'whatchanged',
]);

const DIFF_SAFETY_FLAGS = ['--no-ext-diff', '--no-textconv'];

/** Insert the diff-safety flags right after the subcommand, before any pathspec. */
function applyDiffSafety(args: readonly string[]): string[] {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || !DIFF_PRODUCING_SUBCOMMANDS.has(subcommand)) {
    return [...args];
  }
  return [subcommand, ...DIFF_SAFETY_FLAGS, ...rest];
}

const GIT_IDENTITY_VARS = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const;

/**
 * Build a minimal environment for git subprocesses.
 * Only the listed variables are forwarded; everything else (including
 * provider credentials) is stripped.
 *
 * Caller-supplied `extra` values always win over the inherited environment.
 */
export function buildHardenedGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '/sandbox',
    // Disable all git configuration files outside the repo itself.
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    // Disable terminal paging.
    GIT_PAGER: 'cat',
    TERM: 'dumb',
    // Neutralise a repo-set core.editor rather than letting git launch it.
    GIT_EDITOR: 'true',
  };
  // Preserve git identity if set by the host.
  for (const key of GIT_IDENTITY_VARS) {
    const val = process.env[key];
    if (val) safe[key] = val;
  }
  return { ...safe, ...extra };
}

function decodeGitFailure(err: unknown, args: readonly string[]): Error {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  const detail = (e.stderr ?? e.stdout ?? e.message ?? '').slice(0, 500);
  return new Error(`git ${args[0] ?? ''}: ${detail}`);
}

/**
 * Run a git command with hardened flags and a sanitized environment.
 *
 * @param args  git subcommand + arguments (no leading 'git').
 * @param cwd   Working directory.
 * @param extraEnv  Additional env vars merged on top of the hardened set
 *                  (e.g. `GIT_SEQUENCE_EDITOR` for an interactive rebase).
 * @returns stdout as UTF-8 string.
 */
export function hardenedGit(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): string {
  const options: ExecFileSyncOptionsWithStringEncoding = {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildHardenedGitEnv(extraEnv),
  };
  try {
    return execFileSync('git', [...GIT_HARDENED_FLAGS, ...applyDiffSafety(args)], options);
  } catch (err) {
    throw decodeGitFailure(err, args);
  }
}
