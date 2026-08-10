/**
 * Virtual Engineer — Copilot session runner (agent worker).
 *
 * Runs INSIDE the Docker container for the default `copilot` provider. Spawns a
 * local headless Copilot CLI server, drives the GitHub Copilot SDK against the
 * pre-cloned `/sandbox` repository, and maps the SDK's session events onto the
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
import { createConnection } from 'net';
import { buildCopilotCliArgs, buildCopilotNetworkEnvironment } from '../copilotCliArgs.js';
import {
  createNativeReviewPermissionHandler,
  createReviewPermissionHandler,
  createToolAuthorizingPermissionHandler,
  restrictNetworkPermissionHandler,
} from '../networkGuard.js';
import { emitEvent } from './events.js';
import type { AgentProviderDefinition, AgentRun, AgentRunOptions, ObservedToolCall } from './types.js';
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

export function buildNativeReviewPrompt(vePrompt: string): string {
  const delegatedPrompt = [
    'Review the Virtual Engineer context and supplied diff below as the source of truth.',
    'For extra context, only read files under /workspace; do not execute commands, access the network, or edit files.',
    'Do not recompute the diff or compare branches.',
    'Return findings to the parent; do not call submission tools.',
    '',
    vePrompt,
  ].join('\n');

  const parentPrompt = [
    'Delegate exactly one review with the task tool:',
    '- name: "ve-native-code-review"',
    '- description: "Review the VE-provided patch"',
    '- agent_type: "code-review"',
    '- mode: "sync"',
    '- prompt: the content between VE_DELEGATED_PROMPT_START and VE_DELEGATED_PROMPT_END',
    'Use the delegated findings as the sole review analysis.',
    '',
    'VE_DELEGATED_PROMPT_START',
    delegatedPrompt,
    'VE_DELEGATED_PROMPT_END',
  ].join('\n');

  return appendSubmissionInstruction(parentPrompt, 've_submit_review');
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

export async function initializeCopilotClient(
  client: Pick<CopilotClient, 'start' | 'getAuthStatus'>,
): Promise<void> {
  await client.start();
  const authStatus = await client.getAuthStatus();
  if (!authStatus.isAuthenticated) {
    const detail = authStatus.statusMessage?.trim();
    throw new Error(detail || 'GitHub Copilot authentication is not available.');
  }
}

async function startLocalCliServer(cwd: string): Promise<LocalCliServer> {
  const cliPath = '/app/agent-worker/node_modules/.bin/copilot';
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
  const child = spawn(cliPath, buildCopilotCliArgs(port), {
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
      ...buildCopilotNetworkEnvironment(),
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

export function buildCopilotSessionConfig(
  options: AgentRunOptions,
): SessionConfig {
  const { model, agentInstructions, cwd, mode, reviewOutputSchema } = options;
  const reasoningEffort = process.env['COPILOT_REASONING_EFFORT'];
  const submissionSchema = mode === 'review'
    ? reviewOutputSchema
    : CHANGE_SUBMISSION_JSON_SCHEMA;
  const submission = submissionSchema !== undefined
    ? buildSubmissionMcpConfig(mode, submissionSchema)
    : null;
  const nativeReview = mode === 'review' && options.reviewStrategy === 'copilot_native';

  // Per-agent tool authorization: wrap the selected permission handler with
  // the user blocked-tool list. Everything is allowed by default; the wrapper
  // rejects blocked tools and cannot relax VE's network floor (the inner
  // handler still rejects network tools).
  const baseHandler = mode === 'review'
    ? (nativeReview
      ? createNativeReviewPermissionHandler(cwd)
      : createReviewPermissionHandler(cwd))
    : restrictNetworkPermissionHandler;
  const onPermissionRequest = createToolAuthorizingPermissionHandler(baseHandler, {
    ...(options.blockedTools !== undefined ? { blockedTools: options.blockedTools } : {}),
  });

  return {
    model,
    ...(reasoningEffort && reasoningEffort !== 'none'
      ? { reasoningEffort: reasoningEffort as ReasoningEffort }
      : {}),
    systemMessage: buildCopilotSystemMessage(
      submission !== null && !nativeReview
        ? appendSubmissionInstruction(agentInstructions, submission.toolName)
        : agentInstructions,
    ),
    onPermissionRequest,
    workingDirectory: cwd,
    enableConfigDiscovery: true,
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
  const { cwd } = options;
  const localCliServer = await startLocalCliServer(cwd);
  const client = new CopilotClient({ cliUrl: localCliServer.cliUrl });

  try {
    await initializeCopilotClient(client);
    const session = await client.createSession(buildCopilotSessionConfig(options));
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

export function extractToolName(e: unknown): string | null {
  return deepFindStr(e, ['name', 'toolName', 'tool_name', 'functionName', 'function_name']);
}

function deepFindBool(obj: unknown, keys: string[]): boolean | null {
  const seen = new Set<object>();

  function visit(value: unknown): boolean | null {
    if (value === null || value === undefined || typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);

    const record = value as Record<string, unknown>;
    for (const key of keys) {
      const candidate = record[key];
      if (typeof candidate === 'boolean') return candidate;
    }

    for (const nested of Object.values(record)) {
      const found = visit(nested);
      if (found !== null) return found;
    }

    return null;
  }

  return visit(obj);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null;
}

function permissionRequestEventData(event: unknown): Record<string, unknown> {
  const eventData = asRecord(asRecord(event)?.['data']);
  const request = asRecord(eventData?.['permissionRequest']);
  if (request === null) return { kind: 'unknown' };

  const readString = (key: string): string | undefined => {
    const value = request[key];
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };
  const kind = readString('kind') ?? 'unknown';
  const toolCallId = readString('toolCallId');
  const serverName = readString('serverName');
  const toolName = readString('toolName');
  const path = readString('path');
  return {
    kind,
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    ...(serverName !== undefined ? { serverName } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
    ...(path !== undefined ? { path } : {}),
  };
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
  const data = o['data'];
  const dataArguments = typeof data === 'object' && data !== null
    ? (data as Record<string, unknown>)['arguments']
    : undefined;
  return parseToolInputValue(
    o['input'] ?? toolInput ?? tcInput ?? o['arguments'] ?? tcFnArgs ?? dataArguments ?? {}
  );
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
): { toolCallCount: number; toolsByKind: Record<string, number>; toolCalls: ObservedToolCall[] } {
  const state = {
    toolCallCount: 0,
    toolsByKind: {} as Record<string, number>,
    toolCalls: [] as ObservedToolCall[],
  };
  const toolTimers = new Map<string, number>();
  const toolCallsById = new Map<string, ObservedToolCall>();

  session.on('tool.execution_start', (e) => {
    const event = e as unknown;
    const toolName = extractToolName(event);
    if (toolName === null) return;
    state.toolCallCount++;
    const toolInput = extractToolInput(event);
    const callId = deepFindStr(event, ['toolCallId']) ?? `${toolName}_${state.toolCallCount}`;
    const toolCall: ObservedToolCall = { callId, name: toolName, input: toolInput };
    state.toolCalls.push(toolCall);
    toolCallsById.set(callId, toolCall);
    const label = formatToolLabel(toolName, toolInput);
    toolTimers.set(callId, Date.now());
    const prevCount = state.toolsByKind[toolName] ?? 0;
    state.toolsByKind[toolName] = prevCount + 1;
    process.stderr.write(`[tool] #${state.toolCallCount} ${label}\n`);
    emitEvent('tool.execution_start', { name: toolName, input: toolInput, callId, callNumber: state.toolCallCount });
    if (
      toolName === 'task' &&
      toolInput['agent_type'] === 'code-review' &&
      toolInput['mode'] === 'sync'
    ) {
      emitEvent('review.native_delegation_started', { agentType: 'code-review', mode: 'sync' });
    }
  });

  session.on('tool.execution_complete', (e) => {
    const event = e as unknown;
    const callId = deepFindStr(event, ['toolCallId']);
    const observedCall = callId === null ? undefined : toolCallsById.get(callId);
    const toolName = observedCall?.name ?? extractToolName(event);
    if (toolName === null) return;
    const output = deepFindStr(event, ['content', 'detailedContent', 'output']);
    const success = deepFindBool(event, ['success']);
    const error = deepFindStr(event, ['message']);
    const startTime = callId === null ? undefined : toolTimers.get(callId);
    const durationMs = startTime === undefined ? null : Date.now() - startTime;
    if (callId !== null) {
      toolTimers.delete(callId);
    }
    if (observedCall !== undefined && success !== null) {
      observedCall.success = success;
      if (!success && error !== null) {
        observedCall.error = error;
      }
    }
    emitEvent('tool.execution_complete', {
      name: toolName,
      durationMs,
      output: output ? output.slice(0, 800) : null,
      status: success === true ? 'success' : success === false ? 'failed' : 'unknown',
      ...(error !== null ? { error } : {}),
    });
    if (toolName === 'task' && success === true) {
      emitEvent('review.native_delegation_completed', { agentType: 'code-review', mode: 'sync' });
    } else if (toolName === 'task' && success === false) {
      emitEvent('review.native_delegation_failed', {
        agentType: 'code-review',
        mode: 'sync',
        message: error ?? 'Copilot native review delegation failed',
      });
    }
  });

  session.on('tool.execution_progress', (e) => {
    const event = e as unknown;
    const progressCallId = deepFindStr(event, ['toolCallId']);
    const toolName = (progressCallId === null ? undefined : toolCallsById.get(progressCallId)?.name)
      ?? extractToolName(event);
    if (toolName === null) return;
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
    emitEvent('permission.requested', permissionRequestEventData(e));
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
  emitEvent('session.start', {
    model,
    mode,
    workingDirectory: cwd,
    ...(mode === 'review' ? { reviewStrategy: options.reviewStrategy ?? 've_direct' } : {}),
  });
  const handlerState = registerSessionEventHandlers(session, model);
  process.stderr.write(`sending ${mode} prompt\n`);

  const heartbeat = setInterval(() => {
    process.stderr.write(`agent working… (${handlerState.toolCallCount} tool call(s) so far)\n`);
  }, 30_000);

  let response: AssistantMessageEvent | undefined;
  try {
    const sessionPrompt = mode === 'review' && options.reviewStrategy === 'copilot_native'
      ? buildNativeReviewPrompt(prompt)
      : prompt;
    response = await session.sendAndWait({ prompt: sessionPrompt }, timeoutMs);
  } catch (err) {
    if (mode === 'review' && options.reviewStrategy === 'copilot_native') {
      emitEvent('review.native_delegation_failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
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
    toolCalls: handlerState.toolCalls,
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
