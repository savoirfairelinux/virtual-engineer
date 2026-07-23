/**
 * Virtual Engineer — Aider session runner (agent worker).
 *
 * Runs INSIDE the Docker container for the `aider` provider. Aider is a Python
 * CLI (https://aider.chat) that wraps any LLM backend via litellm. This runner
 * spawns `aider --message-file <prompt> --yes --no-pretty --no-stream` as a
 * subprocess against the pre-cloned `/workspace` repository and maps its
 * streamed output onto the shared `__ve_event` stderr protocol used by every
 * provider, so the host adapter's event / commit / result pipeline is
 * provider-agnostic.
 *
 * The agent edits files and creates git commits via Aider's built-in tools;
 * commit collection is handled by the caller after this runner returns the
 * assistant's final text.
 *
 * Authentication is via the process environment: the host adapter injects the
 * backend's litellm env var(s) (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
 * `OLLAMA_API_BASE`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`,
 * `OPENAI_API_BASE`). This runner never clones and never pushes.
 */
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { emitEvent } from './events.js';
import type { AgentProviderDefinition, AgentRun, AgentRunOptions } from './types.js';

// Git identity forwarded into the aider subprocess environment.
const GIT_AUTHOR_NAME = process.env['GIT_AUTHOR_NAME'] ?? 'Virtual Engineer';
const GIT_AUTHOR_EMAIL = process.env['GIT_AUTHOR_EMAIL'] ?? 've@virtual-engineer.local';
const GIT_COMMITTER_NAME = process.env['GIT_COMMITTER_NAME'] ?? GIT_AUTHOR_NAME;
const GIT_COMMITTER_EMAIL = process.env['GIT_COMMITTER_EMAIL'] ?? GIT_AUTHOR_EMAIL;

interface AiderNativeOptions {
  chatMode?: 'code' | 'architect';
  reasoningEffort?: string;
  thinkingTokens?: number;
  mapTokens?: number;
  autoLint: boolean;
  autoTest: boolean;
}

function positiveNumberFromEnv(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveAiderNativeOptions(): AiderNativeOptions {
  const chatMode = process.env['AIDER_CHAT_MODE'];
  const reasoningEffort = process.env['AIDER_REASONING_EFFORT']?.trim();
  const thinkingTokens = positiveNumberFromEnv('AIDER_THINKING_TOKENS');
  const mapTokens = positiveNumberFromEnv('AIDER_MAP_TOKENS');
  return {
    ...(chatMode === 'code' || chatMode === 'architect' ? { chatMode } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(thinkingTokens !== undefined ? { thinkingTokens } : {}),
    ...(mapTokens !== undefined ? { mapTokens } : {}),
    autoLint: process.env['AIDER_AUTO_LINT'] === '1',
    autoTest: process.env['AIDER_AUTO_TEST'] === '1',
  };
}

/**
 * Conventional-commit commit-prompt injected via `--commit-prompt` so Aider's
 * auto-commits satisfy the worker's `validateCommits` regex
 * (`^(feat|fix|refactor|test|chore|docs|perf|ci|build)(\([^)]+\))?: .{1,72}$`).
 */
const CONVENTIONAL_COMMIT_PROMPT =
  'Write the commit message in Conventional Commits format: ' +
  '<type>(<scope>): <subject>. Type is one of feat, fix, refactor, test, chore, ' +
  'docs, perf, ci, build. Subject is imperative, lowercase, max 72 chars. ' +
  'Do not add a body or Co-authored-by trailer. Output only the single line.';

/**
 * Environment Variable Allowlist (Security):
 * The subprocess receives only whitelisted env vars to prevent secrets leakage.
 * The backend auth vars are forwarded so litellm can reach the upstream LLM.
 *
 * The allowlist is deliberately scoped to the six supported Aider backends
 * (openai, anthropic, ollama, openrouter, deepseek, openai_compat). Unrelated
 * cloud credentials (Azure / AWS / Vertex / Gemini) are intentionally excluded
 * to minimise the blast radius if such secrets ever leak into the host env.
 */
function buildAiderEnv(): Record<string, string> {
  const allowlist = [
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'USER',
    'XDG_RUNTIME_DIR',
    'LANG',
    'LC_ALL',
    // Git identity (Aider attributes commits).
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
    // Aider model + backend auth (litellm env vars) — supported backends only.
    'AIDER_MODEL',
    'OPENAI_API_KEY',      // openai, openai_compat
    'OPENAI_API_BASE',     // openai_compat
    'ANTHROPIC_API_KEY',   // anthropic
    'OLLAMA_API_BASE',     // ollama
    'OLLAMA_API_KEY',      // ollama (optional auth)
    'OPENROUTER_API_KEY',  // openrouter
    'DEEPSEEK_API_KEY',    // deepseek
  ];
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined && value !== '') {
      env[key] = value;
    }
  }
  // Always provide git identity defaults so Aider can commit.
  env['GIT_AUTHOR_NAME'] = GIT_AUTHOR_NAME;
  env['GIT_AUTHOR_EMAIL'] = GIT_AUTHOR_EMAIL;
  env['GIT_COMMITTER_NAME'] = GIT_COMMITTER_NAME;
  env['GIT_COMMITTER_EMAIL'] = GIT_COMMITTER_EMAIL;
  return env;
}

