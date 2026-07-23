#!/usr/bin/env node
/**
 * Virtual Engineer — Agent Worker (TypeScript)
 *
 * Runs INSIDE the Docker container for each task cycle.
 * The repository is pre-cloned by the host orchestrator and mounted at /workspace.
 * This worker is responsible ONLY for code generation.
 * It has no VCS credentials, does not clone, and never pushes.
 *
 * Receives task context via environment variables, then:
 *   1. Opens an agent session (provider chosen via AGENT_PROVIDER) against the
 *      pre-cloned repository — see `providers/` for the per-provider runners
 *   2. Sends the task prompt — the agent edits files autonomously
 *   3. Collects agent-created commits
 *   4. Writes a JSON AgentResult object to stdout
 *
 * Authentication: provider-specific env var (e.g. GITHUB_TOKEN for Copilot,
 * ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN for Claude).
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import type { AgentLogEvent, AgentResult, CommitDescriptor, RepositoryMap } from '../../src/interfaces.js';
import {
  collectCommits,
  validateCommits,
  injectChangeIds,
  resolveExistingRootChange,
  squashIntoBaseIfNeeded,
  groupFilesByRepo,
} from './commitUtils.js';
import { emitEvent } from './providers/events.js';
import { resolveProvider, isAgentProvider, AGENT_PROVIDER_IDS } from './providers/registry.js';
import type { AgentRun } from './providers/types.js';

// ── Environment ────────────────────────────────────────────────────────────────
const AGENT_PROVIDER = process.env['AGENT_PROVIDER'] ?? 'copilot';
if (!isAgentProvider(AGENT_PROVIDER)) {
  process.stderr.write(
    `FATAL: unknown AGENT_PROVIDER "${AGENT_PROVIDER}". ` +
    `Supported providers: ${AGENT_PROVIDER_IDS.join(', ')}.\n`,
  );
  process.exit(1);
}
const ACTIVE_PROVIDER = resolveProvider(AGENT_PROVIDER);
const ACTIVE_MODEL = ACTIVE_PROVIDER.resolveModel();
const ACTIVE_MODEL_LABEL = ACTIVE_MODEL || ACTIVE_PROVIDER.defaultModelLabel;
const ADAPTER_LABEL = ACTIVE_PROVIDER.adapterLabel;
const GIT_AUTHOR_NAME = process.env['GIT_AUTHOR_NAME'] ?? 'Virtual Engineer';
const GIT_AUTHOR_EMAIL = process.env['GIT_AUTHOR_EMAIL'] ?? 've@virtual-engineer.local';
const GIT_COMMITTER_NAME = process.env['GIT_COMMITTER_NAME'] ?? GIT_AUTHOR_NAME;
const GIT_COMMITTER_EMAIL = process.env['GIT_COMMITTER_EMAIL'] ?? GIT_AUTHOR_EMAIL;
const TASK_ID = process.env['TASK_ID'] ?? '';
const MAX_COMMITS_PER_CYCLE = Number(process.env['MAX_COMMITS_PER_CYCLE']) || 10;
/** Change-Id to reuse for the root-repo's first commit on retry cycles. */
const ROOT_CHANGE_ID = process.env['ROOT_CHANGE_ID'] ?? null;
/** Pre-formatted ticket-footer trailer line injected into every agent commit (host-computed). */
const TICKET_FOOTER_LINE = process.env['TICKET_FOOTER_LINE'] || null;
/** Per-repo Change-Ids to reuse on retry cycles (JSON object or null). */
let PER_REPO_CHANGE_IDS: Record<string, string | Record<string, string>> | null = null;
try {
  const raw = process.env['PER_REPO_CHANGE_IDS_JSON'] ?? '';
  if (raw) PER_REPO_CHANGE_IDS = JSON.parse(raw) as Record<string, string | Record<string, string>>;
} catch {
  process.stderr.write('Warning: failed to parse PER_REPO_CHANGE_IDS_JSON\n');
}
const REVIEW_MODE = process.env['REVIEW_MODE'] === '1';
const SKILL_DISCOVERY = process.env['SKILL_DISCOVERY'] === '1';
const USER_PROMPT_FILE = process.env['USER_PROMPT_FILE'] ?? '';
const SYSTEM_PROMPT = process.env['SYSTEM_PROMPT'] ?? '';
let REVIEW_OUTPUT_SCHEMA: Record<string, unknown> | undefined;
try {
  const rawReviewOutputSchema = process.env['REVIEW_OUTPUT_SCHEMA'] ?? '';
  if (rawReviewOutputSchema) {
    const parsed: unknown = JSON.parse(rawReviewOutputSchema);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('schema must be a JSON object');
    }
    REVIEW_OUTPUT_SCHEMA = parsed as Record<string, unknown>;
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`FATAL: invalid REVIEW_OUTPUT_SCHEMA: ${message}\n`);
  process.exit(1);
}

