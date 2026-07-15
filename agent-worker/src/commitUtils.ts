/**
 * Commit collection, validation, and Change-Id injection utilities.
 *
 * Extracted from the agent worker so that:
 *  1. Functions can be imported directly by tests (no duplication).
 *  2. The logic is covered by TypeScript strict checks.
 *
 * These run inside the agent container (committed commits in /workspace)
 * as well as on the host in unit tests against real temp git repos.
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import type { CommitDescriptor, RepositoryMap } from '../../src/interfaces.js';

const CONVENTIONAL_COMMIT_RE =
  /^(feat|fix|refactor|test|chore|docs|perf|ci|build)(\([^)]+\))?: .{1,72}$/;

// ── Internal git helper (not exported — consumers supply their own) ────────────
function git(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const detail = (e.stderr ?? e.stdout ?? e.message ?? '').slice(0, 500);
    throw new Error(`git ${args[0] ?? ''}: ${detail}`);
  }
}

// ── Exported utilities ────────────────────────────────────────────────────────

/**
 * Read all commits from baseSha..HEAD (oldest → newest).
 * Returns an array of CommitDescriptor objects.
 *
 * @param baseSha - Base commit SHA (exclusive lower bound).
 * @param cwd - Working directory for git operations.
 * @param repositoryMap - Optional multi-repo layout; used to assign repoKey.
 */
export function collectCommits(
  baseSha: string,
  cwd: string,
  repositoryMap?: RepositoryMap | undefined,
): CommitDescriptor[] {
  // NUL-delimited format: SHA%x00Subject%x00Body%x00, records separated by %x01.
  const logOutput = git(
    ['log', '--reverse', '--format=%H%x00%s%x00%b%x00', `${baseSha}..HEAD`],
    cwd,
  );

  const commits: CommitDescriptor[] = [];
  const records = logOutput.split('\0\n').filter((r) => r.trim());

  for (const record of records) {
    const parts = record.split('\0');
    if (parts.length < 3) continue;

    const sha = (parts[0] ?? '').trim();
    const rawSubject = parts[1] ?? '';
    // Strip literal \n escape sequences and take only the first line.
    const subject = rawSubject.replace(/\\n[\s\S]*/g, '').split('\n')[0]?.trim() ?? '';
    const body = (parts[2] ?? '').trim();

    if (!sha) continue;

    const changeIdMatch = /^Change-Id:\s+(I[0-9a-f]{40})\s*$/m.exec(body);
    const changeId = changeIdMatch ? (changeIdMatch[1] ?? '') : '';

    // --root handles root commits; fallback diffs against baseSha if empty.
    const diffOutput = git(
      ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', sha],
      cwd,
    );
    let files = diffOutput.split('\n').map((f) => f.trim()).filter(Boolean);
    if (files.length === 0) {
      try {
        const fallback = git(['diff', '--name-only', baseSha, sha], cwd);
        files = fallback.split('\n').map((f) => f.trim()).filter(Boolean);
      } catch { /* ignore */ }
    }

    // Assign repoKey from repositoryMap if available.
    let repoKey = 'superproject';
    if (repositoryMap != null) {
      const submodules = repositoryMap.submodules;
      const repoKeys = new Set<string>();
      for (const file of files) {
        let found = false;
        for (const repo of submodules) {
          if (repo.localPath && repo.localPath !== '.' && file.startsWith(repo.localPath + '/')) {
            repoKeys.add(repo.repoKey);
            found = true;
            break;
          }
        }
        if (!found) repoKeys.add(repositoryMap.superproject.repoKey);
      }
      if (repoKeys.size === 1) {
        repoKey = repoKeys.values().next().value ?? 'superproject';
      } else if (repoKeys.size > 1) {
        process.stderr.write(
          `Warning: commit ${sha.slice(0, 8)} touches files in multiple repos ` +
          `(${[...repoKeys].join(', ')}); assigning to superproject.\n`,
        );
        repoKey = repositoryMap.superproject.repoKey;
      }
    }

    commits.push({ repoKey, sha, subject, body, changeId, files });
  }

  return commits;
}

/**
 * Validate an array of CommitDescriptors against the multi-commit protocol rules:
 * - Count ≤ maxCommits (default 10)
 * - Each subject matches Conventional Commits format
 * - Each commit has a non-empty diff (at least one file)
 */
export function validateCommits(
  commits: Pick<CommitDescriptor, 'sha' | 'subject' | 'files'>[],
  maxCommits = 10,
): { valid: boolean; reason?: string | undefined } {
  if (commits.length === 0) {
    return { valid: false, reason: 'no commits found in baseSha..HEAD range' };
  }

  if (commits.length > maxCommits) {
    return {
      valid: false,
      reason: `too many commits: ${commits.length} exceeds MAX_COMMITS_PER_CYCLE (${maxCommits})`,
    };
  }

  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    if (!c) continue;

    if (!CONVENTIONAL_COMMIT_RE.test(c.subject)) {
      return {
        valid: false,
        reason: `commit ${i + 1}/${commits.length} (${c.sha.slice(0, 8)}) has non-conventional subject: "${c.subject}"`,
      };
    }

    if (c.files.length === 0) {
      return {
        valid: false,
        reason: `commit ${i + 1}/${commits.length} (${c.sha.slice(0, 8)}) has empty diff`,
      };
    }
  }

  return { valid: true };
}