/** Resolve the aider binary path. Falls back to `aider` on PATH. */
function resolveAiderBinary(): string {
  // The Dockerfile symlinks the uv-installed aider to /usr/local/bin/aider.
  return process.env['AIDER_BIN'] ?? 'aider';
}

/** Build the aider argv for a single-message, non-interactive session. */
function buildAiderArgs(
  promptFile: string,
  options: AgentRunOptions,
  nativeOptions: AiderNativeOptions,
): string[] {
  const { mode } = options;
  const baseArgs = [
    '--message-file', promptFile,
    '--yes',
    '--no-pretty',
    nativeOptions.autoLint && mode === 'codegen' ? '--auto-lint' : '--no-auto-lint',
    nativeOptions.autoTest && mode === 'codegen' ? '--auto-test' : '--no-auto-test',
    '--no-check-update',
    '--no-show-release-notes',
    '--no-analytics',
    '--no-suggest-shell-commands',
    '--no-fancy-input',
    '--no-detect-urls',
    '--no-attribute-co-authored-by',
  ];

  if (mode === 'review') {
    // --chat-mode ask keeps Aider in pure text-response mode. Without it, Aider
    // defaults to "whole edit format" and the LLM tries to output complete file
    // contents instead of the REVIEW_RESULT_START…END block we parse.
    //
    // --no-git disables Aider's git integration entirely. This is required because
    // the review container mounts /workspace read-only (`:ro`), and Aider's
    // setup_git() unconditionally tries to write /workspace/.git/config.lock to
    // set user.name/user.email even in ask mode, crashing with EROFS. No commits
    // are made in review mode so git integration is not needed; Aider still scans
    // the filesystem for its context window.
    //
    // --no-stream is intentionally omitted here: thinking models (e.g. qwen3-coder,
    // DeepSeek-R1) generate long reasoning chains before the final answer. With
    // --no-stream, Aider blocks the entire HTTP response until reasoning completes,
    // which can take many minutes and may hit connection timeouts. Streaming lets
    // tokens arrive incrementally, keeping the request alive and showing progress.
    //
    // No hard output token cap: repeat_penalty is injected via an Aider model-settings
    // file (written by the runner below when OLLAMA_API_BASE is set) to prevent
    // repetition loops without artificially truncating the response.
    return [
      ...baseArgs,
      '--no-git',
      '--chat-mode', 'ask',
      '--no-auto-commits',
      '--no-dirty-commits',
    ];
  }

  // Coding mode: git + auto-commits with conventional-commit prompt.
  return [
    ...baseArgs,
    '--no-stream',
    '--git',
    '--no-gitignore',
    '--auto-commits',
    '--dirty-commits',
    ...(nativeOptions.chatMode ? ['--chat-mode', nativeOptions.chatMode] : []),
    '--commit-prompt', CONVENTIONAL_COMMIT_PROMPT,
  ];
}

