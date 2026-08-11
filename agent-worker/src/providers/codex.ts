/**
 * Virtual Engineer — Codex session runner (agent worker).
 *
 * Runs INSIDE the Docker container for the `codex` provider. Codex CLI
 * (https://github.com/openai/codex) is a standalone Rust binary — unlike
 * Claude/Copilot there is no embeddable Node SDK, so this runner spawns
 * `codex exec --json` as a subprocess against the pre-cloned repository
 * working directory and maps its streamed JSONL output onto the shared
 * `__ve_event` stderr protocol used by every provider, exactly like the Goose
 * runner (`./goose.ts`).
 *
 * Unlike Aider (text transport), Codex uses **MCP submission transport**: the
 * runner writes a Codex `config.toml` that registers the VE MCP submission
 * server (`/app/agent-worker/dist/mcpSubmissionServer.js`) as a stdio MCP
 * server, so Codex calls `ve_submit_changes` / `ve_submit_review` to deliver
 * the structured result. The worker then reads the submission file and
 * asserts exactly one accepted tool call, exactly like Copilot/Claude/Goose.
 *
 * Authentication: the host adapter injects exactly one of `CODEX_API_KEY`
 * (honored directly by `codex exec`, no bootstrap needed) or
 * `CODEX_ACCESS_TOKEN` (a subscription access token — this runner bootstraps
 * it via `codex login --with-access-token` before the exec call, since Codex
 * has no exec-time env var for session auth).
 */
import { spawn } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { emitEvent } from './events.js';
import type { AgentProviderDefinition, AgentRun, AgentRunOptions, ObservedToolCall } from './types.js';
import {
  CHANGE_SUBMISSION_JSON_SCHEMA,
  appendSubmissionInstruction,
  buildSubmissionMcpConfig,
} from '../mcpSubmission.js';

const GIT_AUTHOR_NAME = process.env['GIT_AUTHOR_NAME'] ?? 'Virtual Engineer';
const GIT_AUTHOR_EMAIL = process.env['GIT_AUTHOR_EMAIL'] ?? 've@virtual-engineer.local';
const GIT_COMMITTER_NAME = process.env['GIT_COMMITTER_NAME'] ?? GIT_AUTHOR_NAME;
const GIT_COMMITTER_EMAIL = process.env['GIT_COMMITTER_EMAIL'] ?? GIT_AUTHOR_EMAIL;

const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);

function resolveCodexReasoningEffort(): string | undefined {
  const value = process.env['CODEX_REASONING_EFFORT'];
  return value !== undefined && REASONING_EFFORTS.has(value) ? value : undefined;
}

/** Resolve the codex binary path. Falls back to `codex` on PATH. */
function resolveCodexBinary(): string {
  // The Dockerfile installs the Codex CLI via `npm install -g @openai/codex`.
  return process.env['CODEX_BIN'] ?? 'codex';
}

/** `$CODEX_HOME` per the Codex CLI convention — defaults to `~/.codex`. */
function resolveCodexHome(): string {
  return process.env['CODEX_HOME'] ?? join(homedir(), '.codex');
}

/**
 * Environment Variable Allowlist (Security): the subprocess receives only
 * whitelisted env vars to prevent secrets leakage.
 */
function buildCodexEnv(): Record<string, string> {
  const allowlist = [
    'PATH',
    'HOME',
    'CODEX_HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'USER',
    'LANG',
    'LC_ALL',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
    'CODEX_API_KEY',
  ];
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined && value !== '') {
      env[key] = value;
    }
  }
  env['GIT_AUTHOR_NAME'] = GIT_AUTHOR_NAME;
  env['GIT_AUTHOR_EMAIL'] = GIT_AUTHOR_EMAIL;
  env['GIT_COMMITTER_NAME'] = GIT_COMMITTER_NAME;
  env['GIT_COMMITTER_EMAIL'] = GIT_COMMITTER_EMAIL;
  return env;
}

/**
 * Bootstrap a subscription (access-token) login before `codex exec` runs.
 * Codex has no exec-time env var for session auth (unlike `CODEX_API_KEY`),
 * so the token is piped into `codex login --with-access-token`, which
 * persists credentials to `$CODEX_HOME/auth.json`.
 */
async function bootstrapCodexAccessTokenLogin(env: Record<string, string>): Promise<void> {
  const token = process.env['CODEX_ACCESS_TOKEN'];
  if (!token) return;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(resolveCodexBinary(), ['login', '--with-access-token'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderrAccum = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderrAccum += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) { resolve(); return; }
      reject(new Error(`codex login --with-access-token failed (exit ${String(code)}): ${stderrAccum.slice(0, 500)}`));
    });
    child.stdin?.end(`${token}\n`);
  });
}

