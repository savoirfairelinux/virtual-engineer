/**
 * Virtual Engineer — Copilot session runner (agent worker).
 *
 * Runs INSIDE the Docker container for the default `copilot` provider. Spawns a
 * local headless Copilot CLI server, drives the GitHub Copilot SDK against the
 * pre-cloned `/workspace` repository, and maps the SDK's session events onto the
 * shared `__ve_event` stderr protocol so the host adapter's event / commit /
 * result pipeline stays provider-agnostic.
 *
 * The agent edits files and creates git commits via the SDK's built-in tools;
 * commit collection is handled by the caller after this runner returns the
 * assistant's final text.
 *
 * Authentication is via the process environment: `GITHUB_TOKEN` (Copilot LLM
 * calls only). This runner never clones and never pushes.
 */
import { CopilotClient } from '@github/copilot-sdk';
import type { CopilotSession, AssistantMessageEvent, SessionConfig } from '@github/copilot-sdk';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { statSync } from 'fs';
import { createConnection } from 'net';
import { restrictNetworkPermissionHandler } from '../networkGuard.js';
import { emitEvent } from './events.js';
import type { AgentProviderDefinition, AgentRun, AgentRunOptions } from './types.js';
import { copilotGlobalSkillsDir, emitLocalSkillsLoaded, localSkillsDir } from '../skills.js';
import {
  CHANGE_SUBMISSION_JSON_SCHEMA,
  appendSubmissionInstruction,
  buildSubmissionMcpConfig,
} from '../mcpSubmission.js';

type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export function buildCopilotSystemMessage(agentInstructions: string): {
  mode: 'append';
  content: string;
} {
  return { mode: 'append', content: agentInstructions };
}

// Git identity forwarded into the headless CLI subprocess environment.
const GIT_AUTHOR_NAME = process.env['GIT_AUTHOR_NAME'] ?? 'Virtual Engineer';
const GIT_AUTHOR_EMAIL = process.env['GIT_AUTHOR_EMAIL'] ?? 've@virtual-engineer.local';
const GIT_COMMITTER_NAME = process.env['GIT_COMMITTER_NAME'] ?? GIT_AUTHOR_NAME;
const GIT_COMMITTER_EMAIL = process.env['GIT_COMMITTER_EMAIL'] ?? GIT_AUTHOR_EMAIL;

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