if (!process.env['SYSTEM_PROMPT']) {
  process.stderr.write(
    'FATAL: SYSTEM_PROMPT env var is required but was not set. ' +
    'Ensure the orchestrator injects a prompt before launching this container.\n',
  );
  process.exit(1);
}
if (!USER_PROMPT_FILE) {
  process.stderr.write(
    'FATAL: USER_PROMPT_FILE env var is required but was not set. ' +
    'Ensure the orchestrator writes the prompt file before launching this container.\n',
  );
  process.exit(1);
}

// ── Structured event emitter is imported from ./providers/events.js ──────────

// ── Multi-repository context ──────────────────────────────────────────────────
let REPOSITORY_MAP: RepositoryMap | undefined;
try {
  const repositoryMapJson = process.env['REPOSITORY_MAP_JSON'] ?? '';
  if (repositoryMapJson) {
    REPOSITORY_MAP = JSON.parse(repositoryMapJson) as RepositoryMap;
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Warning: Failed to parse REPOSITORY_MAP_JSON: ${msg}\n`);
}

const WORKSPACE = '/workspace';
const REPO_PATH = WORKSPACE;
// ── Internal git helper ────────────────────────────────────────────────────────
function git(args: string[], cwd: string = REPO_PATH): string {
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

// ── Provider-agnostic agent driver ────────────────────────────────────────────

/**
 * Dispatch to the configured agent provider (`copilot` or `claude`).
 *
 * Provider selection and per-session behaviour live in `providers/`; this
 * function only assembles the run options from the container environment and
 * delegates to the runner resolved by the registry.
 */
async function runAgent(
  prompt: string,
  timeoutMs: number,
  mode: 'codegen' | 'review',
): Promise<AgentRun> {
  return ACTIVE_PROVIDER.runner(prompt, {
    model: ACTIVE_MODEL,
    agentInstructions: SYSTEM_PROMPT,
    cwd: REPO_PATH,
    timeoutMs,
    mode,
    skillDiscovery: SKILL_DISCOVERY,
    ...(mode === 'review' && REVIEW_OUTPUT_SCHEMA !== undefined
      ? { reviewOutputSchema: REVIEW_OUTPUT_SCHEMA }
      : {}),
  });
}

// ── Review mode entry point ────────────────────────────────────────────────────

/** Extended result shape for review mode — rawOutput consumed by workspaceRunner. */
interface ReviewWorkerResult extends AgentResult {
  rawOutput: string;
}

async function runReviewMode(): Promise<ReviewWorkerResult> {
  if (!existsSync(USER_PROMPT_FILE)) {
    throw new Error(`User prompt file not found: ${USER_PROMPT_FILE}`);
  }
  const reviewPrompt = readFileSync(USER_PROMPT_FILE, 'utf8').trim();
  if (!reviewPrompt) {
    throw new Error(`User prompt file is empty: ${USER_PROMPT_FILE}`);
  }

  process.stderr.write(`review mode: provider=${AGENT_PROVIDER} model=${ACTIVE_MODEL_LABEL}\n`);

  const agent = await runAgent(reviewPrompt, 9 * 60 * 1000, 'review');
  try {
    const rawOutput = agent.content ?? '';
    // session.end is emitted by the provider runner (see providers/).
    process.stderr.write(`review complete (${rawOutput.length} chars)\n`);

    return {
      status: 'success',
      rawOutput,
      modifiedFiles: [],
      summary: rawOutput.slice(0, 500),
      agentLogs: rawOutput,
      metadata: { adapter: ADAPTER_LABEL, model: ACTIVE_MODEL_LABEL, reviewMode: true },
    };
  } finally {
    await agent.cleanup();
  }
}

// ── Main (code-generation mode) ───────────────────────────────────────────────
async function main(): Promise<AgentResult> {
  ACTIVE_PROVIDER.validateEnvironment?.();

  if (!existsSync(USER_PROMPT_FILE)) {
    throw new Error(`User prompt file not found: ${USER_PROMPT_FILE}`);
  }
  const userPrompt = readFileSync(USER_PROMPT_FILE, 'utf8').trim();
  if (!userPrompt) {
    throw new Error(`User prompt file is empty: ${USER_PROMPT_FILE}`);
  }

  if (REVIEW_MODE) {
    return runReviewMode();
  }

  // 1. Configure git identity in the pre-cloned repository.
  process.chdir(REPO_PATH);
  git(['config', 'user.name', GIT_AUTHOR_NAME]);
  git(['config', 'user.email', GIT_AUTHOR_EMAIL]);
  git(['config', 'commit.gpgsign', 'false']);

  if (REPOSITORY_MAP != null && Array.isArray(REPOSITORY_MAP.submodules)) {
    for (const sub of REPOSITORY_MAP.submodules) {
      if (sub.localPath && sub.localPath !== '.') {
        const subPath = join(REPO_PATH, sub.localPath);
        try {
          git(['config', 'user.name', GIT_AUTHOR_NAME], subPath);
          git(['config', 'user.email', GIT_AUTHOR_EMAIL], subPath);
          git(['config', 'commit.gpgsign', 'false'], subPath);
          process.stderr.write(`configured git identity in sub-repo ${sub.repoKey} (${sub.localPath})\n`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`Warning: failed to configure git in ${sub.localPath}: ${msg}\n`);
        }
      }
    }
  }

  process.stderr.write(`working directory set to ${REPO_PATH}\n`);

  // 2. Record base commit SHAs before the agent runs.
  const baseSha = git(['rev-parse', 'HEAD']).trim();
  const subRepoBaseShas: Record<string, string> = {};
  if (REPOSITORY_MAP != null && Array.isArray(REPOSITORY_MAP.submodules)) {
    for (const sub of REPOSITORY_MAP.submodules) {
      if (sub.localPath && sub.localPath !== '.') {
        const subPath = join(REPO_PATH, sub.localPath);
        try {
          subRepoBaseShas[sub.localPath] = git(['rev-parse', 'HEAD'], subPath).trim();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`Warning: could not read HEAD in ${sub.localPath}: ${msg}\n`);
        }
      }
    }
  }

  process.stderr.write(`starting agent (provider=${AGENT_PROVIDER}, model=${ACTIVE_MODEL_LABEL})\n`);

  const agent = await runAgent(userPrompt, 3_540_000, 'codegen');
  const handlerState = { toolCallCount: agent.toolCallCount, toolsByKind: agent.toolsByKind };
  const rawContent = agent.content ?? 'Task completed';
  const summary = rawContent.trim().slice(0, 1000);

  let result: AgentResult = {
    status: 'failed',
    modifiedFiles: [],
    summary: 'Internal error: result not set',
    agentLogs: '',
    metadata: { adapter: ADAPTER_LABEL, model: ACTIVE_MODEL_LABEL },
  };

  try {
    process.stderr.write('session idle — collecting changes\n');
    // session.end is emitted by the provider runner (see providers/).

    // 3. Check for agent-created commits across ALL repos.
    const rootHeadSha = git(['rev-parse', 'HEAD']).trim();
    const hasRootCommits = rootHeadSha !== baseSha;

    let subRepoCommits: CommitDescriptor[] = [];
    const subRepoLocalPaths = Object.keys(subRepoBaseShas);

    for (const localPath of subRepoLocalPaths) {
      const subBase = subRepoBaseShas[localPath];
      if (subBase == null) continue;
      if (REPOSITORY_MAP == null) continue;

      const subPath = join(REPO_PATH, localPath);
      try {
        const subHead = git(['rev-parse', 'HEAD'], subPath).trim();
        if (subHead !== subBase) {
          const sub = REPOSITORY_MAP.submodules.find((s) => s.localPath === localPath);
          const subCommits = collectCommits(subBase, subPath);
          for (const c of subCommits) {
            c.repoKey = sub ? sub.repoKey : localPath;
          }
          subRepoCommits = subRepoCommits.concat(subCommits);
          process.stderr.write(`${subCommits.length} commit(s) found in sub-repo ${localPath}\n`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Warning: failed to check commits in ${localPath}: ${msg}\n`);
      }
    }

    const hasAgentCommits = hasRootCommits || subRepoCommits.length > 0;

    if (hasAgentCommits) {
      let rootCommits: CommitDescriptor[] = hasRootCommits
        ? collectCommits(baseSha, REPO_PATH, REPOSITORY_MAP)
        : [];

      if (REPOSITORY_MAP?.superproject != null) {
        const spKey = REPOSITORY_MAP.superproject.repoKey;
        for (const c of rootCommits) {
          if (c.repoKey === 'superproject') c.repoKey = spKey;
        }
      }

      let commits = rootCommits.concat(subRepoCommits);
      const validation = validateCommits(commits, MAX_COMMITS_PER_CYCLE);

      if (validation.valid) {
        if (TASK_ID) {
          if (hasRootCommits) {
            const rootExistingChange = resolveExistingRootChange(
              ROOT_CHANGE_ID,
              PER_REPO_CHANGE_IDS,
              REPOSITORY_MAP,
            );
            // Only squash into the base commit when continuing VE's own
            // existing patchset (retry/feedback cycle). On the first cycle the
            // base is upstream (e.g. a Gerrit `master` tip that carries its own
            // Change-Id); squashing there would amend an upstream commit whose
            // parent is absent from the --depth 1 shallow clone, making
            // diff-tree report the entire repo. See squashIntoBaseIfNeeded.
            const isContinuation =
              rootExistingChange.changeId != null || rootExistingChange.repoKey != null;
            const squashResult = squashIntoBaseIfNeeded(baseSha, REPO_PATH, isContinuation);
            if (squashResult.squashed && squashResult.commits != null) {
              rootCommits = squashResult.commits;
              if (REPOSITORY_MAP?.superproject != null) {
                const spKey = REPOSITORY_MAP.superproject.repoKey;
                for (const c of rootCommits) {
                  if (c.repoKey === 'superproject') c.repoKey = spKey;
                }
              }
            }

            rootCommits = injectChangeIds(baseSha, rootCommits, TASK_ID, REPO_PATH, {
              existingChangeId: rootExistingChange.changeId,
              repoKeyForLookup: rootExistingChange.repoKey,
              perRepoChangeIds: PER_REPO_CHANGE_IDS,
              gitAuthorName: GIT_AUTHOR_NAME,
              gitAuthorEmail: GIT_AUTHOR_EMAIL,
              gitCommitterName: GIT_COMMITTER_NAME,
              gitCommitterEmail: GIT_COMMITTER_EMAIL,
              ticketFooterLine: TICKET_FOOTER_LINE,
            });
          }

          for (const localPath of subRepoLocalPaths) {
            const subBase = subRepoBaseShas[localPath];
            if (subBase == null || REPOSITORY_MAP == null) continue;
            const subPath = join(REPO_PATH, localPath);
            const subMeta = REPOSITORY_MAP.submodules.find((s) => s.localPath === localPath);
            const subRepoKey = subMeta?.repoKey ?? null;
            const subCommitsForPath = subRepoCommits.filter((c) => subMeta && c.repoKey === subMeta.repoKey);

            if (subCommitsForPath.length > 0) {
              const subEntry = (PER_REPO_CHANGE_IDS != null && subRepoKey != null)
                ? (PER_REPO_CHANGE_IDS[subRepoKey] ?? null)
                : null;
              const subChangeId = (typeof subEntry === 'string')
                ? subEntry
                : (subEntry != null ? (subEntry['0'] ?? null) : null);

              const injected = injectChangeIds(subBase, subCommitsForPath, TASK_ID, subPath, {
                existingChangeId: subChangeId,
                repoKeyForLookup: subRepoKey,
                perRepoChangeIds: PER_REPO_CHANGE_IDS,
                gitAuthorName: GIT_AUTHOR_NAME,
                gitAuthorEmail: GIT_AUTHOR_EMAIL,
                gitCommitterName: GIT_COMMITTER_NAME,
                gitCommitterEmail: GIT_COMMITTER_EMAIL,
                ticketFooterLine: TICKET_FOOTER_LINE,
              });
              const repoKey = subMeta ? subMeta.repoKey : localPath;
              subRepoCommits = subRepoCommits.filter((c) => c.repoKey !== repoKey).concat(injected);
            }
          }

          commits = rootCommits.concat(subRepoCommits);
        }

        const allFiles = new Set<string>();
        for (const c of commits) {
          for (const f of c.files) allFiles.add(f);
        }
        const flatModifiedFiles = Array.from(allFiles);

        const modifiedFiles: string[] | Record<string, string[]> = (REPOSITORY_MAP != null)
          ? groupFilesByRepo(flatModifiedFiles, REPOSITORY_MAP)
          : flatModifiedFiles;

        process.stderr.write(
          `${commits.length} agent commit(s), ${flatModifiedFiles.length} file(s) modified\n`,
        );

        result = {
          status: 'success',
          modifiedFiles,
          commits,
          summary,
          agentLogs: summary,
          metadata: { adapter: ADAPTER_LABEL, model: ACTIVE_MODEL_LABEL, agentCommits: true },
        };
      } else {
        process.stderr.write(`commit validation failed: ${validation.reason ?? ''}\n`);
        emitEvent('commit.validation_failed', {
          reason: validation.reason ?? null,
          commitCount: commits.length,
        });

        result = {
          status: 'failed',
          modifiedFiles: [],
          summary: `Agent commits failed validation: ${validation.reason ?? 'unknown'}`,
          agentLogs: summary,
          metadata: {
            adapter: 'copilot-sdk',
            model: ACTIVE_MODEL_LABEL,
            commitValidationError: validation.reason ?? null,
          },
        };
      }
    } else {
      // No agent commits: collect modified files from git status.
      const subLocalPaths = (REPOSITORY_MAP != null && Array.isArray(REPOSITORY_MAP.submodules))
        ? REPOSITORY_MAP.submodules.map((s) => s.localPath).filter((p): p is string => Boolean(p) && p !== '.')
        : [];

      const statusOutput = git(['status', '--porcelain']);
      const rootModified = statusOutput
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter((f) => f && !subLocalPaths.includes(f));

      const subModified: string[] = [];
      for (const localPath of subLocalPaths) {
        const subPath = join(REPO_PATH, localPath);
        try {
          const subStatus = git(['status', '--porcelain'], subPath);
          const subFiles = subStatus.split('\n').map((line) => line.slice(3).trim()).filter(Boolean);
          for (const f of subFiles) subModified.push(`${localPath}/${f}`);
        } catch { /* ignore */ }
      }

      const flatModifiedFiles = rootModified.concat(subModified);

      const modifiedFiles: string[] | Record<string, string[]> = (REPOSITORY_MAP != null)
        ? groupFilesByRepo(flatModifiedFiles, REPOSITORY_MAP)
        : flatModifiedFiles;

      process.stderr.write(
        `${flatModifiedFiles.length} file(s) modified (legacy, no agent commits)\n`,
      );

      if (flatModifiedFiles.length === 0) {
        result = {
          status: 'no_change',
          modifiedFiles: (REPOSITORY_MAP != null) ? {} : [],
          summary,
          agentLogs: summary,
          metadata: { adapter: ADAPTER_LABEL, model: ACTIVE_MODEL_LABEL },
        };
      } else {
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
            model: ACTIVE_MODEL_LABEL,
            missingCommits: true,
            toolCallCount: handlerState.toolCallCount,
            toolsByKind: handlerState.toolsByKind,
          },
        };
      }
    }
  } finally {
    await agent.cleanup();
  }

  // Normalize provider identity in the result metadata (the commit-collection
  // block above builds several result objects with default labels).
  if (result.metadata) {
    result.metadata = { ...result.metadata, adapter: ADAPTER_LABEL, model: ACTIVE_MODEL_LABEL };
  }

  return result;
}

// ── Entry point ───────────────────────────────────────────────────────────────
main()
  .then((result) => {
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  })
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? msg) : msg;
    process.stdout.write(
      JSON.stringify({
        status: 'failed',
        modifiedFiles: [],
        summary: `Agent worker error: ${msg}`,
        agentLogs: stack,
        metadata: { adapter: 'copilot-sdk', error: msg },
      } satisfies AgentResult) + '\n',
    );
    process.exit(0); // always exit 0 so the host can read stdout
  });

// Suppress unused import warning: AgentLogEvent is used by AgentResult (transitive)
export type { AgentLogEvent };