/**
 * Write `$CODEX_HOME/config.toml` registering the VE MCP submission server as
 * a stdio MCP server, so Codex calls `ve_submit_changes` / `ve_submit_review`
 * to deliver the structured result. `required = true` fails the run instead
 * of silently proceeding without the submission tool available.
 */
function writeCodexConfig(submissionServer: { command: string; args: string[]; env: Record<string, string> }): string {
  const codexHome = resolveCodexHome();
  mkdirSync(codexHome, { recursive: true });
  const configPath = join(codexHome, 'config.toml');

  const lines: string[] = [
    '# Written by Virtual Engineer agent-worker for the codex provider.',
    '[mcp_servers.ve-submission]',
    `command = ${JSON.stringify(submissionServer.command)}`,
    `args = ${JSON.stringify(submissionServer.args)}`,
    'required = true',
    '',
    '[mcp_servers.ve-submission.env]',
    ...Object.entries(submissionServer.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`),
  ];

  writeFileSync(configPath, lines.join('\n') + '\n', 'utf8');
  process.stderr.write(`codex config written to ${configPath}\n`);
  return configPath;
}

/** Build the codex exec argv. Prompt is always piped via stdin (`-` sentinel). */
function buildCodexArgs(cwd: string, options: AgentRunOptions): string[] {
  const nativeReview = options.mode === 'review' && options.reviewStrategy === 'codex_native';
  const sandboxMode = options.mode === 'review' ? 'read-only' : 'danger-full-access';
  const model = nativeReview ? undefined : options.model;
  const reasoningEffort = nativeReview ? undefined : resolveCodexReasoningEffort();
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--cd', cwd,
    '--sandbox', sandboxMode,
    '--ask-for-approval', 'never',
    ...(model ? ['--model', model] : []),
    ...(reasoningEffort ? ['-c', `model_reasoning_effort=${reasoningEffort}`] : []),
    '-',
  ];
}

interface CodexRunState {
  toolCallCount: number;
  toolsByKind: Record<string, number>;
  toolCalls: ObservedToolCall[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Process one JSONL line from `codex exec --json` stdout. Item types observed
 * (per Codex CLI docs): `agent_message`, `command_execution`, `file_change`,
 * `mcp_tool_call`, `reasoning`, `web_search`, `plan_update`. The exact shape of
 * `mcp_tool_call` (tool-name field, success signal) is not fully documented —
 * this parser is defensive and needs live-CLI verification.
 */
function processCodexLine(
  line: string,
  state: CodexRunState,
  onAssistantText: (text: string) => void,
  modelLabel: string,
): void {
  if (!line) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // Non-JSON stray output — ignore rather than crash the run.
  }
  const event = asRecord(parsed);
  if (!event) return;
  const type = typeof event['type'] === 'string' ? event['type'] : '';

  if (type === 'turn.failed' || type === 'error') {
    const message = typeof event['message'] === 'string' ? event['message'] : JSON.stringify(event);
    throw new Error(`Codex ${type}: ${message}`);
  }

  if (type === 'turn.completed') {
    const usage = asRecord(event['usage']);
    if (usage) {
      emitEvent('assistant.usage', {
        inputTokens: numberOrNull(usage['input_tokens']),
        outputTokens: numberOrNull(usage['output_tokens']),
        cacheReadTokens: numberOrNull(usage['cached_input_tokens']),
        cacheWriteTokens: null,
        model: modelLabel,
      });
    }
    return;
  }

  if (type !== 'item.started' && type !== 'item.completed') return;
  const item = asRecord(event['item']);
  if (!item) return;
  const itemType = typeof item['type'] === 'string' ? item['type'] : '';
  const isCompleted = type === 'item.completed';

  if (itemType === 'agent_message') {
    if (isCompleted && typeof item['text'] === 'string' && item['text']) {
      onAssistantText(item['text']);
      emitEvent('assistant.message', { content: item['text'].slice(0, 3000) });
    }
    return;
  }

  if (itemType === 'mcp_tool_call' || itemType === 'command_execution' || itemType === 'file_change') {
    const toolName = itemType === 'mcp_tool_call'
      ? (typeof item['tool'] === 'string' ? item['tool'] : itemType)
      : itemType;
    if (!isCompleted) {
      state.toolCallCount++;
      state.toolsByKind[toolName] = (state.toolsByKind[toolName] ?? 0) + 1;
      emitEvent('tool.execution_start', { name: toolName, callNumber: state.toolCallCount });
      return;
    }
    const status = typeof item['status'] === 'string' ? item['status'] : '';
    const success = status === 'completed' || status === 'success' || item['success'] === true;
    const errorMessage = typeof item['error'] === 'string' ? item['error'] : undefined;
    state.toolCalls.push({
      name: toolName,
      input: {},
      success,
      ...(errorMessage !== undefined ? { error: errorMessage } : {}),
    });
    emitEvent('tool.execution_complete', { name: toolName, success });
  }
}

function buildExitError(code: number | null, stderrAccum: string): string {
  const tail = stderrAccum.trim().split('\n').slice(-20).join('\n');
  return `Codex CLI exited with code ${code ?? 'null'}${tail ? `: ${tail}` : ''}`;
}

/** Run a Codex CLI session and return the assistant's final text + tool stats. */
export async function runCodexAgent(
  prompt: string,
  options: AgentRunOptions,
): Promise<AgentRun> {
  const { model, agentInstructions, cwd, timeoutMs, mode, reviewOutputSchema, reviewStrategy } = options;
  const modelLabel = mode === 'review' && reviewStrategy === 'codex_native'
    ? 'CLI-managed'
    : (model || 'cli-default');

  emitEvent('session.start', { model: modelLabel, mode, workingDirectory: cwd });
  process.stderr.write(`starting Codex CLI (mode=${mode}, model=${modelLabel})\n`);

  const submissionSchema = mode === 'review' ? reviewOutputSchema : CHANGE_SUBMISSION_JSON_SCHEMA;
  if (submissionSchema === undefined) {
    throw new Error(
      mode === 'review'
        ? 'REVIEW_OUTPUT_SCHEMA is required for Codex MCP review submissions'
        : 'Change submission schema is required for Codex MCP codegen submissions',
    );
  }
  const submission = buildSubmissionMcpConfig(mode, submissionSchema);
  const nativeReview = mode === 'review' && reviewStrategy === 'codex_native';
  const baseInstructions = nativeReview
    ? `${agentInstructions.trim()}\n\nDelegate the code analysis to a spawned subagent, then submit the findings yourself.`
    : agentInstructions;
  const fullAgentInstructions = appendSubmissionInstruction(baseInstructions, submission.toolName);

  const env = buildCodexEnv();
  await bootstrapCodexAccessTokenLogin(env);
  writeCodexConfig(submission.server);

  const tmpDir = mkdtempSync(join('/tmp', 've-codex-'));
  const args = buildCodexArgs(cwd, options);
  const fullPrompt = `${prompt}\n\n${fullAgentInstructions}`;

  const state: CodexRunState = { toolCallCount: 0, toolsByKind: {}, toolCalls: [] };
  let assistantText = '';
  let stderrAccum = '';

  const child = spawn(resolveCodexBinary(), args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin?.end(fullPrompt);

  const cleanup = (): Promise<void> => {
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
    return Promise.resolve();
  };

  const heartbeat = setInterval(() => {
    process.stderr.write(`agent working… (${state.toolCallCount} tool call(s) so far)\n`);
  }, 30_000);

  let stdoutBuf = '';
  let stderrBuf = '';
  const flushStdoutLine = (line: string): void => {
    processCodexLine(line.trimEnd(), state, (chunk) => { assistantText += chunk; }, modelLabel);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Codex session timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) {
          try {
            flushStdoutLine(line);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stderrAccum += text;
        stderrBuf += text;
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop() ?? '';
        for (const line of lines) process.stderr.write(`[codex] ${line}\n`);
      });
      child.on('error', (err) => reject(err));
      child.on('close', (code, signal) => {
        if (stdoutBuf.trim()) {
          try {
            flushStdoutLine(stdoutBuf);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
        }
        if (typeof signal === 'string') {
          reject(new Error(`Codex terminated by signal ${signal}`));
          return;
        }
        if (code !== null && code !== 0) {
          reject(new Error(buildExitError(code, stderrAccum)));
          return;
        }
        resolve();
      });
    });
  } catch (err) {
    clearInterval(heartbeat);
    if (timer) clearTimeout(timer);
    await cleanup();
    const message = err instanceof Error ? err.message : String(err);
    emitEvent('session.error', { message });
    throw err;
  }

  clearInterval(heartbeat);
  if (timer) clearTimeout(timer);
  await cleanup();

  emitEvent('session.end', {
    mode,
    toolCallCount: state.toolCallCount,
    toolsByKind: state.toolsByKind,
    model: modelLabel,
    outputLength: assistantText.length,
  });

  return {
    content: assistantText || 'Task completed',
    toolCallCount: state.toolCallCount,
    toolsByKind: state.toolsByKind,
    toolCalls: state.toolCalls,
    cleanup: (): Promise<void> => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      return Promise.resolve();
    },
  };
}

export const CODEX_PROVIDER: AgentProviderDefinition = {
  id: 'codex',
  adapterLabel: 'codex-cli',
  resolveModel: () => process.env['CODEX_MODEL'] ?? '',
  defaultModelLabel: 'cli-default',
  submissionTransport: 'mcp',
  runner: runCodexAgent,
};
