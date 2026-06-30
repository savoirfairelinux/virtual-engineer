#!/usr/bin/env node
'use strict';

/**
 * Virtual Engineer — Agent Worker (Copilot SDK)
 *
 * This script runs INSIDE the Docker container for each task cycle.
 * The repository is pre-cloned by the host orchestrator and mounted at /workspace.
 * This worker is responsible ONLY for code generation.
 * It has no VCS credentials, does not clone, and never pushes.
 *
 * It receives task context via environment variables, then:
 *   1. Opens a GitHub Copilot SDK session against the pre-cloned repository
 *   2. Sends the task prompt — the CLI agent edits files autonomously
 *   3. Collects agent-created commits
 *   4. Writes a JSON AgentResult object to stdout (status, modifiedFiles, commits, summary)
 *
 * The host orchestrator (WorkspaceRunner + VcsConnector) handles:
 *   - Repository clone (before this worker runs)
 *   - Push to Gerrit / GitLab (after this worker exits)
 *
 * Authentication: GITHUB_TOKEN env var (for Copilot LLM calls only).
 * CLI: The Copilot SDK manages the CLI process lifecycle automatically.
 */

const { CopilotClient, approveAll } = require('@github/copilot-sdk');
const { execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const { existsSync } = require('fs');
const net = require('net');
const { join } = require('path');

// ── environment ───────────────────────────────────────────────────────────────
const GITHUB_TOKEN        = process.env.GITHUB_TOKEN        || '';
const COPILOT_MODEL       = process.env.COPILOT_MODEL       || 'auto';
const COPILOT_REASONING_EFFORT = process.env.COPILOT_REASONING_EFFORT || undefined;
const GIT_AUTHOR_NAME     = process.env.GIT_AUTHOR_NAME     || 'Virtual Engineer';
const GIT_AUTHOR_EMAIL    = process.env.GIT_AUTHOR_EMAIL    || 've@virtual-engineer.local';
const GIT_COMMITTER_NAME  = process.env.GIT_COMMITTER_NAME  || GIT_AUTHOR_NAME;
const GIT_COMMITTER_EMAIL = process.env.GIT_COMMITTER_EMAIL || GIT_AUTHOR_EMAIL;
const TASK_ID             = process.env.TASK_ID             || '';
const MAX_COMMITS_PER_CYCLE = Number(process.env.MAX_COMMITS_PER_CYCLE) || 10;
/** Shareable deep link to this task's Virtual Engineer admin page; injected as a commit trailer. */
const VE_TASK_PAGE_URL    = process.env.VE_TASK_PAGE_URL    || '';
/** Change-Id to reuse for the root-repo's first commit on retry cycles (preserves Gerrit patchset continuity). */
const ROOT_CHANGE_ID = process.env.ROOT_CHANGE_ID || null;
/** Per-repo Change-Ids to reuse on retry cycles, keyed by repoKey (JSON object or null). */
let PER_REPO_CHANGE_IDS = null;
try {
  const raw = process.env.PER_REPO_CHANGE_IDS_JSON || '';
  if (raw) PER_REPO_CHANGE_IDS = JSON.parse(raw);
} catch (_) {
  process.stderr.write('Warning: failed to parse PER_REPO_CHANGE_IDS_JSON\n');
}
const REVIEW_MODE = process.env.REVIEW_MODE === '1';
const USER_PROMPT_FILE = process.env.USER_PROMPT_FILE || '';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || '';

if (!process.env.SYSTEM_PROMPT) {
  process.stderr.write('FATAL: SYSTEM_PROMPT env var is required but was not set. '
    + 'Ensure the orchestrator injects a prompt before launching this container.\n');
  process.exit(1);
}
if (!USER_PROMPT_FILE) {
  process.stderr.write('FATAL: USER_PROMPT_FILE env var is required but was not set. '
    + 'Ensure the orchestrator writes the prompt file before launching this container.\n');
  process.exit(1);
}

// ── Structured event emitter ──────────────────────────────────────────────────
// Writes a JSON event line to stderr that the host-side adapter parses.
// Used by both codegen and review modes.
function emitEvent(type, data) {
  process.stderr.write(JSON.stringify({ __ve_event: true, type, data, ts: new Date().toISOString() }) + '\n');
}

// Multi-repository context: when defined, agent should be aware of available repositories
// and return repo-grouped results: { "repoKey": ["file1.ts", "file2.ts"], ... }
// When undefined, agent returns flat file list (backward compat): ["file1.ts", ...]
let REPOSITORY_MAP = undefined;
try {
  const repositoryMapJson = process.env.REPOSITORY_MAP_JSON || '';
  if (repositoryMapJson) {
    REPOSITORY_MAP = JSON.parse(repositoryMapJson);
  }
} catch (err) {
  process.stderr.write(`Warning: Failed to parse REPOSITORY_MAP_JSON: ${err.message}\n`);
}

// The host pre-clones the repository at /workspace before this worker starts.
// No VCS credentials are available inside the container.
const WORKSPACE = '/workspace';
const REPO_PATH = WORKSPACE; // repo root is mounted directly at /workspace

// ── git helper ────────────────────────────────────────────────────────────────
function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd: cwd || REPO_PATH,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message || '').slice(0, 500);
    throw new Error(`git ${args[0]}: ${detail}`);
  }
}

