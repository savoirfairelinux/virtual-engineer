/**
 * Virtual Engineer — Cursor CLI session runner (agent worker).
 *
 * Runs INSIDE the sandbox for the `cursor` provider. Cursor CLI
 * (https://cursor.com/cli, binary `cursor-agent`) is a standalone CLI — like
 * Codex/Gemini/Goose there is no embeddable SDK this worker can drive in-
 * process, so this runner spawns the CLI as a subprocess against the
 * pre-cloned repository working directory and maps its streamed
 * `--output-format stream-json` NDJSON output onto the shared `__ve_event`
 * stderr protocol used by every provider.
 *
 * Unlike Gemini/Codex (stdin-piped prompt), Cursor's documented non-interactive
 * usage passes the prompt as the `-p`/`--print` positional argument, so this
 * runner does the same. Very large prompts could theoretically hit the OS
 * argv-length ceiling (ARG_MAX) — not yet verified against a live run with
 * VE's largest prompts (see .github/copilot-instructions.md "Further
 * Considerations").
 *
 * Like Codex/Goose/Gemini, Cursor uses **MCP submission transport**: the
 * runner writes a Cursor `mcp.json` (global scope, `$HOME/.cursor/mcp.json`)
 * that registers the VE MCP submission server
 * (`/app/agent-worker/dist/mcpSubmissionServer.js`) as a stdio MCP server, so
 * Cursor calls `ve_submit_changes` / `ve_submit_review` to deliver the
 * structured result. The worker then reads the submission file and asserts
 * exactly one accepted tool call, exactly like Copilot/Claude/Goose/Codex/
 * Gemini. Before the session starts, `cursor-agent mcp enable ve-submission`
 * approves only that server; repository-controlled MCP servers are never
 * broadly auto-approved.
 *
 * Trust: `--trust` grants workspace trust without an interactive prompt
 * (headless-mode only) — otherwise Cursor would refuse to load repository
 * config or run at all in a non-interactive session.
 *
 * Sandboxing: `--sandbox disabled` turns off Cursor's own OS-level sandbox for
 * codegen (OpenShell is the real isolation boundary, same reasoning as
 * Codex's `danger-full-access`); review uses `--mode ask` (read-only
 * exploration) instead of `--force` so changes are only proposed, not
 * applied — not yet verified live whether `--mode ask` still permits the
 * `ve_submit_review` MCP tool call (see .github/copilot-instructions.md
 * "Further Considerations", same caveat style as Gemini's `--approval-mode
 * plan`).
 *
 * Cost: Cursor's documented `stream-json` terminal `result` event has no
 * token/cost field (unlike Gemini's `stats.usage` or Aider's "Tokens: X sent"
 * line), so `assistant.usage` cannot be emitted for this provider — cost and
 * token columns stay null, a stronger limitation than other providers which
 * at least report token counts.
 *
 * Authentication: the host adapter injects `CURSOR_API_KEY`, read directly by
 * the CLI — no bootstrap login needed.
 */
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
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
const CURSOR_MCP_SETUP_TIMEOUT_MS = 30_000;
const CURSOR_MCP_TERMINATION_GRACE_MS = 2_000;

/** Resolve the cursor-agent binary path. Falls back to `cursor-agent` on PATH. */
function resolveCursorBinary(): string {
  // The Dockerfile installs the Cursor CLI via its official installer and
  // symlinks the resulting `agent` binary onto /usr/local/bin/cursor-agent.
  return process.env['CURSOR_BIN'] ?? 'cursor-agent';
}

/** Resolve the sandbox HOME, where `.cursor/mcp.json` lives (global scope). */
function resolveCursorHome(): string {
  return process.env['HOME'] ?? '/sandbox';
}

/**
 * Environment Variable Allowlist (Security): the subprocess receives only
 * whitelisted env vars to prevent secrets leakage.
 */