/**
 * Generate a deterministic Gerrit-style Change-Id.
 * Formula: "I" + sha1("ve:" + taskId + ":" + repoKey + ":" + index + ":" + subject)
 * The commit index prevents collisions when two commits have identical subjects.
 */
export function deriveChangeId(
  taskId: string,
  repoKey: string,
  index: number,
  subject: string,
): string {
  const hash = createHash('sha1')
    .update(`ve:${taskId}:${repoKey}:${index}:${subject}`)
    .digest('hex');
  return `I${hash}`;
}

/**
 * Resolve the existing Change-Id for a given repo and commit index.
 * Supports two formats:
 *  - Legacy flat: `{ "repo": "I1234..." }` → only index 0
 *  - Indexed map: `{ "repo": { "0": "I1234...", "1": "I5678..." } }` → any index
 */
export function resolveExistingChangeId(
  perRepoChangeIds: Record<string, string | Record<string, string>>,
  repoKey: string,
  commitIndex: number,
): string | null {
  const entry = perRepoChangeIds[repoKey];
  if (!entry) return null;
  if (typeof entry === 'string') {
    return commitIndex === 0 ? entry : null;
  }
  return entry[String(commitIndex)] ?? null;
}

/** Options for injectChangeIds. */
export interface InjectChangeIdsOptions {
  /** Legacy single Change-Id for the first commit (ROOT_CHANGE_ID compatibility). */
  existingChangeId?: string | null | undefined;
  /** Repo key used to look up per-index Change-Ids in perRepoChangeIds. */
  repoKeyForLookup?: string | null | undefined;
  /** Full PER_REPO_CHANGE_IDS map from the orchestrator env. */
  perRepoChangeIds?: Record<string, string | Record<string, string>> | null | undefined;
  /** Git identity for the rebase environment (falls back to process.env). */
  gitAuthorName?: string | undefined;
  gitAuthorEmail?: string | undefined;
  gitCommitterName?: string | undefined;
  gitCommitterEmail?: string | undefined;
  /**
   * Optional pre-formatted ticket-footer trailer line (e.g. "GitLab: https://…/issues/123")
   * appended to every commit alongside its Change-Id. Skipped if already present in the
   * commit message (idempotent across retries).
   */
  ticketFooterLine?: string | null | undefined;
}

/**
 * Inject deterministic Change-Id footers into agent-created commits that lack one.
 * Uses `git rebase -i` with GIT_SEQUENCE_EDITOR to rewrite each commit message.
 *
 * @param baseSha - The commit before the agent's first commit.
 * @param commits - Pre-collected CommitDescriptor array.
 * @param taskId - Used to derive new Change-Ids.
 * @param cwd - Working directory for git operations.
 * @param options - Optional overrides for Change-Id reuse and git identity.
 * @returns Updated CommitDescriptor array with changeId fields populated.
 */