function waitForPort(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const attempt = () => {
      const socket = net.createConnection({ host, port });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for Copilot CLI server on ${host}:${port}`));
          return;
        }
        setTimeout(attempt, 250);
      });
    };

    attempt();
  });
}

async function startLocalCliServer() {
  const cliPath = '/agent-worker/node_modules/.bin/copilot';
  const port = 3000;
  const stdoutChunks = [];
  const stderrChunks = [];

  // Environment Variable Allowlist (Security):
  // Subprocess has only whitelisted env vars to prevent secrets leakage to Docker containers.
  // This prevents the container from accessing:
  // - Database credentials (DB_HOST, DB_USER, DB_PASSWORD)
  // - API tokens for third-party services (GERRIT_TOKEN, REDMINE_API_KEY)
  // - Admin secrets (ADMIN_SECRET_KEY)
  // Only GITHUB_TOKEN is passed (needed for Copilot LLM API).
  // GIT_*_NAME/EMAIL are passed so shell-tool git commands inherit identity.
  // PATH, HOME, TMPDIR, TMP, TEMP, USER, XDG_RUNTIME_DIR are required for basic execution.
  const child = spawn(cliPath, ['--headless', '--port', String(port)], {
    cwd: REPO_PATH,
    env: {
      GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
      GIT_AUTHOR_NAME: GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: GIT_COMMITTER_NAME,
      GIT_COMMITTER_EMAIL: GIT_COMMITTER_EMAIL,
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      TMPDIR: process.env.TMPDIR || '',
      TMP: process.env.TMP || '',
      TEMP: process.env.TEMP || '',
      USER: process.env.USER || '',
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => stdoutChunks.push(String(chunk)));
  child.stderr.on('data', (chunk) => stderrChunks.push(String(chunk)));

  try {
    await waitForPort('127.0.0.1', port, 30_000);
  } catch (err) {
    child.kill('SIGTERM');
    const detail = `${stdoutChunks.join('')}\n${stderrChunks.join('')}`.trim();
    throw new Error(
      `Failed to start local Copilot CLI server: ${err.message}${detail ? `\n${detail}` : ''}`
    );
  }

  return {
    child,
    cliUrl: `127.0.0.1:${port}`,
  };
}



// ── unified session runner ────────────────────────────────────────────────────
/**
 * Start a local headless CLI, open a Copilot session, and send the user prompt.
 * Used by both codegen and review modes — the only difference is post-processing.
 */
async function runSession(userPrompt) {
  const localCliServer = await startLocalCliServer();
  const client = new CopilotClient({ cliUrl: localCliServer.cliUrl });

  try {
    const session = await client.createSession({
      model: COPILOT_MODEL,
      // 'none' means explicitly disable reasoning; omit the field entirely (SDK only accepts low/medium/high/xhigh)
      ...(COPILOT_REASONING_EFFORT && COPILOT_REASONING_EFFORT !== 'none' ? { reasoningEffort: COPILOT_REASONING_EFFORT } : {}),
      systemMessage: { content: SYSTEM_PROMPT },
      onPermissionRequest: approveAll,
      workingDirectory: WORKSPACE,
      infiniteSessions: { enabled: false },
    });
    registerSessionEventHandlers(session);
    return { session, client, localCliServer };
  } catch (err) {
    await client.stop().catch(() => {});
    if (localCliServer?.child) localCliServer.child.kill('SIGTERM');
    throw err;
  }
}
// ── commit collection & validation ────────────────────────────────────────────

const CONVENTIONAL_COMMIT_RE = /^(feat|fix|refactor|test|chore|docs|perf|ci|build)(\([^)]+\))?: .{1,72}$/;

/**
 * Read all commits from baseSha..HEAD (oldest → newest).
 * Returns an array of CommitDescriptor objects.
 * @param {string} baseSha - The base commit SHA
 * @param {string} [cwd] - Optional working directory (for sub-repos)
 */
function collectCommits(baseSha, cwd) {
  // Use NUL-delimited format for safe parsing of multi-line bodies.
  // Format: SHA%x00Subject%x00Body%x00 (separator between records: %x01)
  const logOutput = git([
    'log',
    '--reverse',
    '--format=%H%x00%s%x00%b%x00',
    `${baseSha}..HEAD`,
  ], cwd);

  const commits = [];
  // Each record ends with \0, split on that.
  const records = logOutput.split('\0\n').filter((r) => r.trim());

  for (const record of records) {
    const parts = record.split('\0');
    if (parts.length < 3) continue;

    const sha = parts[0].trim();
    // Sanitize subject: strip literal \n escape sequences (produced by `git commit -m "...\n..."`
    // in bash where \n is not interpreted as a real newline) and take only the first line.
    const rawSubject = parts[1] ?? '';
    const subject = rawSubject.replace(/\\n[\s\S]*/g, '').split('\n')[0].trim();
    const body = parts[2].trim();

    if (!sha) continue;

    // Extract Change-Id from the commit body footer
    const changeIdMatch = /^Change-Id:\s+(I[0-9a-f]{40})\s*$/m.exec(body);
    const changeId = changeIdMatch ? changeIdMatch[1] : '';

    // Get files changed in this commit.
    // --root handles true root commits (no parent).
    // Fallback: if diff-tree returns nothing (e.g. the parent is beyond the
    // shallow-clone boundary after a patchset checkout), diff against baseSha
    // directly — both refs are guaranteed to be present in the local store.
    const diffOutput = git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', sha], cwd);
    let files = diffOutput.split('\n').map((f) => f.trim()).filter(Boolean);
    if (files.length === 0) {
      try {
        const fallback = git(['diff', '--name-only', baseSha, sha], cwd);
        files = fallback.split('\n').map((f) => f.trim()).filter(Boolean);
      } catch (_) { /* ignore, leave files empty */ }
    }

    // Determine repoKey based on file paths using the REPOSITORY_MAP
    // (superproject + submodules with localPath).
    let repoKey = 'superproject';
    if (REPOSITORY_MAP && typeof REPOSITORY_MAP === 'object') {
      const submodules = Array.isArray(REPOSITORY_MAP.submodules) ? REPOSITORY_MAP.submodules : [];
      const repoKeys = new Set();
      for (const file of files) {
        let found = false;
        for (const repo of submodules) {
          if (repo.localPath && repo.localPath !== '.' && file.startsWith(repo.localPath + '/')) {
            repoKeys.add(repo.repoKey);
            found = true;
            break;
          }
        }
        if (!found) repoKeys.add(REPOSITORY_MAP.superproject?.repoKey || 'superproject');
      }
      if (repoKeys.size === 1) {
        repoKey = repoKeys.values().next().value;
      } else if (repoKeys.size > 1) {
        process.stderr.write(
          `Warning: commit ${sha.slice(0, 8)} touches files in multiple repos (${[...repoKeys].join(', ')}); ` +
          `assigning to superproject. Split changes into per-repo commits for correct Change-Id tracking.\n`
        );
        repoKey = REPOSITORY_MAP.superproject?.repoKey || 'superproject';
      }
    }

    commits.push({ repoKey, sha, subject, body, changeId, files });
  }

  return commits;
}

/**
 * Validate an array of CommitDescriptors against the multi-commit protocol rules:
 * - Count ≤ MAX_COMMITS_PER_CYCLE
 * - Each subject matches Conventional Commits format
 * - Each commit has a non-empty diff (at least one file)
 */
function validateCommits(commits) {
  if (commits.length === 0) {
    return { valid: false, reason: 'no commits found in baseSha..HEAD range' };
  }

  if (commits.length > MAX_COMMITS_PER_CYCLE) {
    return {
      valid: false,
      reason: `too many commits: ${commits.length} exceeds MAX_COMMITS_PER_CYCLE (${MAX_COMMITS_PER_CYCLE})`,
    };
  }

  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];

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
 * Generate a deterministic Gerrit-style Change-Id from task, repo, index, and subject.
 * Formula: "I" + sha1("ve:" + taskId + ":" + repoKey + ":" + index + ":" + subject)
 * Including the commit index prevents Change-Id collisions when two commits in the
 * same task/repo have identical subjects.
 */
function deriveChangeId(taskId, repoKey, index, subject) {
  const hash = crypto
    .createHash('sha1')
    .update(`ve:${taskId}:${repoKey}:${index}:${subject}`)
    .digest('hex');
  return `I${hash}`;
}

/**
 * Resolve the existing Change-Id for a given repo and commit index from PER_REPO_CHANGE_IDS.
 * Supports two formats:
 * - Legacy flat: { "repo": "I1234..." } → only index 0
 * - Indexed map: { "repo": { "0": "I1234...", "1": "I5678..." } } → any index
 * @param {string} repoKey - The repository key.
 * @param {number} commitIndex - The commit index (0-based).
 * @returns {string|null} The Change-Id to reuse, or null.
 */
function resolveExistingChangeId(repoKey, commitIndex) {
  if (!PER_REPO_CHANGE_IDS) return null;
  const entry = PER_REPO_CHANGE_IDS[repoKey];
  if (!entry) return null;
  if (typeof entry === 'string') {
    // Legacy flat format: only valid for index 0
    return commitIndex === 0 ? entry : null;
  }
  if (typeof entry === 'object') {
    // Indexed map format: lookup by string index
    return entry[String(commitIndex)] || null;
  }
  return null;
}

/**
 * On feedback cycles the orchestrator checks out the prior patchset before
 * the agent runs, so baseSha already carries a Change-Id footer.  If the agent
 * added NEW commits on top instead of amending, the push chain would contain
 * two commits with the same Change-Id and Gerrit would reject.
 *
 * This function detects that situation and squashes all agent commits into the
 * base patchset commit so only one commit per Change-Id is pushed.
 *
 * @param {string} baseSha  – HEAD recorded before the agent ran.
 * @param {string} [cwd]    – working directory (for sub-repos).
 * @returns {{ squashed: boolean, commits?: Array }} squashed flag + re-collected commits.
 */
function squashIntoBaseIfNeeded(baseSha, cwd) {
  const repoCwd = cwd || REPO_PATH;
  const baseBody = git(['log', '-1', '--format=%b', baseSha], repoCwd);
  const baseChangeIdMatch = baseBody.match(/^Change-Id:\s*(\S+)/m);
  if (!baseChangeIdMatch) {
    return { squashed: false };
  }

  // baseSha already owns a Change-Id — squash agent commits into it.
  const headBefore = git(['rev-parse', 'HEAD'], repoCwd).trim();
  if (headBefore === baseSha) {
    // Agent did not create any new commits (amend case already handled).
    return { squashed: false };
  }

  try {
    git(['reset', '--soft', baseSha], repoCwd);
    git(['commit', '--amend', '--no-edit'], repoCwd);
  } catch (err) {
    // Restore HEAD on failure so the original commits are preserved.
    try { git(['reset', '--hard', headBefore], repoCwd); } catch { /* ignore */ }
    process.stderr.write(`Warning: failed to squash feedback commits: ${err.message}\n`);
    return { squashed: false };
  }

  process.stderr.write(
    `squashed feedback commits into base patchset (Change-Id: ${baseChangeIdMatch[1]})\n`
  );
  return { squashed: true, commits: collectCommits(baseSha, cwd) };
}

/**
 * Append (or converge) a `Key: value` trailer in a commit message.
 *
 * If the key is absent it is appended; a blank line is inserted before it only
 * when the message does not already end with a trailer block, so all trailers
 * stay grouped in the final paragraph. If the key is already present, the line
 * is left untouched when the value matches and rewritten in place when it
 * differs — so a trailer always converges to the desired value (e.g. after
 * `PUBLIC_BASE_URL` changes between runs) rather than being silently stale.
 *
 * Note: callers that must preserve an existing value (e.g. Gerrit `Change-Id`)
 * already guard against calling this when the key is present.
 *
 * @param {string} msg - The current commit message.
 * @param {string} key - The trailer key (e.g. "Change-Id", "Virtual-Engineer").
 * @param {string} value - The trailer value.
 * @returns {string} The message with the trailer appended, updated, or unchanged.
 */
function appendCommitTrailer(msg, key, value) {
  const existing = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm');
  const match = existing.exec(msg);
  if (match) {
    if (match[1].trim() === value) return msg;
    // Use a replacer function so `$` sequences in the value are not treated as
    // special replacement patterns.
    return msg.replace(existing, () => `${key}: ${value}`);
  }
  const hasTrailerBlock = /\n\n[A-Za-z][A-Za-z0-9-]*: /.test(msg);
  return hasTrailerBlock ? `${msg}\n${key}: ${value}` : `${msg}\n\n${key}: ${value}`;
}

/**
 * Inject deterministic commit-message trailers into agent-created commits.
 *
 * Adds a Gerrit-style `Change-Id` footer (for patchset continuity) and a
 * `Virtual-Engineer` footer (a shareable deep link back to the task's admin
 * page) to every commit that lacks them. Uses `git rebase` with
 * `GIT_SEQUENCE_EDITOR` to rewrite each commit.
 *
 * @param {string} baseSha - The commit before the agent's first commit.
 * @param {Array} commits - The collected CommitDescriptor array (pre-injection).
 * @param {string} [cwd] - Optional working directory (for sub-repos).
 * @param {string|null} existingChangeId - Legacy single Change-Id for commit 0 (ROOT_CHANGE_ID compat).
 * @param {string} [repoKeyForLookup] - Repo key used to resolve per-index Change-Ids from PER_REPO_CHANGE_IDS.
 * @returns {Array} Updated commits array with changeId fields populated.
 */
function injectCommitTrailers(baseSha, commits, cwd, existingChangeId = null, repoKeyForLookup = null) {
  if (commits.length === 0) return commits;

  const repoCwd = cwd || REPO_PATH;

  // Determine which trailers are still missing across the commit set.
  // A commit needs the Virtual-Engineer trailer when it has no `Virtual-Engineer:`
  // trailer line, or one whose value differs from the desired URL. We parse the
  // trailer key/value rather than substring-matching the body, so a URL that only
  // appears in free text is not a false "already present" and a stale trailer is
  // converged to the new value (mirrors appendCommitTrailer's behaviour).
  const needsChangeId = commits.some((c) => !c.changeId);
  const needsVeTrailer = Boolean(VE_TASK_PAGE_URL) && commits.some((c) => {
    const m = /^Virtual-Engineer:[ \t]*(.*)$/m.exec(c.body || '');
    return !m || m[1].trim() !== VE_TASK_PAGE_URL;
  });
  if (!needsChangeId && !needsVeTrailer) return commits;

  // Build a map of commit index → desired Change-Id for commits that lack one.
  // For each commit, reuse the existing Change-Id from the prior cycle when available
  // (either from legacy existingChangeId param for index 0, or from PER_REPO_CHANGE_IDS
  // indexed lookup for any index). This ensures all commits produce new patchsets on
  // their existing Gerrit changes rather than creating brand-new changes.
  const changeIdByIndex = {};
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    if (!c.changeId) {
      // Priority: 1) per-index lookup from PER_REPO_CHANGE_IDS, 2) legacy existingChangeId (index 0 only), 3) derive new
      const perIndexId = repoKeyForLookup ? resolveExistingChangeId(repoKeyForLookup, i) : null;
      const legacyId = (i === 0 && existingChangeId) ? existingChangeId : null;
      changeIdByIndex[i] = perIndexId || legacyId || deriveChangeId(TASK_ID, c.repoKey, i, c.subject);
    }
  }

  // Use interactive rebase to amend each commit message.
  // GIT_SEQUENCE_EDITOR replaces all "pick" with "edit" so we get control at each commit.
  // Rebase processes commits in oldest-first order, same as collectCommits — so loop index
  // i directly corresponds to commits[i].
  try {
    execFileSync('git', ['rebase', '-i', baseSha], {
      cwd: repoCwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '',
        GIT_AUTHOR_NAME,
        GIT_AUTHOR_EMAIL,
        GIT_COMMITTER_NAME,
        GIT_COMMITTER_EMAIL,
        GIT_SEQUENCE_EDITOR: "sed -i 's/^pick /edit /g'",
      },
    });
  } catch {
    // rebase -i stops at the first commit — this is expected
  }

  try {
    // Process each stopped commit — i corresponds to commits[i] (oldest-first)
    for (let i = 0; i < commits.length; i++) {
      const desiredChangeId = changeIdByIndex[i] ?? null;

      // Read current message and append any missing deterministic trailers.
      let newMsg = git(['log', '-1', '--format=%B'], repoCwd).trim();
      let changed = false;

      if (desiredChangeId && !/^Change-Id:\s/m.test(newMsg)) {
        newMsg = appendCommitTrailer(newMsg, 'Change-Id', desiredChangeId);
        changed = true;
      }

      if (VE_TASK_PAGE_URL) {
        const withVe = appendCommitTrailer(newMsg, 'Virtual-Engineer', VE_TASK_PAGE_URL);
        if (withVe !== newMsg) {
          newMsg = withVe;
          changed = true;
        }
      }

      if (changed) {
        git(['commit', '--amend', '-m', newMsg], repoCwd);
      }

      // Continue rebase to next commit (or finish)
      if (i < commits.length - 1) {
        try {
          git(['rebase', '--continue'], repoCwd);
        } catch {
          // Expected: stops at next commit
        }
      } else {
        // Final commit — complete the rebase
        try {
          git(['rebase', '--continue'], repoCwd);
        } catch {
          // Rebase is done
        }
      }
    }
  } finally {
    // If the rebase is still in progress (e.g. due to a merge conflict), abort it
    // so the repository is left in a clean state. The caller falls back to the
    // original commits (no trailer injection) which the host handles gracefully.
    const gitDir = join(repoCwd, '.git');
    const rebaseMergePath = join(gitDir, 'rebase-merge');
    const rebaseApplyPath = join(gitDir, 'rebase-apply');
    if (existsSync(rebaseMergePath) || existsSync(rebaseApplyPath)) {
      try { execFileSync('git', ['rebase', '--abort'], { cwd: repoCwd }); } catch { /* ignore */ }
      return commits;
    }
  }

  // Re-collect commits with updated SHAs and Change-Ids
  return collectCommits(baseSha, cwd);
}

/**
 * Group a flat list of file paths into a { repoKey: [files] } map
 * based on REPOSITORY_MAP repository objects (superproject + submodules).
 * REPOSITORY_MAP.selected is a string[] of repoKeys — not objects — so we
 * iterate the actual Repository objects in superproject / submodules.
 */
function groupFilesByRepo(flatFiles) {
  const grouped = {};
  const primaryKey = (REPOSITORY_MAP && REPOSITORY_MAP.superproject?.repoKey) || 'superproject';
  const submodules = (REPOSITORY_MAP && Array.isArray(REPOSITORY_MAP.submodules))
    ? REPOSITORY_MAP.submodules
    : [];

  for (const file of flatFiles) {
    let assigned = false;
    // Check each submodule's localPath to see if this file belongs to it
    for (const repo of submodules) {
      if (repo.localPath && repo.localPath !== '.' && file.startsWith(repo.localPath + '/')) {
        if (!grouped[repo.repoKey]) grouped[repo.repoKey] = [];
        // Strip the localPath prefix so files are relative within the submodule
        grouped[repo.repoKey].push(file.slice(repo.localPath.length + 1));
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      if (!grouped[primaryKey]) grouped[primaryKey] = [];
      grouped[primaryKey].push(file);
    }
  }
  return grouped;
}

// ── SDK event field extraction helpers ──────────────────────────────────────
// The Copilot SDK emits events with varying nested structures.
// These helpers search deeply to find the actual values.
// Defined at module scope so both codegen (main) and review modes share them.

function deepFindStr(obj, keys) {
  const seen = new Set();

  function visit(value) {
    if (!value || typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);

    for (const k of keys) {
      if (typeof value[k] === 'string' && value[k].trim()) return value[k];
    }

    for (const nested of Object.values(value)) {
      const found = visit(nested);
      if (found !== null) return found;
    }

    return null;
  }

  return visit(obj);
}

function deepFindNum(obj, keys) {
  const seen = new Set();

  function visit(value) {
    if (!value || typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);

    for (const k of keys) {
      if (typeof value[k] === 'number' && Number.isFinite(value[k])) return value[k];
    }

    for (const nested of Object.values(value)) {
      const found = visit(nested);
      if (found !== null) return found;
    }

    return null;
  }

  return visit(obj);
}

function extractToolName(e) {
  return deepFindStr(e, ['name', 'toolName', 'tool_name']) || 'unknown_tool';
}

function parseToolInputValue(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : { command: trimmed };
  } catch {
    return { command: trimmed };
  }
}

function extractToolInput(e) {
  return parseToolInputValue(
    e?.input ?? e?.tool?.input ?? e?.toolCall?.input ?? e?.arguments ?? e?.toolCall?.function?.arguments ?? {}
  );
}

function formatToolLabel(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return toolName;
  const filePath = toolInput.path ?? toolInput.file_path ?? toolInput.target_file ?? toolInput.filePath;
  if (typeof filePath === 'string' && filePath.trim()) {
    return `${toolName}(${filePath.trim()})`;
  }
  const command = toolInput.command ?? toolInput.cmd;
  if (typeof command === 'string' && command.trim()) {
    return `${toolName}(${command.trim()})`;
  }
  const pattern = toolInput.pattern ?? toolInput.query ?? toolInput.regex;
  if (typeof pattern === 'string' && pattern.trim()) {
    return `${toolName}(${pattern.trim()})`;
  }
  return toolName;
}

/**
 * Register live-progress SDK event handlers on a session.
 * Used by both codegen and review modes so agent activity streams to the
 * host via structured stderr events.
 * Returns an object with a `toolCallCount` property for heartbeat logging.
 */
function registerSessionEventHandlers(session) {
  const state = { toolCallCount: 0, toolsByKind: {} };
  const toolTimers = {};

  session.on('tool.execution_start', (e) => {
    state.toolCallCount++;
    const toolName = extractToolName(e);
    const toolInput = extractToolInput(e);
    const label = formatToolLabel(toolName, toolInput);
    const callId = `${toolName}_${state.toolCallCount}`;
    toolTimers[callId] = Date.now();
    // Track per-tool-name counts for diagnostics
    state.toolsByKind[toolName] = (state.toolsByKind[toolName] || 0) + 1;
    process.stderr.write(`[tool] #${state.toolCallCount} ${label}\n`);
    emitEvent('tool.execution_start', { name: toolName, input: toolInput, callId, callNumber: state.toolCallCount });
  });
  session.on('tool.execution_complete', (e) => {
    const toolName = extractToolName(e);
    const output = deepFindStr(e, ['output', 'result', 'content']) || null;
    let durationMs = null;
    for (const [id, startTime] of Object.entries(toolTimers)) {
      if (id.startsWith(toolName + '_')) {
        durationMs = Date.now() - startTime;
        delete toolTimers[id];
        break;
      }
    }
    emitEvent('tool.execution_complete', {
      name: toolName,
      durationMs,
      output: output ? output.slice(0, 800) : null,
      status: deepFindStr(e, ['status', 'result']) || 'success',
    });
  });
  session.on('tool.execution_progress', (e) => {
    const toolName = extractToolName(e);
    emitEvent('tool.execution_progress', { name: toolName, message: deepFindStr(e, ['message', 'progress', 'text']) });
  });
  session.on('assistant.streaming_delta', (e) => {
    const delta = deepFindStr(e, ['delta', 'content', 'text']);
    if (delta) emitEvent('assistant.streaming_delta', { delta });
  });
  session.on('assistant.message', (e) => {
    const content = deepFindStr(e, ['content', 'text', 'message'])
      ?? (typeof e?.data?.content === 'string' ? e.data.content : null)
      ?? (typeof e === 'string' ? e : null);
    emitEvent('assistant.message', { content: content ? content.slice(0, 3000) : null });
  });
  session.on('assistant.usage', (e) => {
    const inputTokens = deepFindNum(e, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']);
    const outputTokens = deepFindNum(e, ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens']);
    const cacheRead = deepFindNum(e, ['cacheReadTokens', 'cache_read_tokens', 'cacheReadInputTokens']);
    const cacheWrite = deepFindNum(e, ['cacheWriteTokens', 'cache_write_tokens', 'cacheCreationInputTokens']);
    emitEvent('assistant.usage', {
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      cost: deepFindNum(e, ['cost']),
      totalNanoAiu: deepFindNum(e, ['totalNanoAiu', 'total_nano_aiu']),
      apiCallId: deepFindStr(e, ['apiCallId', 'api_call_id']),
      providerCallId: deepFindStr(e, ['providerCallId', 'provider_call_id']),
      model: deepFindStr(e, ['model']) || COPILOT_MODEL,
    });
  });
  session.on('session.usage_info', (e) => {
    const tokenLimit = deepFindNum(e, ['tokenLimit']);
    const currentTokens = deepFindNum(e, ['currentTokens']);
    emitEvent('session.usage_info', {
      tokenLimit,
      currentTokens,
      model: deepFindStr(e, ['model']) || COPILOT_MODEL,
    });
  });
  session.on('session.error', (e) => {
    const msg = deepFindStr(e, ['message', 'error', 'reason']) || (typeof e === 'string' ? e : String(e));
    emitEvent('session.error', { message: msg });
  });
  session.on('permission.requested', (e) => {
    emitEvent('permission.requested', { tool: deepFindStr(e, ['tool', 'name', 'toolName']), reason: deepFindStr(e, ['reason', 'message']) });
  });

  return state;
}

// ── Review mode entry point ─────────────────────────────────────────────────
/**
 * Run in review mode: read the pre-built review prompt from USER_PROMPT_FILE,
 * run a Copilot session, return raw LLM response text.
 * No git operations are performed — the host parses the result.
 */
async function runReviewMode() {
  const { readFileSync } = require('fs');

  if (!existsSync(USER_PROMPT_FILE)) {
    throw new Error(`User prompt file not found: ${USER_PROMPT_FILE}`);
  }
  const reviewPrompt = readFileSync(USER_PROMPT_FILE, 'utf8').trim();
  if (!reviewPrompt) {
    throw new Error(`User prompt file is empty: ${USER_PROMPT_FILE}`);
  }

  process.stderr.write(`review mode: model=${COPILOT_MODEL}\n`);

  emitEvent('session.start', { mode: 'review', model: COPILOT_MODEL });

  const { session, client, localCliServer } = await runSession(reviewPrompt);

  try {
    const handlerState = registerSessionEventHandlers(session);

    emitEvent('review.prompt_sent', { promptLength: reviewPrompt.length });
    process.stderr.write('sending review prompt\n');

    const heartbeat = setInterval(() => {
      process.stderr.write(`review agent working… (${handlerState.toolCallCount} tool call(s) so far)\n`);
    }, 30_000);

    // 9-minute timeout — review is read-only so individual tool calls are fast.
    let response;
    try {
      response = await session.sendAndWait({ prompt: reviewPrompt }, 9 * 60 * 1000);
    } finally {
      clearInterval(heartbeat);
    }
    await session.disconnect().catch(() => {});

    const rawOutput = response?.data?.content ?? '';
    emitEvent('session.end', { mode: 'review', outputLength: rawOutput.length });
    process.stderr.write(`review complete (${rawOutput.length} chars)\n`);

    return {
      status: 'success',
      rawOutput,
      modifiedFiles: [],
      summary: rawOutput.slice(0, 500),
      agentLogs: rawOutput,
      metadata: { adapter: 'copilot-sdk', model: COPILOT_MODEL, reviewMode: true },
    };
  } finally {
    await client.stop().catch(() => {});
    if (localCliServer?.child) {
      localCliServer.child.kill('SIGTERM');
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN env var is required');
  // Note: repository is pre-cloned by the host at REPO_PATH (/workspace).
  // No VCS credentials are available or needed inside this container.

  // Read the user prompt from the file written by the host runner.
  const { readFileSync } = require('fs');
  if (!existsSync(USER_PROMPT_FILE)) {
    throw new Error(`User prompt file not found: ${USER_PROMPT_FILE}`);
  }
  const userPrompt = readFileSync(USER_PROMPT_FILE, 'utf8').trim();
  if (!userPrompt) {
    throw new Error(`User prompt file is empty: ${USER_PROMPT_FILE}`);
  }

  // ── Review mode: skip all git setup, return raw LLM response ────────────────
  if (REVIEW_MODE) {
    return runReviewMode();
  }

  // 1. Configure git identity in the pre-cloned repository and set CWD.
  process.chdir(REPO_PATH);
  git(['config', 'user.name',  GIT_AUTHOR_NAME]);
  git(['config', 'user.email', GIT_AUTHOR_EMAIL]);
  git(['config', 'commit.gpgsign', 'false']);

  // Configure git identity in each sub-repo so commits there also work.
  if (REPOSITORY_MAP && Array.isArray(REPOSITORY_MAP.submodules)) {
    for (const sub of REPOSITORY_MAP.submodules) {
      if (sub.localPath && sub.localPath !== '.') {
        const subPath = join(REPO_PATH, sub.localPath);
        try {
          git(['config', 'user.name',  GIT_AUTHOR_NAME], subPath);
          git(['config', 'user.email', GIT_AUTHOR_EMAIL], subPath);
          git(['config', 'commit.gpgsign', 'false'], subPath);
          process.stderr.write(`configured git identity in sub-repo ${sub.repoKey} (${sub.localPath})\n`);
        } catch (err) {
          process.stderr.write(`Warning: failed to configure git in ${sub.localPath}: ${err.message}\n`);
        }
      }
    }
  }

  process.stderr.write(`working directory set to ${REPO_PATH}\n`);

  // Record the base commit SHA for the root repo and each sub-repo so we can
  // enumerate agent-created commits after the session ends.
  const baseSha = git(['rev-parse', 'HEAD']).trim();
  const subRepoBaseShas = {};
  if (REPOSITORY_MAP && Array.isArray(REPOSITORY_MAP.submodules)) {
    for (const sub of REPOSITORY_MAP.submodules) {
      if (sub.localPath && sub.localPath !== '.') {
        const subPath = join(REPO_PATH, sub.localPath);
        try {
          subRepoBaseShas[sub.localPath] = git(['rev-parse', 'HEAD'], subPath).trim();
        } catch (err) {
          process.stderr.write(`Warning: could not read HEAD in ${sub.localPath}: ${err.message}\n`);
        }
      }
    }
  }

  process.stderr.write(`starting Copilot SDK client (mode=local-headless, model=${COPILOT_MODEL})\n`);

  const { session, client, localCliServer } = await runSession(userPrompt);

  let result;
  try {
    // Emit session start
    emitEvent('session.start', { model: COPILOT_MODEL, workingDirectory: REPO_PATH });

    // Register live-progress event handlers.
    const handlerState = registerSessionEventHandlers(session);

    process.stderr.write('sending task prompt\n');

    // Heartbeat: write a plain stderr line every 30 s while the model thinks.
    // This keeps live logs alive even when no tool events arrive (e.g. during
    // the initial model reasoning phase before any file edits).
    const heartbeat = setInterval(() => {
      process.stderr.write(`agent working… (${handlerState.toolCallCount} tool call(s) so far)\n`);
    }, 30_000);

    // 4. Send prompt and wait until the agent is idle (59-minute timeout).
    //    The SDK's sendAndWait timeout must be long enough for the agent to make
    //    100+ tool calls (each file edit, view, grep, bash invocation is a tool call).
    //    At ~3-5 seconds per tool call, 100 calls ≈ 5-8 minutes, plus headroom for
    //    network, SDK overhead, and model reasoning phases. 59 minutes (3540s) provides
    //    sufficient margin (1 minute under the 1-hour host deadline) for complex tasks.
    let response;
    try {
      response = await session.sendAndWait({ prompt: userPrompt }, 3_540_000);
    } finally {
      clearInterval(heartbeat);
    }

    const rawContent = response?.data?.content ?? 'Task completed';
    const summary = rawContent.trim().slice(0, 1000);
    process.stderr.write(`session idle — collecting changes\n`);
    emitEvent('session.end', {
      toolCallCount: handlerState.toolCallCount,
      toolsByKind: handlerState.toolsByKind,
      model: COPILOT_MODEL,
    });

    await session.disconnect();

    // 5. Check for agent-created commits across ALL repos (root + sub-repos).
    //    Multi-repo workspaces have independent git histories per directory.
    //    We collect commits from each repo and merge them.
    const rootHeadSha = git(['rev-parse', 'HEAD']).trim();
    const hasRootCommits = rootHeadSha !== baseSha;

    // Collect sub-repo commits
    let subRepoCommits = [];
    const subRepoLocalPaths = Object.keys(subRepoBaseShas);
    for (const localPath of subRepoLocalPaths) {
      const subBase = subRepoBaseShas[localPath];
      const subPath = join(REPO_PATH, localPath);
      try {
        const subHead = git(['rev-parse', 'HEAD'], subPath).trim();
        if (subHead !== subBase) {
          const sub = REPOSITORY_MAP.submodules.find((s) => s.localPath === localPath);
          const subCommits = collectCommits(subBase, subPath);
          // Tag each commit with the sub-repo's repoKey
          for (const c of subCommits) {
            c.repoKey = sub ? sub.repoKey : localPath;
          }
          subRepoCommits = subRepoCommits.concat(subCommits);
          process.stderr.write(`${subCommits.length} commit(s) found in sub-repo ${localPath}\n`);
        }
      } catch (err) {
        process.stderr.write(`Warning: failed to check commits in ${localPath}: ${err.message}\n`);
      }
    }

    const hasAgentCommits = hasRootCommits || subRepoCommits.length > 0;

    if (hasAgentCommits) {
      // Read root commit chain: baseSha..HEAD (oldest first)
      let rootCommits = hasRootCommits ? collectCommits(baseSha) : [];
      // Tag root commits with superproject repoKey
      if (REPOSITORY_MAP && REPOSITORY_MAP.superproject) {
        for (const c of rootCommits) {
          if (c.repoKey === 'superproject') c.repoKey = REPOSITORY_MAP.superproject.repoKey;
        }
      }

      let commits = rootCommits.concat(subRepoCommits);
      const validation = validateCommits(commits);

      if (validation.valid) {
        // Inject deterministic Change-Ids for commits that lack them.
        // This ensures Gerrit sees stable Change-Ids across retry cycles.
        // For multi-repo workspaces, inject per-repo (rebase happens in each repo independently).
        if (TASK_ID) {
          if (hasRootCommits) {
            // On feedback cycles the base commit already has a Change-Id.
            // If the agent added new commits on top instead of amending,
            // squash them into the base so only one commit per Change-Id is pushed.
            const squashResult = squashIntoBaseIfNeeded(baseSha);
            if (squashResult.squashed) {
              rootCommits = squashResult.commits;
              if (REPOSITORY_MAP && REPOSITORY_MAP.superproject) {
                for (const c of rootCommits) {
                  if (c.repoKey === 'superproject') c.repoKey = REPOSITORY_MAP.superproject.repoKey;
                }
              }
            }

            // Resolve the existing Change-Id for the root repo:
            // 1. Legacy ROOT_CHANGE_ID env (single-repo or backward compat)
            // 2. PER_REPO_CHANGE_IDS entry for the superproject repoKey (project-mode)
            let rootExistingChangeId = ROOT_CHANGE_ID;
            let rootRepoKey = null;
            if (PER_REPO_CHANGE_IDS) {
              const superprojectKey = REPOSITORY_MAP?.superproject?.repoKey;
              if (superprojectKey && PER_REPO_CHANGE_IDS[superprojectKey]) {
                rootRepoKey = superprojectKey;
                // For index-0 compat, resolve flat string or indexed map
                const entry = PER_REPO_CHANGE_IDS[superprojectKey];
                if (!rootExistingChangeId) {
                  rootExistingChangeId = typeof entry === 'string' ? entry : (entry?.['0'] || null);
                }
              } else if (!rootExistingChangeId) {
                // No REPOSITORY_MAP or no superproject key — try matching the sole entry
                const keys = Object.keys(PER_REPO_CHANGE_IDS);
                if (keys.length === 1) {
                  rootRepoKey = keys[0];
                  const entry = PER_REPO_CHANGE_IDS[keys[0]];
                  rootExistingChangeId = typeof entry === 'string' ? entry : (entry?.['0'] || null);
                }
              }
            }
            rootCommits = injectCommitTrailers(baseSha, rootCommits, undefined, rootExistingChangeId, rootRepoKey);
          }
          for (const localPath of subRepoLocalPaths) {
            const subBase = subRepoBaseShas[localPath];
            const subPath = join(REPO_PATH, localPath);
            const subCommitsForPath = subRepoCommits.filter((c) => {
              const sub = REPOSITORY_MAP.submodules.find((s) => s.localPath === localPath);
              return sub && c.repoKey === sub.repoKey;
            });
            if (subCommitsForPath.length > 0) {
              const subRepoKey = REPOSITORY_MAP.submodules.find((s) => s.localPath === localPath)?.repoKey;
              const subEntry = PER_REPO_CHANGE_IDS && subRepoKey ? (PER_REPO_CHANGE_IDS[subRepoKey] || null) : null;
              const subChangeId = typeof subEntry === 'string' ? subEntry : (subEntry?.['0'] || null);
              const injected = injectCommitTrailers(subBase, subCommitsForPath, subPath, subChangeId, subRepoKey || null);
              // Replace sub-repo commits with injected versions
              const sub = REPOSITORY_MAP.submodules.find((s) => s.localPath === localPath);
              const repoKey = sub ? sub.repoKey : localPath;
              subRepoCommits = subRepoCommits.filter((c) => c.repoKey !== repoKey).concat(injected);
            }
          }
          commits = rootCommits.concat(subRepoCommits);
        }

        // Collect all modified files across all commits for modifiedFiles compat
        const allFiles = new Set();
        for (const c of commits) {
          for (const f of c.files) allFiles.add(f);
        }
        const flatModifiedFiles = Array.from(allFiles);

        let modifiedFiles;
        if (REPOSITORY_MAP && typeof REPOSITORY_MAP === 'object') {
          modifiedFiles = groupFilesByRepo(flatModifiedFiles);
        } else {
          modifiedFiles = flatModifiedFiles;
        }

        process.stderr.write(`${commits.length} agent commit(s), ${flatModifiedFiles.length} file(s) modified\n`);

        result = {
          status: 'success',
          modifiedFiles,
          commits,
          summary,
          agentLogs: summary,
          metadata: { adapter: 'copilot-sdk', model: COPILOT_MODEL, agentCommits: true },
        };
      } else {
        // Validation failed — report as failed result
        process.stderr.write(`commit validation failed: ${validation.reason}\n`);
        emitEvent('commit.validation_failed', { reason: validation.reason, commitCount: commits.length });

        result = {
          status: 'failed',
          modifiedFiles: [],
          summary: `Agent commits failed validation: ${validation.reason}`,
          agentLogs: summary,
          metadata: { adapter: 'copilot-sdk', model: COPILOT_MODEL, commitValidationError: validation.reason },
        };
      }
    } else {
      // Legacy path: no agent commits in any repo — collect modified files from git status.
      // For multi-repo workspaces, check each repo independently and filter out
      // sub-repo directory entries from the root status (submodule pointer changes).
      const subLocalPaths = REPOSITORY_MAP && Array.isArray(REPOSITORY_MAP.submodules)
        ? REPOSITORY_MAP.submodules.map((s) => s.localPath).filter((p) => p && p !== '.')
        : [];

      const statusOutput = git(['status', '--porcelain']);
      const rootModified = statusOutput
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter((f) => f && !subLocalPaths.includes(f));

      // Also check sub-repos for modified files
      const subModified = [];
      for (const localPath of subLocalPaths) {
        const subPath = join(REPO_PATH, localPath);
        try {
          const subStatus = git(['status', '--porcelain'], subPath);
          const subFiles = subStatus
            .split('\n')
            .map((line) => line.slice(3).trim())
            .filter(Boolean);
          for (const f of subFiles) {
            subModified.push(localPath + '/' + f);
          }
        } catch { /* ignore */ }
      }

      const flatModifiedFiles = rootModified.concat(subModified);

      let modifiedFiles;
      if (REPOSITORY_MAP && typeof REPOSITORY_MAP === 'object') {
        modifiedFiles = groupFilesByRepo(flatModifiedFiles);
      } else {
        modifiedFiles = flatModifiedFiles;
      }

      process.stderr.write(`${flatModifiedFiles.length} file(s) modified (legacy, no agent commits)\n`);

      if (flatModifiedFiles.length === 0) {
        result = {
          status: 'no_change',
          modifiedFiles: REPOSITORY_MAP ? {} : [],
          summary,
          agentLogs: summary,
          metadata: { adapter: 'copilot-sdk', model: COPILOT_MODEL },
        };
      } else {
        // Strict mode: edited files without commits is a hard failure.
        // The model must run git add/git commit when it changes code.
        const reason = 'agent edited files but created no commits; run git add/git commit before finishing';
        const toolSummary = Object.entries(handlerState.toolsByKind)
          .map(([name, count]) => `${name}=${count}`)
          .join(', ') || 'none';
        process.stderr.write(`${reason}\n`);
        process.stderr.write(`tool usage breakdown: ${toolSummary}\n`);
        emitEvent('commit.validation_failed', {
          reason,
          modifiedFileCount: flatModifiedFiles.length,
          toolCallCount: handlerState.toolCallCount,
          toolsByKind: handlerState.toolsByKind,
        });
        result = {
          status: 'failed',
          modifiedFiles,
          summary: `Agent changed files without commits (${flatModifiedFiles.length} file(s)).` +
            ' The agent must create at least one conventional commit.' +
            ` Tool usage: ${toolSummary}.`,
          agentLogs: summary,
          metadata: {
            adapter: 'copilot-sdk',
            model: COPILOT_MODEL,
            missingCommits: true,
            toolCallCount: handlerState.toolCallCount,
            toolsByKind: handlerState.toolsByKind,
          },
        };
      }
    }
  } finally {
    await client.stop().catch(() => {});
    if (localCliServer?.child) {
      localCliServer.child.kill('SIGTERM');
    }
  }

  return result;
}

main()
  .then((result) => {
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  })
  .catch((err) => {
    process.stdout.write(
      JSON.stringify({
        status: 'failed',
        modifiedFiles: [],
        summary: `Agent worker error: ${err.message}`,
        agentLogs: err.stack || err.message,
        metadata: { adapter: 'copilot-sdk', error: err.message },
      }) + '\n'
    );
    process.exit(0); // always exit 0 so the host process can read stdout
  });