/** Run an Aider CLI session and return the assistant's final text + tool stats. */
export async function runAiderAgent(
  prompt: string,
  options: AgentRunOptions,
): Promise<AgentRun> {
  const { model, agentInstructions, cwd, timeoutMs, mode } = options;
  const modelLabel = model || 'aider-default';

  emitEvent('session.start', { model: modelLabel, mode, workingDirectory: cwd });
  process.stderr.write(`starting Aider CLI (mode=${mode}, model=${modelLabel})\n`);

  // Keep the workflow request separate from permanent agent instructions.
  // Aider loads the latter as a read-only convention file.
  const tmpDir = mkdtempSync(join(tmpdir(), 've-aider-'));
  const promptFile = join(tmpDir, 'prompt.txt');
  const agentInstructionsFile = join(tmpDir, 'agent-instructions.md');
  writeFileSync(promptFile, prompt, 'utf8');
  writeFileSync(agentInstructionsFile, agentInstructions, 'utf8');

  // For Ollama backends, write a model-settings YAML so Aider forwards
  // repeat_penalty to the Ollama API. This prevents repetition loops where the
  // model generates the same tokens indefinitely without completing the response.
  // Aider has no --max-tokens CLI flag; the model-settings file is the correct hook.
  let modelSettingsFile: string | null = null;
  if (process.env['OLLAMA_API_BASE']) {
    modelSettingsFile = join(tmpDir, 'model-settings.yml');
    writeFileSync(
      modelSettingsFile,
      '- name: "ollama_chat/*"\n  extra_params:\n    repeat_penalty: 1.15\n    repeat_last_n: 128\n',
      'utf8'
    );
  }

  const nativeOptions = resolveAiderNativeOptions();
  const args = buildAiderArgs(promptFile, options, nativeOptions);
  args.push('--read', agentInstructionsFile);
  if (nativeOptions.reasoningEffort) {
    args.push('--reasoning-effort', nativeOptions.reasoningEffort);
  }
  if (nativeOptions.thinkingTokens !== undefined) {
    args.push('--thinking-tokens', String(nativeOptions.thinkingTokens));
  }
  if (nativeOptions.mapTokens !== undefined) {
    args.push('--map-tokens', String(nativeOptions.mapTokens));
  }
  if (modelSettingsFile) {
    args.push('--model-settings-file', modelSettingsFile);
  }
  const env = buildAiderEnv();
  if (model) {
    args.push('--model', model);
  }

  const state = { toolCallCount: 0, toolsByKind: {} as Record<string, number> };
  let content = '';
  let assistantText = '';
  let stderrAccum = '';

  const child = spawn(resolveAiderBinary(), args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const cleanup = async (): Promise<void> => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  const timer = setTimeout(() => {
    child.kill('SIGTERM');
  }, timeoutMs);

  const heartbeat = setInterval(() => {
    process.stderr.write(`agent working… (${state.toolCallCount} edit(s) so far)\n`);
  }, 30_000);

  // Line buffer for stdout: streaming mode delivers partial lines across
  // multiple 'data' events; accumulate until a newline before parsing.
  let stdoutBuf = '';

  const flushStdoutLine = (line: string): void => {
    processAiderLine(line.trimEnd(), state, (chunk) => { assistantText += chunk; });
  };

  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) flushStdoutLine(line);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stderrAccum += text;
        processAiderStderr(text, state);
      });
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        // Flush any trailing output not terminated by a newline.
        if (stdoutBuf.trim()) flushStdoutLine(stdoutBuf);
        if (code !== null && code !== 0) {
          reject(new Error(buildExitError(code, stderrAccum)));
          return;
        }
        resolve();
      });
    });
  } catch (err) {
    clearInterval(heartbeat);
    clearTimeout(timer);
    await cleanup();
    const message = err instanceof Error ? err.message : String(err);
    emitEvent('session.error', { message });
    throw err;
  }

  clearInterval(heartbeat);
  clearTimeout(timer);
  await cleanup();

  // Aider's final assistant message is the last non-empty stdout block. For
  // review mode, the full stdout is the raw review text the host parses.
  content = mode === 'review' ? assistantText : (assistantText || content);

  emitEvent('session.end', {
    mode,
    toolCallCount: state.toolCallCount,
    toolsByKind: state.toolsByKind,
    model: modelLabel,
    outputLength: content.length,
  });

  return {
    content: content || 'Task completed',
    toolCallCount: state.toolCallCount,
    toolsByKind: state.toolsByKind,
    cleanup: async (): Promise<void> => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    },
  };
}