export function injectChangeIds(
  baseSha: string,
  commits: CommitDescriptor[],
  taskId: string,
  cwd: string,
  options?: InjectChangeIdsOptions | undefined,
): CommitDescriptor[] {
  if (commits.length === 0) return commits;

  const needsInjection = commits.some((c) => !c.changeId);
  if (!needsInjection) return commits;

  const existingChangeId = options?.existingChangeId ?? null;
  const repoKeyForLookup = options?.repoKeyForLookup ?? null;
  const perRepoChangeIds = options?.perRepoChangeIds ?? null;
  const gitAuthorName = options?.gitAuthorName ?? process.env['GIT_AUTHOR_NAME'] ?? '';
  const gitAuthorEmail = options?.gitAuthorEmail ?? process.env['GIT_AUTHOR_EMAIL'] ?? '';
  const gitCommitterName = options?.gitCommitterName ?? process.env['GIT_COMMITTER_NAME'] ?? gitAuthorName;
  const gitCommitterEmail = options?.gitCommitterEmail ?? process.env['GIT_COMMITTER_EMAIL'] ?? gitAuthorEmail;
  const ticketFooterLine = options?.ticketFooterLine ?? null;

  // Map: commit index → desired Change-Id for commits that lack one.
  const changeIdByIndex: Record<number, string> = {};
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    if (c && !c.changeId) {
      const perIndexId = (perRepoChangeIds && repoKeyForLookup)
        ? resolveExistingChangeId(perRepoChangeIds, repoKeyForLookup, i)
        : null;
      const legacyId = (i === 0 && existingChangeId) ? existingChangeId : null;
      changeIdByIndex[i] = perIndexId ?? legacyId ?? deriveChangeId(taskId, c.repoKey, i, c.subject);
    }
  }

  // Build a minimal env for git rebase (only what is strictly required).
  const gitEnv: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
    GIT_SEQUENCE_EDITOR: "sed -i 's/^pick /edit /g'",
  };
  if (gitAuthorName) gitEnv['GIT_AUTHOR_NAME'] = gitAuthorName;
  if (gitAuthorEmail) gitEnv['GIT_AUTHOR_EMAIL'] = gitAuthorEmail;
  if (gitCommitterName) gitEnv['GIT_COMMITTER_NAME'] = gitCommitterName;
  if (gitCommitterEmail) gitEnv['GIT_COMMITTER_EMAIL'] = gitCommitterEmail;

  try {
    execFileSync('git', ['rebase', '-i', baseSha], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: gitEnv,
    });
  } catch {
    // rebase -i stops at the first commit — this is expected
  }

  try {
    for (let i = 0; i < commits.length; i++) {
      const desiredChangeId = changeIdByIndex[i] ?? null;

      if (desiredChangeId || ticketFooterLine) {
        const currentMsg = git(['log', '-1', '--format=%B'], cwd).trim();
        let newMsg = currentMsg;

        if (ticketFooterLine && !newMsg.includes(ticketFooterLine)) {
          const hasTrailerBlock = /\n\n[A-Za-z][A-Za-z0-9-]*: /.test(newMsg);
          newMsg = hasTrailerBlock ? `${newMsg}\n${ticketFooterLine}` : `${newMsg}\n\n${ticketFooterLine}`;
        }

        if (desiredChangeId) {
          const hasTrailerBlock = /\n\n[A-Za-z][A-Za-z0-9-]*: /.test(newMsg);
          newMsg = hasTrailerBlock ? `${newMsg}\nChange-Id: ${desiredChangeId}` : `${newMsg}\n\nChange-Id: ${desiredChangeId}`;
        }

        if (newMsg !== currentMsg) {
          git(['commit', '--amend', '-m', newMsg], cwd);
        }
      }

      if (i < commits.length - 1) {
        try { git(['rebase', '--continue'], cwd); } catch { /* stops at next commit */ }
      } else {
        try { git(['rebase', '--continue'], cwd); } catch { /* rebase done */ }
      }
    }
  } finally {
    // Abort any in-progress rebase (e.g. due to a merge conflict) so the
    // repository is left in a clean state. Caller falls back to original commits.
    const gitDir = join(cwd, '.git');
    const rebaseMergePath = join(gitDir, 'rebase-merge');
    const rebaseApplyPath = join(gitDir, 'rebase-apply');
    if (existsSync(rebaseMergePath) || existsSync(rebaseApplyPath)) {
      try { execFileSync('git', ['rebase', '--abort'], { cwd }); } catch { /* ignore */ }
      return commits;
    }
  }

  return collectCommits(baseSha, cwd);
}

/**
 * On feedback cycles the base commit already carries a Change-Id.
 * If the agent added NEW commits on top instead of amending, squash them
 * into the base so that only one commit per Change-Id is pushed.
 *
 * @param baseSha - HEAD recorded before the agent ran.
 * @param cwd - Working directory for git operations.
 * @returns Squash result with flag and updated commits.
 */
export function squashIntoBaseIfNeeded(
  baseSha: string,
  cwd: string,
): { squashed: boolean; commits?: CommitDescriptor[] | undefined } {
  const baseBody = git(['log', '-1', '--format=%b', baseSha], cwd);
  const baseChangeIdMatch = baseBody.match(/^Change-Id:\s*(\S+)/m);
  if (!baseChangeIdMatch) {
    return { squashed: false };
  }

  const headBefore = git(['rev-parse', 'HEAD'], cwd).trim();
  if (headBefore === baseSha) {
    return { squashed: false };
  }

  try {
    git(['reset', '--soft', baseSha], cwd);
    git(['commit', '--amend', '--no-edit'], cwd);
  } catch (err) {
    try { git(['reset', '--hard', headBefore], cwd); } catch { /* ignore */ }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Warning: failed to squash feedback commits: ${msg}\n`);
    return { squashed: false };
  }

  process.stderr.write(
    `squashed feedback commits into base patchset (Change-Id: ${baseChangeIdMatch[1] ?? ''})\n`,
  );
  return { squashed: true, commits: collectCommits(baseSha, cwd) };
}

/**
 * Group a flat list of file paths into a `{ repoKey: [files] }` map based
 * on the repositoryMap's superproject and submodule localPaths.
 */
export function groupFilesByRepo(
  flatFiles: string[],
  repositoryMap: RepositoryMap,
): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  const primaryKey = repositoryMap.superproject.repoKey;
  const submodules = repositoryMap.submodules;

  for (const file of flatFiles) {
    let assigned = false;
    for (const repo of submodules) {
      if (repo.localPath && repo.localPath !== '.' && file.startsWith(repo.localPath + '/')) {
        const arr = grouped[repo.repoKey] ?? [];
        grouped[repo.repoKey] = arr;
        arr.push(file.slice(repo.localPath.length + 1));
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      const arr = grouped[primaryKey] ?? [];
      grouped[primaryKey] = arr;
      arr.push(file);
    }
  }

  return grouped;
}
