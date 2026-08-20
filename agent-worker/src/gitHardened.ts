/**
 * Centralized hardened git invocation for the agent worker.
 *
 * All git calls inside the agent container go through this module so that
 * every invocation is consistently hardened against:
 *   - global/system config injection  (GIT_CONFIG_GLOBAL=/dev/null,
 *                                      GIT_CONFIG_SYSTEM=/dev/null,
 *                                      GIT_CONFIG_NOSYSTEM=1)
 *   - git hooks                       (-c core.hooksPath=/dev/null)
 *   - included config files           (-c include.path=)
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

import { execFileSync, type ExecFileSyncOptionsWithBufferEncoding } from 'child_process';

/**
 * Hardened -c flags prepended to every git invocation.
 * Mirrors what HostGitExecutor / NodeGitRunner already apply on the host.
 */
const GIT_HARDENED_FLAGS: readonly string[] = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'include.path=',
  '-c', 'core.fsmonitor=false',
  '-c', 'protocol.allow=never',
];

/**
 * Build a minimal environment for git subprocesses.
 * Only the listed variables are forwarded; everything else (including
 * provider credentials) is stripped.
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
    ...extra,
  };
  // Preserve git identity if set by the host.
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
    const val = process.env[key];
    if (val) safe[key] = val;
  }
  return safe;
}

/**
 * Run a git command with hardened flags and a sanitized environment.
 *
 * @param args  git subcommand + arguments (no leading 'git').
 * @param cwd   Working directory.
 * @param extraEnv  Additional env vars to merge on top of the hardened set.
 * @returns stdout as UTF-8 string.
 */
export function hardenedGit(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): string {
  const env = buildHardenedGitEnv(extraEnv);
  const options: ExecFileSyncOptionsWithBufferEncoding = {
    cwd,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  };
  try {
    // Prepend hardening flags before the subcommand.
    const fullArgs = [...GIT_HARDENED_FLAGS, ...args];
    const buf = execFileSync('git', fullArgs, options);
    return (buf as unknown as { toString(enc: string): string }).toString('utf8');
  } catch (err) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const raw = e.stderr ?? e.stdout ?? String(e.message ?? '');
    const detail = (typeof raw === 'string' ? raw : raw.toString('utf8')).slice(0, 500);
    throw new Error(`git ${args[0] ?? ''}: ${detail}`);
  }
}

/**
 * Run git with a fully custom environment (used by rebase sequences where
 * GIT_SEQUENCE_EDITOR / GIT_EDITOR must be forwarded).
 *
 * The caller is responsible for providing git identity vars in extraEnv when
 * they differ from what the process inherited.
 */
export function hardenedGitWithEnv(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  const mergedEnv = buildHardenedGitEnv();
  // Merge caller env on top (caller wins, but hardened base is the floor).
  Object.assign(mergedEnv, env);
  const options: ExecFileSyncOptionsWithBufferEncoding = {
    cwd,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: mergedEnv,
  };
  try {
    const fullArgs = [...GIT_HARDENED_FLAGS, ...args];
    const buf = execFileSync('git', fullArgs, options);
    return (buf as unknown as { toString(enc: string): string }).toString('utf8');
  } catch (err) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const raw = e.stderr ?? e.stdout ?? String(e.message ?? '');
    const detail = (typeof raw === 'string' ? raw : raw.toString('utf8')).slice(0, 500);
    throw new Error(`git ${args[0] ?? ''}: ${detail}`);
  }
}