function buildCursorEnv(): Record<string, string> {
  const allowlist = [
    'PATH',
    'HOME',
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
    'CURSOR_API_KEY',
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
 * Write `$HOME/.cursor/mcp.json` registering the VE MCP submission server.
 * Written outside the repository working directory (HOME, not cwd) so it
 * never pollutes the agent's git status. Approval is handled separately by
 * Cursor's exact-name `mcp enable` command.
 */
function writeCursorMcpConfig(
  submissionServer: { command: string; args: string[]; env: Record<string, string> },
  home: string,
): string {
  const cursorDir = join(home, '.cursor');
  mkdirSync(cursorDir, { recursive: true });
  const configPath = join(cursorDir, 'mcp.json');
  const config = {
    mcpServers: {
      've-submission': {
        command: submissionServer.command,
        args: submissionServer.args,
        env: submissionServer.env,
      },
    },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  process.stderr.write(`cursor mcp config written to ${configPath}\n`);
  return configPath;
}

/** Reject a repository-controlled MCP server that shadows VE's trusted name. */
function assertNoProjectSubmissionMcpCollision(cwd: string): void {
  const projectConfigPath = join(cwd, '.cursor', 'mcp.json');
  if (!existsSync(projectConfigPath)) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(projectConfigPath, 'utf8'));
  } catch {
    throw new Error(
      `Cursor project MCP config '${projectConfigPath}' must be valid JSON before VE can approve its submission server`,
    );
  }
  const servers = asRecord(asRecord(parsed)?.['mcpServers']);
  if (servers && Object.prototype.hasOwnProperty.call(servers, 've-submission')) {
    throw new Error("Cursor project MCP config cannot define reserved server 've-submission'");
  }
}

/** Approve only VE's submission server before starting a headless session. */
function enableCursorSubmissionMcp(
  binary: string,
  cwd: string,
  env: Record<string, string>,
): Promise<void> {
  const child = spawn(binary, ['mcp', 'enable', 've-submission'], {
    cwd,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let stderr = '';
    let timeoutError: Error | undefined;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;
    let forceSettleTimer: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      if (error) reject(error);
      else resolve();
    };
    timer = setTimeout(() => {
      timeoutError = new Error(`Cursor MCP setup timed out after ${CURSOR_MCP_SETUP_TIMEOUT_MS}ms`);
      child.kill('SIGTERM');
      escalationTimer = setTimeout(() => {
        child.kill('SIGKILL');
        forceSettleTimer = setTimeout(() => {
          child.stderr?.destroy();
          child.unref();
          finish(timeoutError);
        }, CURSOR_MCP_TERMINATION_GRACE_MS);
      }, CURSOR_MCP_TERMINATION_GRACE_MS);
    }, CURSOR_MCP_SETUP_TIMEOUT_MS);

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (!timeoutError) finish(error);
    });
    child.on('close', (code, signal) => {
      if (timeoutError) {
        finish(timeoutError);
        return;
      }
      if (typeof signal === 'string') {
        finish(new Error(`Cursor MCP setup terminated by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-20).join('\n');
        finish(new Error(`Cursor MCP setup exited with code ${code ?? 'null'}${tail ? `: ${tail}` : ''}`));
        return;
      }
      finish();
    });
  });
}

/** Build the cursor-agent argv. Prompt is passed as the `-p` positional argument (documented usage), not piped via stdin. */
function buildCursorArgs(fullPrompt: string, options: AgentRunOptions): string[] {
  const modeArgs = options.mode === 'review'
    ? ['--mode', 'ask']
    : ['--force', '--sandbox', 'disabled'];
  return [
    '-p', fullPrompt,
    '--output-format', 'stream-json',
    '--trust',
    ...modeArgs,
    ...(options.model ? ['--model', options.model] : []),
  ];
}

interface CursorRunState {
  toolCallCount: number;
  toolsByKind: Record<string, number>;
  toolCalls: ObservedToolCall[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Derive a stable tool name plus the inner per-tool-type record from a
 * `tool_call` event's `tool_call` payload (`readToolCall`, `writeToolCall`, or
 * a generic `function` entry).
 */
function resolveTool(toolCall: Record<string, unknown> | null): { name: string; inner: Record<string, unknown> | null } {
  if (!toolCall) return { name: 'unknown_tool', inner: null };
  const readToolCall = asRecord(toolCall['readToolCall']);
  if (readToolCall) return { name: 'read_file', inner: readToolCall };
  const writeToolCall = asRecord(toolCall['writeToolCall']);
  if (writeToolCall) return { name: 'write_file', inner: writeToolCall };
  const fn = asRecord(toolCall['function']);
  if (fn && typeof fn['name'] === 'string' && fn['name']) return { name: fn['name'], inner: fn };
  const firstKey = Object.keys(toolCall)[0];
  return { name: firstKey ?? 'unknown_tool', inner: firstKey ? asRecord(toolCall[firstKey]) : null };
}

/**
 * Process one JSONL line from `cursor-agent --output-format stream-json`
 * stdout. Event types observed (per Cursor CLI docs): `system` (subtype
 * `init`, ignored), `user` (echo of the prompt, ignored), `assistant`
 * (complete message segments), `tool_call` (subtype `started`/`completed`),
 * `result` (terminal — no documented token/cost field, so `assistant.usage`
 * is never emitted here).
 */
function processCursorLine(
  line: string,
  state: CursorRunState,
  onAssistantText: (text: string) => void,
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

  if (type === 'assistant') {
    const message = asRecord(event['message']);
    const content = Array.isArray(message?.['content']) ? message['content'] : [];
    const text = content
      .map((part) => (asRecord(part) && typeof asRecord(part)?.['text'] === 'string' ? (asRecord(part)!['text'] as string) : ''))
      .join('');
    if (text) {
      onAssistantText(text);
      emitEvent('assistant.message', { content: text.slice(0, 3000) });
    }
    return;
  }

  if (type === 'tool_call') {
    const subtype = typeof event['subtype'] === 'string' ? event['subtype'] : '';
    const toolCall = asRecord(event['tool_call']);
    const { name: toolName, inner } = resolveTool(toolCall);

    if (subtype === 'started') {
      state.toolCallCount++;
      state.toolsByKind[toolName] = (state.toolsByKind[toolName] ?? 0) + 1;
      emitEvent('tool.execution_start', { name: toolName, callNumber: state.toolCallCount });
      return;
    }

    if (subtype === 'completed') {
      const result = inner ? asRecord(inner['result']) : null;
      const success = result ? Object.prototype.hasOwnProperty.call(result, 'success') : true;
      state.toolCalls.push({ name: toolName, input: {}, success });
      emitEvent('tool.execution_complete', { name: toolName, success });
    }
    return;
  }
  // 'system' and 'user' carry no actionable data for VE; 'result' is handled
  // by the exit-code/stderr path since it has no usage/cost fields to parse.
}

function buildExitError(code: number | null, stderrAccum: string): string {
  const tail = stderrAccum.trim().split('\n').slice(-20).join('\n');
  return `Cursor CLI exited with code ${code ?? 'null'}${tail ? `: ${tail}` : ''}`;
}

/** Run a Cursor CLI session and return the assistant's final text + tool stats. */
export async function runCursorAgent(
  prompt: string,
  options: AgentRunOptions,
): Promise<AgentRun> {
  const { model, agentInstructions, cwd, timeoutMs, mode, reviewOutputSchema } = options;
  const modelLabel = model || 'cli-default';

  emitEvent('session.start', { model: modelLabel, mode, workingDirectory: cwd });
  process.stderr.write(`starting Cursor CLI (mode=${mode}, model=${modelLabel})\n`);

  const submissionSchema = mode === 'review' ? reviewOutputSchema : CHANGE_SUBMISSION_JSON_SCHEMA;
  if (submissionSchema === undefined) {
    throw new Error(
      mode === 'review'
        ? 'REVIEW_OUTPUT_SCHEMA is required for Cursor MCP review submissions'
        : 'Change submission schema is required for Cursor MCP codegen submissions',
    );
  }
  const submission = buildSubmissionMcpConfig(mode, submissionSchema);
  const fullAgentInstructions = appendSubmissionInstruction(agentInstructions, submission.toolName);

  const env = buildCursorEnv();
  const home = resolveCursorHome();
  try {
    assertNoProjectSubmissionMcpCollision(cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitEvent('session.error', { message });
    throw error;
  }
  const configPath = writeCursorMcpConfig(submission.server, home);
  const binary = resolveCursorBinary();

  try {
    await enableCursorSubmissionMcp(binary, cwd, env);
  } catch (error) {
    rmSync(configPath, { force: true });
    const message = error instanceof Error ? error.message : String(error);
    emitEvent('session.error', { message });
    throw error;
  }

  const fullPrompt = `${prompt}\n\n${fullAgentInstructions}`;
  const args = buildCursorArgs(fullPrompt, options);

  const state: CursorRunState = { toolCallCount: 0, toolsByKind: {}, toolCalls: [] };
  let assistantText = '';
  let stderrAccum = '';

  const child = spawn(binary, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const cleanup = (): Promise<void> => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    try {
      rmSync(configPath, { force: true });
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
    processCursorLine(line.trimEnd(), state, (chunk) => { assistantText += chunk; });
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Cursor session timed out after ${timeoutMs}ms`));
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
        for (const line of lines) process.stderr.write(`[cursor] ${line}\n`);
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
          reject(new Error(`Cursor terminated by signal ${signal}`));
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

export const CURSOR_PROVIDER: AgentProviderDefinition = {
  id: 'cursor',
  adapterLabel: 'cursor-cli',
  resolveModel: () => process.env['CURSOR_MODEL'] ?? '',
  defaultModelLabel: 'cli-default',
  submissionTransport: 'mcp',
  runner: runCursorAgent,
};
