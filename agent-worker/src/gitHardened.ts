/**
 * Centralized hardened git invocation for the agent worker.
 *
 * All git calls inside the agent container go through this module so that
 * every invocation is consistently hardened against:
 *   - global/system config injection  (GIT_CONFIG_GLOBAL=/dev/null,
 *                                      GIT_CONFIG_SYSTEM=/dev/null,
 *                                      GIT_CONFIG_NOSYSTEM=1)
 *   - git hooks                       (-c core.hooksPath=/dev/null)
 *   - included config files           (-c include.path=/dev/null)
 *   - filesystem monitor extensions   (-c core.fsmonitor=false)
 *   - unexpected protocol helpers     (-c protocol.allow=never)
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
  // Must be an absolute path: git rejects an empty/relative command-line include.
  '-c', 'include.path=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'protocol.allow=never',
];

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
    return execFileSync('git', [...GIT_HARDENED_FLAGS, ...args], options);
  } catch (err) {
    throw decodeGitFailure(err, args);
  }
}