export const AIDER_PROVIDER: AgentProviderDefinition = {
  id: 'aider',
  adapterLabel: 'aider-cli',
  resolveModel: () => process.env['AIDER_MODEL'] ?? '',
  defaultModelLabel: 'aider-default',
  runner: runAiderAgent,
};

/**
 * Build a descriptive error message from an Aider non-zero exit code.
 * Extracts the last error-class line from the accumulated stderr so the
 * operator sees the actual exception rather than just the exit code.
 */
function buildExitError(code: number, stderr: string): string {
  const base = `Aider exited with code ${code}`;
  if (!stderr.trim()) return base;

  // Walk lines from the end; prefer a line that names a Python exception.
  const lines = stderr.split('\n');
  let errorLine: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? '';
    if (!line) continue;
    if (/Error:|Exception:|OSError:|IOError:|RuntimeError:|ValueError:/.test(line)) {
      errorLine = line;
      break;
    }
  }
  // Fall back to the last non-empty line.
  if (!errorLine) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim() ?? '';
      if (line) { errorLine = line; break; }
    }
  }
  if (!errorLine) return base;
  // Cap to 300 chars to keep the log readable.
  const summary = errorLine.length > 300 ? errorLine.slice(0, 297) + '...' : errorLine;
  return `${base}: ${summary}`;
}

/**
 * Parse a single line of Aider stdout. Aider prints assistant text, file-edit
 * announcements, and commit subjects. We emit `__ve_event`s for edits and
 * commits, and accumulate assistant text for the final result.
 */
function processAiderLine(
  line: string,
  state: { toolCallCount: number; toolsByKind: Record<string, number> },
  onAssistant: (chunk: string) => void,
): void {
  if (!line) return;

  // Aider announces edits like "Editing file: src/foo.ts" or "Applied edit to src/foo.ts".
  // The optional "file:" prefix is stripped so the captured path is the bare path.
  const editMatch = line.match(/^(?:Editing|Applied edit to|Created)\s+(?:file:\s*)?(.+)$/);
  if (editMatch) {
    const filePath = editMatch[1]!.trim();
    state.toolCallCount++;
    state.toolsByKind['edit'] = (state.toolsByKind['edit'] ?? 0) + 1;
    process.stderr.write(`[tool] #${state.toolCallCount} edit(${filePath})\n`);
    emitEvent('tool.execution_start', { name: 'edit', input: { path: filePath }, callNumber: state.toolCallCount });
    return;
  }

  // Aider commits with a subject line; detect "commit <sha>" announcements.
  const commitMatch = line.match(/^commit ([0-9a-f]{7,40})/);
  if (commitMatch) {
    emitEvent('commit.created', { sha: commitMatch[1] });
    return;
  }

  // Token / cost line: "Tokens: 1234 sent, 567 received. Cost: $0.01"
  const tokenMatch = line.match(/Tokens?:\s*(\d+)\s*sent,\s*(\d+)\s*received/i);
  if (tokenMatch) {
    const inputTokens = Number(tokenMatch[1]);
    const outputTokens = Number(tokenMatch[2]);
    const costMatch = line.match(/Cost:\s*\$([\d.]+)/i);
    emitEvent('assistant.usage', {
      inputTokens,
      outputTokens,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: costMatch ? Number(costMatch[1]) : null,
    });
    return;
  }

  // Otherwise treat as assistant text (Aider prints the assistant reply to stdout).
  onAssistant(line + '\n');
  if (line.length > 0) {
    emitEvent('assistant.message', { content: line.slice(0, 3000) });
  }
}

/** Parse a chunk of Aider stderr — mostly progress/warnings; emit as plain events. */
function processAiderStderr(
  text: string,
  _state: { toolCallCount: number; toolsByKind: Record<string, number> },
): void {
  // Aider writes progress/warnings to stderr; forward verbatim so the host
  // adapter's stderr parser captures them as plain log lines.
  process.stderr.write(text);
}