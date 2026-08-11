/**
 * Virtual Engineer — Gemini CLI session runner (agent worker).
 *
 * Runs INSIDE the sandbox for the `gemini` provider. Gemini CLI
 * (https://github.com/google-gemini/gemini-cli) is a standalone Node CLI —
 * like Codex/Goose there is no embeddable SDK this worker can drive in-
 * process, so this runner spawns `gemini` as a subprocess against the
 * pre-cloned repository working directory, pipes the full prompt over stdin
 * (non-TTY stdio triggers Gemini's headless mode even without `-p`), and maps
 * its streamed `--output-format stream-json` JSONL output onto the shared
 * `__ve_event` stderr protocol used by every provider, exactly like the Codex
 * runner (`./codex.ts`).
 *
 * NOTE: piping the full prompt via stdin without `-p` (rather than passing it
 * as a `-p`/positional argv value) is inferred from Gemini CLI's documented
 * headless-mode trigger ("non-TTY environment ... or providing a query with
 * -p") — this has not been verified against a live CLI run and should be
 * re-checked before relying on it in production (see
 * .github/copilot-instructions.md "Further Considerations").
 *
 * Like Codex/Goose, Gemini uses **MCP submission transport**: the runner
 * writes a Gemini `settings.json` (user scope, `$HOME/.gemini/settings.json`)
 * that registers the VE MCP submission server
 * (`/app/agent-worker/dist/mcpSubmissionServer.js`) as a trusted stdio MCP
 * server, so Gemini calls `ve_submit_changes` / `ve_submit_review` to deliver
 * the structured result. The worker then reads the submission file and
 * asserts exactly one accepted tool call, exactly like Copilot/Claude/Goose/
 * Codex.
 *
 * Trust: headless environments cannot show Gemini's interactive folder-trust
 * dialog, so `--skip-trust` grants session-only trust for the (fresh,
 * ephemeral) sandbox working directory — otherwise MCP servers would refuse
 * to connect at all and repository config (GEMINI.md, skills) would be
 * ignored.
 *
 * Authentication: the host adapter injects exactly one of `GEMINI_API_KEY`
 * (Gemini Developer API) or `GOOGLE_API_KEY` + `GOOGLE_GENAI_USE_VERTEXAI`
 * (Vertex AI Express Mode) — both are read directly by the CLI, no bootstrap
 * needed.
 */
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
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

/** Resolve the gemini binary path. Falls back to `gemini` on PATH. */
function resolveGeminiBinary(): string {
  // The Dockerfile installs the Gemini CLI via `npm install -g @google/gemini-cli`.
  return process.env['GEMINI_BIN'] ?? 'gemini';
}

/** Resolve the sandbox HOME, where `.gemini/settings.json` lives (user scope). */
function resolveGeminiHome(): string {
  return process.env['HOME'] ?? '/sandbox';
}

/**
 * Environment Variable Allowlist (Security): the subprocess receives only
 * whitelisted env vars to prevent secrets leakage.
 */