async function startLocalCliServer(cwd: string): Promise<LocalCliServer> {
  const cliPath = '/agent-worker/node_modules/.bin/copilot';
  const port = 3000;
  // These buffers only feed the startup-failure error detail, but the stream
  // handlers stay attached for the whole session. Cap them to the most recent
  // chunks so a chatty CLI can't grow memory unbounded over a long cycle.
  const MAX_STARTUP_LOG_CHUNKS = 100;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const pushCapped = (buf: string[], chunk: string): void => {
    buf.push(chunk);
    if (buf.length > MAX_STARTUP_LOG_CHUNKS) buf.shift();
  };

  // Environment Variable Allowlist (Security):
  // Subprocess has only whitelisted env vars to prevent secrets leakage.
  const child = spawn(cliPath, ['--headless', '--port', String(port)], {
    cwd,
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

  child.stdout?.on('data', (chunk: unknown) => pushCapped(stdoutChunks, String(chunk)));
  child.stderr?.on('data', (chunk: unknown) => pushCapped(stderrChunks, String(chunk)));

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
export function copilotSkillDirectories(cwd: string, skillDiscovery: boolean): string[] {
  const skillDirectories: string[] = [];
  if (skillDiscovery) {
    emitLocalSkillsLoaded(cwd);
    skillDirectories.push(localSkillsDir(cwd));
  }
  skillDirectories.push(copilotGlobalSkillsDir());

  return skillDirectories.filter((dir) => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

export function buildCopilotSessionConfig(
  options: AgentRunOptions,
  skillDirectories: string[],
): SessionConfig {
  const { model, agentInstructions, cwd, mode, reviewOutputSchema } = options;
  const reasoningEffort = process.env['COPILOT_REASONING_EFFORT'];
  const submissionSchema = mode === 'review'
    ? reviewOutputSchema
    : CHANGE_SUBMISSION_JSON_SCHEMA;
  const submission = submissionSchema !== undefined
    ? buildSubmissionMcpConfig(mode, submissionSchema)
    : null;

  return {
    model,
    ...(reasoningEffort && reasoningEffort !== 'none'
      ? { reasoningEffort: reasoningEffort as ReasoningEffort }
      : {}),
    ...(skillDirectories.length > 0 ? { skillDirectories } : {}),
    systemMessage: buildCopilotSystemMessage(
      submission !== null
        ? appendSubmissionInstruction(agentInstructions, submission.toolName)
        : agentInstructions,
    ),
    onPermissionRequest: restrictNetworkPermissionHandler,
    workingDirectory: cwd,
    enableConfigDiscovery: false,
    ...(submission !== null
      ? {
          mcpServers: {
            've-submission': {
              ...submission.server,
              tools: [submission.toolName],
            },
          },
        }
      : {}),
    infiniteSessions: { enabled: false },
  };
}

async function runSession(
  options: AgentRunOptions,
): Promise<{ session: CopilotSession; client: CopilotClient; localCliServer: LocalCliServer }> {
  const { cwd, skillDiscovery } = options;
  const localCliServer = await startLocalCliServer(cwd);
  const client = new CopilotClient({ cliUrl: localCliServer.cliUrl });

  // Local repo skills remain opt-in; fetched remote skills are already project-approved.
  const skillDirectories = copilotSkillDirectories(cwd, skillDiscovery === true);

  try {
    const session = await client.createSession(buildCopilotSessionConfig(options, skillDirectories));
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
  model: string,
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
    const apiCallId = deepFindStr(event, ['apiCallId', 'api_call_id']);
    const providerCallId = deepFindStr(event, ['providerCallId', 'provider_call_id']);
    const totalNanoAiu = deepFindNum(event, ['totalNanoAiu', 'total_nano_aiu']);
    const cost = deepFindNum(event, ['cost']);
    emitEvent('assistant.usage', {
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      model: deepFindStr(event, ['model']) ?? model,
      ...(apiCallId !== null ? { apiCallId } : {}),
      ...(providerCallId !== null ? { providerCallId } : {}),
      ...(totalNanoAiu !== null ? { totalNanoAiu } : {}),
      ...(cost !== null ? { cost } : {}),
    });
  });

  session.on('session.usage_info', (e) => {
    const event = e as unknown;
    const tokenLimit = deepFindNum(event, ['tokenLimit']);
    const currentTokens = deepFindNum(event, ['currentTokens']);
    emitEvent('session.usage_info', {
      tokenLimit,
      currentTokens,
      model: deepFindStr(event, ['model']) ?? model,
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

/** Run a Copilot SDK session (local headless CLI) and return the assistant text + tool stats. */
export async function runCopilotAgent(
  prompt: string,
  options: AgentRunOptions,
): Promise<AgentRun> {
  const { model, cwd, timeoutMs, mode } = options;
  const { session, client, localCliServer } = await runSession(options);
  emitEvent('session.start', { model, mode, workingDirectory: cwd });
  const handlerState = registerSessionEventHandlers(session, model);
  process.stderr.write(`sending ${mode} prompt\n`);

  const heartbeat = setInterval(() => {
    process.stderr.write(`agent working… (${handlerState.toolCallCount} tool call(s) so far)\n`);
  }, 30_000);

  let response: AssistantMessageEvent | undefined;
  try {
    response = await session.sendAndWait({ prompt }, timeoutMs);
  } catch (err) {
    // Tear down the session, client and local CLI on the error path — the
    // returned `cleanup` closure only runs on success, so without this a failed
    // cycle would leak the headless CLI process and its socket connection.
    await session.disconnect().catch(() => { /* ignore */ });
    await client.stop().catch(() => { /* ignore */ });
    localCliServer.child.kill('SIGTERM');
    throw err;
  } finally {
    clearInterval(heartbeat);
  }

  const content = response?.data.content ?? 'Task completed';
  await session.disconnect().catch(() => { /* ignore */ });

  emitEvent('session.end', {
    mode,
    toolCallCount: handlerState.toolCallCount,
    toolsByKind: handlerState.toolsByKind,
    model,
    outputLength: content.length,
  });

  return {
    content,
    toolCallCount: handlerState.toolCallCount,
    toolsByKind: handlerState.toolsByKind,
    cleanup: async (): Promise<void> => {
      await client.stop().catch(() => { /* ignore */ });
      localCliServer.child.kill('SIGTERM');
    },
  };
}

export const COPILOT_PROVIDER: AgentProviderDefinition = {
  id: 'copilot',
  adapterLabel: 'copilot-sdk',
  resolveModel: () => process.env['COPILOT_MODEL'] ?? 'auto',
  defaultModelLabel: 'auto',
  submissionTransport: 'mcp',
  validateEnvironment: () => {
    if (!process.env['GITHUB_TOKEN']) throw new Error('GITHUB_TOKEN env var is required');
  },
  runner: runCopilotAgent,
};
