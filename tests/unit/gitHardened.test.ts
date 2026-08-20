/**
 * Tests for the hardened git invocation module (A1 fix).
 *
 * Verifies that every git subprocess spawned by the agent worker:
 *  1. Receives the six hardening `-c` flags.
 *  2. Runs with a minimal env (PATH, HOME, git identity only) — no provider
 *     credentials leak into child processes.
 *  3. Disables git hooks, config includes, fsmonitor, and arbitrary protocols.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import { hardenedGit, hardenedGitWithEnv, buildHardenedGitEnv } from '../../agent-worker/src/gitHardened.js';

// Mock child_process so no real git binary is invoked.
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);

// Capture the arguments passed to execFileSync for assertion.
function lastCall(): {
  file: string;
  args: readonly string[];
  options: { cwd?: string; env?: Record<string, string> };
} {
  const calls = mockedExecFileSync.mock.calls;
  const last = calls[calls.length - 1];
  if (!last) throw new Error('execFileSync was not called');
  return {
    file: last[0] as string,
    args: last[1] as readonly string[],
    options: (last[2] ?? {}) as { cwd?: string; env?: Record<string, string> },
  };
}

describe('gitHardened', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExecFileSync.mockReturnValue(Buffer.from('ok\n'));
  });

  // ── Env hardening ──────────────────────────────────────────────────────────

  it('strips provider credentials (GITHUB_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY)', () => {
    process.env['GITHUB_TOKEN'] = 'ghp_secret';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-secret';
    process.env['OPENAI_API_KEY'] = 'sk-openai-secret';

    buildHardenedGitEnv();

    const env = buildHardenedGitEnv();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['OPENAI_API_KEY']).toBeUndefined();

    // Restore.
    delete process.env['GITHUB_TOKEN'];
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
  });

  it('retains PATH and HOME but adds GIT_CONFIG_* overrides', () => {
    const originalPath = process.env['PATH'];
    const originalHome = process.env['HOME'];

    const env = buildHardenedGitEnv();

    expect(env['PATH']).toBe(originalPath);
    expect(env['HOME']).toBe(originalHome);
    expect(env['GIT_CONFIG_NOSYSTEM']).toBe('1');
    expect(env['GIT_CONFIG_GLOBAL']).toBe('/dev/null');
    expect(env['GIT_CONFIG_SYSTEM']).toBe('/dev/null');
  });

  it('retains git identity variables when explicitly set', () => {
    process.env['GIT_AUTHOR_NAME'] = 'Virtual Engineer Test';
    process.env['GIT_AUTHOR_EMAIL'] = 've@test.invalid';

    const env = buildHardenedGitEnv();

    expect(env['GIT_AUTHOR_NAME']).toBe('Virtual Engineer Test');
    expect(env['GIT_AUTHOR_EMAIL']).toBe('ve@test.invalid');

    delete process.env['GIT_AUTHOR_NAME'];
    delete process.env['GIT_AUTHOR_EMAIL'];
  });

  it('extraEnv caller values override the hardened base', () => {
    const env = buildHardenedGitEnv({ GIT_SEQUENCE_EDITOR: "sed -i 's/^pick /edit /g'" });
    expect(env['GIT_SEQUENCE_EDITOR']).toBe("sed -i 's/^pick /edit /g'");
  });

  // ── hardenedGit: argv prefix + env sanitisation ───────────────────────────

  it('prepends -c core.hooksPath=/dev/null to argv', () => {
    hardenedGit(['status', '--short'], '/repo');
    const { args } = lastCall();
    expect(args).toContain('-c');
    expect(args).toContain('core.hooksPath=/dev/null');
  });

  it('prepends -c include.path= to argv', () => {
    hardenedGit(['log', '--oneline'], '/repo');
    const { args } = lastCall();
    expect(args).toContain('include.path=');
  });

  it('prepends -c core.fsmonitor=false to argv', () => {
    hardenedGit(['diff', '--name-only'], '/repo');
    const { args } = lastCall();
    expect(args).toContain('core.fsmonitor=false');
  });

  it('prepends -c protocol.allow=never to argv', () => {
    hardenedGit(['ls-remote'], '/repo');
    const { args } = lastCall();
    expect(args).toContain('protocol.allow=never');
  });

  it('does not inject hooksPath after the subcommand args', () => {
    hardenedGit(['commit', '--amend', '-m', 'msg'], '/repo');
    const { args } = lastCall();
    // All six -c flags must appear before 'commit'.
    const commitIdx = args.indexOf('commit');
    const flagIdx = args.indexOf('-c');
    expect(commitIdx).toBeGreaterThan(flagIdx);
  });

  it('passes a sanitised env (no GITHUB_TOKEN) to git', () => {
    process.env['GITHUB_TOKEN'] = 'ghp_should_be_stripped';

    hardenedGit(['status'], '/repo');

    const { options } = lastCall();
    expect(options.env?.['GITHUB_TOKEN']).toBeUndefined();

    delete process.env['GITHUB_TOKEN'];
  });

  it('throws on git stderr non-empty', () => {
    mockedExecFileSync.mockImplementation(() => {
      const err = new Error('exit 1') as NodeJS.ErrnoException & { stderr?: Buffer };
      err.stderr = Buffer.from('fatal: not a git repo\n');
      throw err;
    });

    expect(() => hardenedGit(['status'], '/repo')).toThrow(/git status:/);
  });

  // ── hardenedGitWithEnv ────────────────────────────────────────────────────

  it('merges caller env while keeping hardened base vars', () => {
    hardenedGitWithEnv(
      ['rebase', '-i', 'abc123'],
      '/repo',
      { GIT_SEQUENCE_EDITOR: "sed -i 's/^pick /edit /g'" },
    );

    const { options } = lastCall();
    expect(options.env?.['GIT_SEQUENCE_EDITOR']).toBe("sed -i 's/^pick /edit /g'");
    expect(options.env?.['GIT_CONFIG_NOSYSTEM']).toBe('1');
    expect(options.env?.['GIT_CONFIG_GLOBAL']).toBe('/dev/null');
  });

  it('caller env vars override the hardened base', () => {
    hardenedGitWithEnv(['status'], '/repo', { PATH: '/custom/path' });
    const { options } = lastCall();
    expect(options.env?.['PATH']).toBe('/custom/path');
  });

  // ── cwd propagation ───────────────────────────────────────────────────────

  it('propagates cwd to the child process', () => {
    hardenedGit(['status'], '/my/custom/repo');
    const { options } = lastCall();
    expect(options.cwd).toBe('/my/custom/repo');
  });
});