function buildGeminiEnv(): Record<string, string> {
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
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
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
 * Write `$HOME/.gemini/settings.json` registering the VE MCP submission
 * server as a trusted stdio MCP server. `trust: true` bypasses Gemini's tool
 * confirmation for this server regardless of `--approval-mode`. Written
 * outside the repository working directory (HOME, not cwd) so it never
 * pollutes the agent's git status.
 */
function writeGeminiSettings(
  submissionServer: { command: string; args: string[]; env: Record<string, string> },
  home: string,
): string {
  const geminiDir = join(home, '.gemini');
  mkdirSync(geminiDir, { recursive: true });
  const settingsPath = join(geminiDir, 'settings.json');
  const settings = {
    mcpServers: {
      've-submission': {
        command: submissionServer.command,
        args: submissionServer.args,
        env: submissionServer.env,
        trust: true,
      },
    },
  };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  process.stderr.write(`gemini settings written to ${settingsPath}\n`);
  return settingsPath;
}

/**
 * Approval mode: `yolo` auto-approves all tool calls (codegen — OpenShell is
 * the real isolation boundary, not Gemini's own confirmation prompts); `plan`
 * is an analysis-oriented mode used for review to avoid destructive edits.
 * The `plan` choice for review is inferred from CLI docs and not yet verified
 * against a live run to fully block writes while still allowing the trusted
 * `ve-submission` MCP tool call — see
 * .github/copilot-instructions.md "Further Considerations".
 */
function resolveApprovalMode(mode: 'codegen' | 'review'): 'yolo' | 'plan' {
  return mode === 'review' ? 'plan' : 'yolo';
}

/** Build the gemini argv. Prompt is always piped via stdin (no `-p`/positional query). */
function buildGeminiArgs(options: AgentRunOptions): string[] {
  const approvalMode = resolveApprovalMode(options.mode);
  return [
    '--output-format', 'stream-json',
    '--approval-mode', approvalMode,
    // Gemini's interactive folder-trust dialog can't run headless; this
    // grants session-only trust so MCP servers and repo config still load.
    '--skip-trust',
    ...(options.model ? ['--model', options.model] : []),
  ];
}

interface GeminiRunState {
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
 * Process one JSONL line from `gemini --output-format stream-json` stdout.
 * Event types observed (per Gemini CLI docs): `init`, `message`, `tool_use`,
 * `tool_result`, `error`, `result`. Unlike Codex, stream `error` events are
 * documented as "non-fatal warnings and system errors" — they are logged, not
 * thrown; the process exit code is the authoritative success/failure signal.
 * The exact `tool_use`/`tool_result`/`result` field shapes are not fully
 * documented upstream — this parser is defensive and needs live-CLI
 * verification.
 */
function processGeminiLine(
  line: string,
  state: GeminiRunState,
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

  if (type === 'error') {
    const message = typeof event['message'] === 'string' ? event['message'] : JSON.stringify(event);
    emitEvent('session.warning', { message });
    return;
  }

  if (type === 'message') {
    const role = typeof event['role'] === 'string' ? event['role'] : '';
    const content = typeof event['content'] === 'string' ? event['content'] : '';
    if (role !== 'user' && content) {
      onAssistantText(content);
      emitEvent('assistant.message', { content: content.slice(0, 3000) });
    }
    return;
  }

  if (type === 'tool_use') {
    const toolName = typeof event['name'] === 'string' ? event['name'] : 'unknown_tool';
    state.toolCallCount++;
    state.toolsByKind[toolName] = (state.toolsByKind[toolName] ?? 0) + 1;
    emitEvent('tool.execution_start', { name: toolName, callNumber: state.toolCallCount });
    return;
  }

  if (type === 'tool_result') {
    const toolName = typeof event['name'] === 'string' ? event['name'] : 'unknown_tool';
    const errorMessage = typeof event['error'] === 'string' ? event['error'] : undefined;
    const success = errorMessage === undefined && event['success'] !== false;
    state.toolCalls.push({
      name: toolName,
      input: {},
      success,
      ...(errorMessage !== undefined ? { error: errorMessage } : {}),
    });
    emitEvent('tool.execution_complete', { name: toolName, success });
    return;
  }

  if (type === 'result') {
    const stats = asRecord(event['stats']);
    if (stats) {
      const usage = asRecord(stats['usage']) ?? stats;
      emitEvent('assistant.usage', {
        inputTokens: numberOrNull(usage['inputTokens'] ?? usage['input_tokens']),
        outputTokens: numberOrNull(usage['outputTokens'] ?? usage['output_tokens']),
        cacheReadTokens: numberOrNull(usage['cachedTokens'] ?? usage['cached_tokens']),
        cacheWriteTokens: null,
        model: modelLabel,
      });
    }
    return;
  }
  // 'init' and any unrecognized types carry no actionable data.
}

function buildExitError(code: number | null, stderrAccum: string): string {
  const tail = stderrAccum.trim().split('\n').slice(-20).join('\n');
  const reason = code === 42
    ? 'invalid prompt or arguments'
    : code === 53
      ? 'turn limit exceeded'
      : code === 1
        ? 'general error'
        : `unrecognized exit code ${code ?? 'null'}`;
  return `Gemini CLI exited with code ${code ?? 'null'} (${reason})${tail ? `: ${tail}` : ''}`;
}

/** Run a Gemini CLI session and return the assistant's final text + tool stats. */
export async function runGeminiAgent(
  prompt: string,
  options: AgentRunOptions,
): Promise<AgentRun> {
  const { model, agentInstructions, cwd, timeoutMs, mode, reviewOutputSchema } = options;
  const modelLabel = model || 'cli-default';

  emitEvent('session.start', { model: modelLabel, mode, workingDirectory: cwd });
  process.stderr.write(`starting Gemini CLI (mode=${mode}, model=${modelLabel})\n`);

  const submissionSchema = mode === 'review' ? reviewOutputSchema : CHANGE_SUBMISSION_JSON_SCHEMA;
  if (submissionSchema === undefined) {
    throw new Error(
      mode === 'review'
        ? 'REVIEW_OUTPUT_SCHEMA is required for Gemini MCP review submissions'
        : 'Change submission schema is required for Gemini MCP codegen submissions',
    );
  }
  const submission = buildSubmissionMcpConfig(mode, submissionSchema);
  const fullAgentInstructions = appendSubmissionInstruction(agentInstructions, submission.toolName);

  const env = buildGeminiEnv();
  const home = resolveGeminiHome();
  const settingsPath = writeGeminiSettings(submission.server, home);

  const args = buildGeminiArgs(options);
  const fullPrompt = `${prompt}\n\n${fullAgentInstructions}`;

  const state: GeminiRunState = { toolCallCount: 0, toolsByKind: {}, toolCalls: [] };
  let assistantText = '';
  let stderrAccum = '';

  const child = spawn(resolveGeminiBinary(), args, {
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
      rmSync(settingsPath, { force: true });
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
    processGeminiLine(line.trimEnd(), state, (chunk) => { assistantText += chunk; }, modelLabel);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Gemini session timed out after ${timeoutMs}ms`));
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
        for (const line of lines) process.stderr.write(`[gemini] ${line}\n`);
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
          reject(new Error(`Gemini terminated by signal ${signal}`));
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

export const GEMINI_PROVIDER: AgentProviderDefinition = {
  id: 'gemini',
  adapterLabel: 'gemini-cli',
  resolveModel: () => process.env['GEMINI_MODEL'] ?? '',
  defaultModelLabel: 'cli-default',
  submissionTransport: 'mcp',
  runner: runGeminiAgent,
};
