#!/usr/bin/env node
/**
 * Virtual Engineer — Agent Worker (TypeScript / Copilot SDK)
 *
 * Runs INSIDE the Docker container for each task cycle.
 * The repository is pre-cloned by the host orchestrator and mounted at /workspace.
 * This worker is responsible ONLY for code generation.
 * It has no VCS credentials, does not clone, and never pushes.
 *
 * Receives task context via environment variables, then:
 *   1. Opens a GitHub Copilot SDK session against the pre-cloned repository
 *   2. Sends the task prompt — the CLI agent edits files autonomously
 *   3. Collects agent-created commits
 *   4. Writes a JSON AgentResult object to stdout
 *
 * Authentication: GITHUB_TOKEN env var (for Copilot LLM calls only).
 */

import { CopilotClient, approveAll } from '@github/copilot-sdk';
import type { CopilotSession, AssistantMessageEvent } from '@github/copilot-sdk';
import { execFileSync, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { createConnection } from 'net';
import { join } from 'path';

type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
import type { AgentLogEvent, AgentResult, CommitDescriptor, RepositoryMap } from '../../src/interfaces.js';
import {
  collectCommits,
  validateCommits,
  injectChangeIds,
  squashIntoBaseIfNeeded,
  groupFilesByRepo,
} from './commitUtils.js';

// ── Environment ────────────────────────────────────────────────────────────────
const GITHUB_TOKEN = process.env['GITHUB_TOKEN'] ?? '';
const COPILOT_MODEL = process.env['COPILOT_MODEL'] ?? 'auto';
const COPILOT_REASONING_EFFORT = process.env['COPILOT_REASONING_EFFORT'];
const GIT_AUTHOR_NAME = process.env['GIT_AUTHOR_NAME'] ?? 'Virtual Engineer';
const GIT_AUTHOR_EMAIL = process.env['GIT_AUTHOR_EMAIL'] ?? 've@virtual-engineer.local';
const GIT_COMMITTER_NAME = process.env['GIT_COMMITTER_NAME'] ?? GIT_AUTHOR_NAME;
const GIT_COMMITTER_EMAIL = process.env['GIT_COMMITTER_EMAIL'] ?? GIT_AUTHOR_EMAIL;
const TASK_ID = process.env['TASK_ID'] ?? '';
const MAX_COMMITS_PER_CYCLE = Number(process.env['MAX_COMMITS_PER_CYCLE']) || 10;
/** Change-Id to reuse for the root-repo's first commit on retry cycles. */
const ROOT_CHANGE_ID = process.env['ROOT_CHANGE_ID'] ?? null;
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

// ── Structured event emitter ──────────────────────────────────────────────────
function emitEvent(type: string, data: Record<string, unknown>): void {
  process.stderr.write(
    JSON.stringify({ __ve_event: true, type, data, ts: new Date().toISOString() }) + '\n',
  );
}

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

// ── Port readiness helper ─────────────────────────────────────────────────────
function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const attempt = (): void => {
      const socket = createConnection({ host, port });
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

// ── Local headless CLI server ─────────────────────────────────────────────────
interface LocalCliServer {
  child: ChildProcess;
  cliUrl: string;
}

async function startLocalCliServer(): Promise<LocalCliServer> {
  const cliPath = '/agent-worker/node_modules/.bin/copilot';
  const port = 3000;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  // Environment Variable Allowlist (Security):
  // Subprocess has only whitelisted env vars to prevent secrets leakage.
  const child = spawn(cliPath, ['--headless', '--port', String(port)], {
    cwd: REPO_PATH,
    env: {
      GITHUB_TOKEN: process.env['GITHUB_TOKEN'] ?? '',
      GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME,
      GIT_COMMITTER_EMAIL,
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      TMPDIR: process.env['TMPDIR'] ?? '',
      TMP: process.env['TMP'] ?? '',
      TEMP: process.env['TEMP'] ?? '',
      USER: process.env['USER'] ?? '',
      XDG_RUNTIME_DIR: process.env['XDG_RUNTIME_DIR'] ?? '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk: unknown) => stdoutChunks.push(String(chunk)));
  child.stderr?.on('data', (chunk: unknown) => stderrChunks.push(String(chunk)));

  try {
    await waitForPort('127.0.0.1', port, 30_000);
  } catch (err) {
    child.kill('SIGTERM');
    const detail = `${stdoutChunks.join('')}\n${stderrChunks.join('')}`.trim();
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to start local Copilot CLI server: ${msg}${detail ? `\n${detail}` : ''}`);
  }

  return { child, cliUrl: `127.0.0.1:${port}` };
}

// ── Unified session runner ────────────────────────────────────────────────────
async function runSession(
  userPrompt: string,
): Promise<{ session: CopilotSession; client: CopilotClient; localCliServer: LocalCliServer }> {
  const localCliServer = await startLocalCliServer();
  const client = new CopilotClient({ cliUrl: localCliServer.cliUrl });

  // Never enabled in review mode (defense-in-depth even if the host omits SKILL_DISCOVERY).
  // Guarded so a missing path — or a non-directory at that path — never aborts the session.
  const skillsDir = join(WORKSPACE, '.github', 'skills');
  let enableSkillDiscovery = false;
  if (SKILL_DISCOVERY && !REVIEW_MODE) {
    try {
      enableSkillDiscovery = statSync(skillsDir).isDirectory();
    } catch {
      enableSkillDiscovery = false;
    }
  }

  try {
    const session = await client.createSession({
      model: COPILOT_MODEL,
      ...(COPILOT_REASONING_EFFORT && COPILOT_REASONING_EFFORT !== 'none'
        ? { reasoningEffort: COPILOT_REASONING_EFFORT as ReasoningEffort }
        : {}),
      ...(enableSkillDiscovery ? { skillDirectories: [skillsDir] } : {}),
      systemMessage: { content: SYSTEM_PROMPT },
      onPermissionRequest: approveAll,
      workingDirectory: WORKSPACE,
      infiniteSessions: { enabled: false },
    });
    // Suppress unused-variable warning: userPrompt is used by the caller via sendAndWait
    void userPrompt;
    return { session, client, localCliServer };
  } catch (err) {
    await client.stop().catch(() => { /* ignore */ });
    localCliServer.child.kill('SIGTERM');
    throw err;
  }
}

// ── SDK event field extraction helpers ───────────────────────────────────────

function deepFindStr(obj: unknown, keys: string[]): string | null {
  const seen = new Set<object>();

  function visit(value: unknown): string | null {
    if (value === null || value === undefined || typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);

    const record = value as Record<string, unknown>;
    for (const k of keys) {
      const val = record[k];
      if (typeof val === 'string' && val.trim()) return val;
    }

    for (const nested of Object.values(record)) {
      const found = visit(nested);
      if (found !== null) return found;
    }

    return null;
  }

  return visit(obj);
}

function deepFindNum(obj: unknown, keys: string[]): number | null {
  const seen = new Set<object>();

  function visit(value: unknown): number | null {
    if (value === null || value === undefined || typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);

    const record = value as Record<string, unknown>;
    for (const k of keys) {
      const val = record[k];
      if (typeof val === 'number' && Number.isFinite(val)) return val;
    }

    for (const nested of Object.values(record)) {
      const found = visit(nested);
      if (found !== null) return found;
    }

    return null;
  }

  return visit(obj);
}

function extractToolName(e: unknown): string {
  return deepFindStr(e, ['name', 'toolName', 'tool_name']) ?? 'unknown_tool';
}

function parseToolInputValue(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return (parsed && typeof parsed === 'object') ? (parsed as Record<string, unknown>) : { command: trimmed };
  } catch {
    return { command: trimmed };
  }
}

function extractToolInput(e: unknown): Record<string, unknown> {
  if (typeof e !== 'object' || e === null) return {};
  const o = e as Record<string, unknown>;
  const tool = o['tool'];
  const tc = o['toolCall'];
  const toolInput = (typeof tool === 'object' && tool !== null)
    ? (tool as Record<string, unknown>)['input']
    : undefined;
  const tcInput = (typeof tc === 'object' && tc !== null)
    ? (tc as Record<string, unknown>)['input']
    : undefined;
  const tcFnArgs = (typeof tc === 'object' && tc !== null)
    ? ((): unknown => {
        const fn = (tc as Record<string, unknown>)['function'];
        return (typeof fn === 'object' && fn !== null)
          ? (fn as Record<string, unknown>)['arguments']
          : undefined;
      })()
    : undefined;
  return parseToolInputValue(o['input'] ?? toolInput ?? tcInput ?? o['arguments'] ?? tcFnArgs ?? {});
}

function formatToolLabel(toolName: string, toolInput: Record<string, unknown>): string {
  const filePath = toolInput['path'] ?? toolInput['file_path'] ?? toolInput['target_file'] ?? toolInput['filePath'];
  if (typeof filePath === 'string' && filePath.trim()) {
    return `${toolName}(${filePath.trim()})`;
  }
  const command = toolInput['command'] ?? toolInput['cmd'];
  if (typeof command === 'string' && command.trim()) {
    return `${toolName}(${command.trim()})`;
  }
  const pattern = toolInput['pattern'] ?? toolInput['query'] ?? toolInput['regex'];
  if (typeof pattern === 'string' && pattern.trim()) {
    return `${toolName}(${pattern.trim()})`;
  }
  return toolName;
}

// ── Session event handler registration ───────────────────────────────────────
function registerSessionEventHandlers(
  session: CopilotSession,
): { toolCallCount: number; toolsByKind: Record<string, number> } {
  const state = { toolCallCount: 0, toolsByKind: {} as Record<string, number> };
  const toolTimers: Record<string, number> = {};

  session.on('tool.execution_start', (e) => {
    state.toolCallCount++;
    const event = e as unknown;
    const toolName = extractToolName(event);
    const toolInput = extractToolInput(event);
    const label = formatToolLabel(toolName, toolInput);
    const callId = `${toolName}_${state.toolCallCount}`;
    toolTimers[callId] = Date.now();
    const prevCount = state.toolsByKind[toolName] ?? 0;
    state.toolsByKind[toolName] = prevCount + 1;
    process.stderr.write(`[tool] #${state.toolCallCount} ${label}\n`);
    emitEvent('tool.execution_start', { name: toolName, input: toolInput, callId, callNumber: state.toolCallCount });
  });

  session.on('tool.execution_complete', (e) => {
    const event = e as unknown;
    const toolName = extractToolName(event);
    const output = deepFindStr(event, ['output', 'result', 'content']);
    let durationMs: number | null = null;
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
      status: deepFindStr(event, ['status', 'result']) ?? 'success',
    });
  });

  session.on('tool.execution_progress', (e) => {
    const event = e as unknown;
    const toolName = extractToolName(event);
    emitEvent('tool.execution_progress', {
      name: toolName,
      message: deepFindStr(event, ['message', 'progress', 'text']),
    });
  });

  session.on('assistant.streaming_delta', (e) => {
    const event = e as unknown;
    const delta = deepFindStr(event, ['delta', 'content', 'text']);
    if (delta) emitEvent('assistant.streaming_delta', { delta });
  });

  session.on('assistant.message', (e) => {
    const event = e as unknown;
    const content = deepFindStr(event, ['content', 'text', 'message']);
    emitEvent('assistant.message', { content: content ? content.slice(0, 3000) : null });
  });

  session.on('assistant.usage', (e) => {
    const event = e as unknown;
    const inputTokens = deepFindNum(event, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']);
    const outputTokens = deepFindNum(event, ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens']);
    const cacheRead = deepFindNum(event, ['cacheReadTokens', 'cache_read_tokens', 'cacheReadInputTokens']);
    const cacheWrite = deepFindNum(event, ['cacheWriteTokens', 'cache_write_tokens', 'cacheCreationInputTokens']);
    emitEvent('assistant.usage', {
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      model: deepFindStr(event, ['model']) ?? COPILOT_MODEL,
    });
  });

  session.on('session.usage_info', (e) => {
    const event = e as unknown;
    const tokenLimit = deepFindNum(event, ['tokenLimit']);
    const currentTokens = deepFindNum(event, ['currentTokens']);
    emitEvent('session.usage_info', {
      tokenLimit,
      currentTokens,
      model: deepFindStr(event, ['model']) ?? COPILOT_MODEL,
    });
  });

  session.on('session.error', (e) => {
    const event = e as unknown;
    const msg = deepFindStr(event, ['message', 'error', 'reason'])
      ?? (typeof event === 'string' ? event : String(event));
    emitEvent('session.error', { message: msg });
  });

  session.on('permission.requested', (e) => {
    const event = e as unknown;
    emitEvent('permission.requested', {
      tool: deepFindStr(event, ['tool', 'name', 'toolName']),
      reason: deepFindStr(event, ['reason', 'message']),
    });
  });

  return state;
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

  process.stderr.write(`review mode: model=${COPILOT_MODEL}\n`);
  emitEvent('session.start', { mode: 'review', model: COPILOT_MODEL });

  const { session, client, localCliServer } = await runSession(reviewPrompt);

  try {
    registerSessionEventHandlers(session);
    emitEvent('review.prompt_sent', { promptLength: reviewPrompt.length });
    process.stderr.write('sending review prompt\n');

    const heartbeat = setInterval(() => {
      process.stderr.write(`review agent working… (model=${COPILOT_MODEL})\n`);
    }, 30_000);

    let response: AssistantMessageEvent | undefined;
    try {
      response = await session.sendAndWait({ prompt: reviewPrompt }, 9 * 60 * 1000);
    } finally {
      clearInterval(heartbeat);
    }

    await session.disconnect().catch(() => { /* ignore */ });

    const rawOutput = response?.data.content ?? '';
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
    await client.stop().catch(() => { /* ignore */ });
    localCliServer.child.kill('SIGTERM');
  }
}

// ── Main (code-generation mode) ───────────────────────────────────────────────
async function main(): Promise<AgentResult> {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN env var is required');

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

  process.stderr.write(
    `starting Copilot SDK client (mode=local-headless, model=${COPILOT_MODEL})\n`,
  );

  const { session, client, localCliServer } = await runSession(userPrompt);

  let result: AgentResult = {
    status: 'failed',
    modifiedFiles: [],
    summary: 'Internal error: result not set',
    agentLogs: '',
    metadata: { adapter: 'copilot-sdk', model: COPILOT_MODEL },
  };

  try {
    emitEvent('session.start', { model: COPILOT_MODEL, workingDirectory: REPO_PATH });

    const handlerState = registerSessionEventHandlers(session);
    process.stderr.write('sending task prompt\n');

    const heartbeat = setInterval(() => {
      process.stderr.write(`agent working… (${handlerState.toolCallCount} tool call(s) so far)\n`);
    }, 30_000);

    let response: AssistantMessageEvent | undefined;
    try {
      response = await session.sendAndWait({ prompt: userPrompt }, 3_540_000);
    } finally {
      clearInterval(heartbeat);
    }

    const rawContent = response?.data.content ?? 'Task completed';
    const summary = rawContent.trim().slice(0, 1000);
    process.stderr.write('session idle — collecting changes\n');
    emitEvent('session.end', {
      toolCallCount: handlerState.toolCallCount,
      toolsByKind: handlerState.toolsByKind,
      model: COPILOT_MODEL,
    });

    await session.disconnect();

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
            const squashResult = squashIntoBaseIfNeeded(baseSha, REPO_PATH);
            if (squashResult.squashed && squashResult.commits != null) {
              rootCommits = squashResult.commits;
              if (REPOSITORY_MAP?.superproject != null) {
                const spKey = REPOSITORY_MAP.superproject.repoKey;
                for (const c of rootCommits) {
                  if (c.repoKey === 'superproject') c.repoKey = spKey;
                }
              }
            }

            // Resolve the existing Change-Id for the root repo.
            let rootExistingChangeId: string | null = ROOT_CHANGE_ID;
            let rootRepoKey: string | null = null;

            if (PER_REPO_CHANGE_IDS != null) {
              const superprojectKey = REPOSITORY_MAP?.superproject?.repoKey;
              if (superprojectKey != null) {
                const entry = PER_REPO_CHANGE_IDS[superprojectKey];
                if (entry != null) {
                  rootRepoKey = superprojectKey;
                  if (!rootExistingChangeId) {
                    rootExistingChangeId = typeof entry === 'string' ? entry : (entry['0'] ?? null);
                  }
                } else if (!rootExistingChangeId) {
                  // Fallback: try the sole key in PER_REPO_CHANGE_IDS
                  const keys = Object.keys(PER_REPO_CHANGE_IDS);
                  if (keys.length === 1) {
                    const k0 = keys[0];
                    if (k0 != null) {
                      rootRepoKey = k0;
                      const e0 = PER_REPO_CHANGE_IDS[k0];
                      if (e0 != null) {
                        rootExistingChangeId = typeof e0 === 'string' ? e0 : (e0['0'] ?? null);
                      }
                    }
                  }
                }
              } else if (!rootExistingChangeId) {
                const keys = Object.keys(PER_REPO_CHANGE_IDS);
                if (keys.length === 1) {
                  const k0 = keys[0];
                  if (k0 != null) {
                    rootRepoKey = k0;
                    const e0 = PER_REPO_CHANGE_IDS[k0];
                    if (e0 != null) {
                      rootExistingChangeId = typeof e0 === 'string' ? e0 : (e0['0'] ?? null);
                    }
                  }
                }
              }
            }

            rootCommits = injectChangeIds(baseSha, rootCommits, TASK_ID, REPO_PATH, {
              existingChangeId: rootExistingChangeId,
              repoKeyForLookup: rootRepoKey,
              perRepoChangeIds: PER_REPO_CHANGE_IDS,
              gitAuthorName: GIT_AUTHOR_NAME,
              gitAuthorEmail: GIT_AUTHOR_EMAIL,
              gitCommitterName: GIT_COMMITTER_NAME,
              gitCommitterEmail: GIT_COMMITTER_EMAIL,
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
          metadata: { adapter: 'copilot-sdk', model: COPILOT_MODEL, agentCommits: true },
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
            model: COPILOT_MODEL,
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
          metadata: { adapter: 'copilot-sdk', model: COPILOT_MODEL },
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
            model: COPILOT_MODEL,
            missingCommits: true,
            toolCallCount: handlerState.toolCallCount,
            toolsByKind: handlerState.toolsByKind,
          },
        };
      }
    }
  } finally {
    await client.stop().catch(() => { /* ignore */ });
    localCliServer.child.kill('SIGTERM');
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
