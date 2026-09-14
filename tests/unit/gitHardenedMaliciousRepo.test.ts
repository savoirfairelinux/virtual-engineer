/**
 * Regression tests against a real repository whose `.git/config` and
 * `.gitattributes` try to make git execute a helper program.
 *
 * These run a real git binary (no mocks) because the vectors under test are
 * decided by git's own config parsing, not by our argv construction.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { hardenedGit } from '../../agent-worker/src/gitHardened.js';

let repoDir: string;
let markerPath: string;

function plainGit(args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Writes a script that touches a marker file, proving git executed it. */
function installPayload(): string {
  const scriptPath = join(repoDir, 'payload.sh');
  writeFileSync(scriptPath, `#!/bin/sh\ntouch ${markerPath}\nexit 0\n`);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 've-git-malicious-'));
  markerPath = join(repoDir, 'EXECUTED');
  plainGit(['init', '--initial-branch=main']);
  plainGit(['config', 'user.name', 'Test']);
  plainGit(['config', 'user.email', 'test@test.local']);
  writeFileSync(join(repoDir, 'f.txt'), 'a\n');
  plainGit(['add', 'f.txt']);
  plainGit(['commit', '-m', 'feat: one']);
  writeFileSync(join(repoDir, 'f.txt'), 'b\n');
  plainGit(['add', 'f.txt']);
  plainGit(['commit', '-m', 'feat: two']);
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe('hardenedGit against a malicious repository config', () => {
  it('does not run diff.external declared in repo-local .git/config', () => {
    plainGit(['config', 'diff.external', installPayload()]);

    // Sanity check: an unhardened git really does execute the payload, so this
    // test would fail loudly if the mitigation were removed.
    execFileSync('git', ['diff', 'HEAD~1', 'HEAD'], { cwd: repoDir, stdio: 'ignore' });
    expect(existsSync(markerPath)).toBe(true);
    rmSync(markerPath);

    const out = hardenedGit(['diff', 'HEAD~1', 'HEAD'], repoDir);

    expect(existsSync(markerPath)).toBe(false);
    // The internal diff still works — the payload is skipped, not fatal.
    expect(out).toContain('diff --git a/f.txt b/f.txt');
  });

  it('does not run a textconv driver declared via .gitattributes', () => {
    plainGit(['config', 'diff.evil.textconv', installPayload()]);
    writeFileSync(join(repoDir, '.gitattributes'), '* diff=evil\n');

    hardenedGit(['diff', 'HEAD~1', 'HEAD'], repoDir);

    expect(existsSync(markerPath)).toBe(false);
  });

  it('does not run diff.external through git log -p', () => {
    plainGit(['config', 'diff.external', installPayload()]);

    hardenedGit(['log', '-p', '-1'], repoDir);

    expect(existsSync(markerPath)).toBe(false);
  });

  it('does not run a repo-configured gpg.program when committing', () => {
    plainGit(['config', 'commit.gpgsign', 'true']);
    plainGit(['config', 'gpg.program', installPayload()]);

    writeFileSync(join(repoDir, 'f.txt'), 'c\n');
    hardenedGit(['add', 'f.txt'], repoDir);
    hardenedGit(['commit', '-m', 'feat: three'], repoDir);

    expect(existsSync(markerPath)).toBe(false);
  });

  it('does not run a repo-local hook', () => {
    const hooksDir = join(repoDir, '.git', 'hooks');
    const hookPath = join(hooksDir, 'pre-commit');
    writeFileSync(hookPath, `#!/bin/sh\ntouch ${markerPath}\nexit 0\n`);
    chmodSync(hookPath, 0o755);

    writeFileSync(join(repoDir, 'f.txt'), 'd\n');
    hardenedGit(['add', 'f.txt'], repoDir);
    hardenedGit(['commit', '-m', 'feat: four'], repoDir);

    expect(existsSync(markerPath)).toBe(false);
  });

  it('leaves non-diff subcommands free of diff-only flags', () => {
    // `status` / `commit` reject --no-ext-diff, so the wrapper must not add it.
    expect(() => hardenedGit(['status', '--short'], repoDir)).not.toThrow();
    expect(hardenedGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir).trim()).toBe('main');
  });
});
