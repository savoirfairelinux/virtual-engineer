/**
 * Virtual Engineer — OpenCode session runner (agent worker).
 *
 * Runs INSIDE the OpenShell sandbox for the `opencode` provider. OpenCode CLI
 * (https://opencode.ai) is a standalone terminal agent — like Codex, there is
 * no embeddable Node SDK, so this runner spawns `opencode run --format json`
 * as a subprocess against the pre-cloned repository working directory and
 * maps its streamed JSONL output onto the shared `__ve_event` stderr protocol
 * used by every provider, exactly like the Codex runner (`./codex.ts`).
 *
 * Unlike Aider (text transport), OpenCode uses **MCP submission transport**:
 * the runner writes a per-run `opencode.json` config (via `OPENCODE_CONFIG`)
 * that registers the VE MCP submission server
 * (`/app/agent-worker/dist/mcpSubmissionServer.js`) as a local stdio MCP
 * server, so OpenCode calls `ve_submit_changes` / `ve_submit_review` to
 * deliver the structured result. The worker then reads the submission file
 * and asserts exactly one accepted tool call, exactly like Copilot/Claude/
 * Goose/Codex.
 *
 * Authentication is via the process environment: the host adapter injects the
 * selected LLM provider's auth env var(s) (e.g. `ANTHROPIC_API_KEY`,
 * `OPENAI_API_KEY`, `OLLAMA_API_BASE`, `OPENROUTER_API_KEY`,
 * `GOOGLE_GENERATIVE_AI_API_KEY`). This runner never clones and never pushes.
 *
 * NOTE: OpenCode's `run` command has no documented `--message-file` flag (only
 * `-f/--file` for attachments). The full VE prompt is passed as a single argv
 * element instead — Linux ARG_MAX is normally large enough (~2MB) for VE
 * prompts, but this should be re-verified against a live OpenCode run; switch
 * to stdin piping or a `--file` attachment if argv proves unreliable.
 */
import { spawn } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
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

const DEFAULT_OLLAMA_BASE = 'http://127.0.0.1:11434/v1';

/** Resolve the opencode binary path. Falls back to `opencode` on PATH. */
function resolveOpenCodeBinary(): string {
  // The Dockerfile installs the OpenCode CLI via `npm install -g opencode-ai`.
  return process.env['OPENCODE_BIN'] ?? 'opencode';
}

/**
 * Environment Variable Allowlist (Security): the subprocess receives only
 * whitelisted env vars to prevent secrets leakage. The allowlist covers all
 * supported OpenCode providers (same set as Goose).
 */
function buildOpenCodeEnv(configPath: string): Record<string, string> {
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
    // Provider auth env vars — supported OpenCode providers.
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'OPENAI_API_BASE',
    'OPENROUTER_API_KEY',
    'OLLAMA_API_BASE',
    'DEEPSEEK_API_KEY',
    'GROQ_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'AZURE_RESOURCE_NAME',
    'PERPLEXITY_API_KEY',
    'MISTRAL_API_KEY',
    'XAI_API_KEY',
    'CEREBRAS_API_KEY',
    // Bedrock uses AWS credential chains.
    'AWS_PROFILE',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_BEARER_TOKEN_BEDROCK',
  ];
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  env['GIT_AUTHOR_NAME'] = GIT_AUTHOR_NAME;
  env['GIT_AUTHOR_EMAIL'] = GIT_AUTHOR_EMAIL;
  env['GIT_COMMITTER_NAME'] = GIT_COMMITTER_NAME;
  env['GIT_COMMITTER_EMAIL'] = GIT_COMMITTER_EMAIL;
  // Scope config/credentials to an isolated per-run directory so concurrent/
  // successive runs never see each other's MCP registration or auth state.
  env['OPENCODE_CONFIG'] = configPath;
  env['OPENCODE_DISABLE_AUTOUPDATE'] = 'true';
  return env;
}

/**
 * Map VE's `openCodeProvider` selector onto the AI-SDK provider id OpenCode's
 * `--model <providerId>/<model>` flag expects. Providers needing a custom base
 * URL (ollama, openai_compat) or a non-default endpoint (azure_openai) get a
 * matching `provider.<id>` entry registered in the generated config.
 *
 * The exact built-in provider ids (especially `google` for Gemini, `azure` for
 * Azure OpenAI, `amazon-bedrock` for Bedrock) are a best-effort mapping from
 * OpenCode's public provider directory — verify against a live
 * `opencode models` run before relying on this in production.
 */
function resolveOpenCodeProviderId(selector: string | undefined): string {
  switch (selector) {
    case 'gemini':
      return 'google';
    case 'azure_openai':
      return 'azure';
    case 'bedrock':
      return 'amazon-bedrock';
    case 'openai_compat':
      return 'opencode-custom';
    default:
      return selector ?? 'anthropic';
  }
}

/** Build an optional `provider.<id>` config entry for providers needing a custom base URL. */
function buildProviderConfigEntry(
  providerId: string,
  selector: string | undefined,
): Record<string, unknown> | undefined {
  if (selector === 'ollama') {
    return {
      [providerId]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Ollama (local)',
        options: { baseURL: process.env['OLLAMA_API_BASE'] ?? DEFAULT_OLLAMA_BASE },
      },
    };
  }
  if (selector === 'openai_compat') {
    return {
      [providerId]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'OpenAI-compatible',
        options: {
          baseURL: process.env['OPENAI_API_BASE'] ?? '',
          apiKey: process.env['OPENAI_API_KEY'] ?? '',
        },
      },
    };
  }
  if (selector === 'azure_openai') {
    return {
      [providerId]: {
        options: {
          baseURL: process.env['AZURE_RESOURCE_NAME'] ?? '',
          apiKey: process.env['AZURE_OPENAI_API_KEY'] ?? '',
        },
      },
    };
  }
  return undefined;
}

/**
 * Write a per-run `opencode.json` config registering the VE MCP submission
 * server as a local stdio MCP server (`required` submission tool), any custom
 * provider entry the selected backend needs, and a blocklist-style permission
 * posture (VE's tool-authorization philosophy: everything allowed by default,
 * only review mode denies file edits / shell so analysis stays read-only —
 * the OpenShell sandbox is the real isolation boundary, not this permission
 * config).
 */
function writeOpenCodeConfig(
  configDir: string,
  submissionServer: { command: string; args: string[]; env: Record<string, string> },
  providerId: string,
  providerConfigEntry: Record<string, unknown> | undefined,
  mode: 'codegen' | 'review',
): string {
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, 'opencode.json');

  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      've-submission': {
        type: 'local',
        command: [submissionServer.command, ...submissionServer.args],
        environment: submissionServer.env,
        enabled: true,
      },
    },
    permission: mode === 'review' ? { '*': 'allow', edit: 'deny', bash: 'deny' } : 'allow',
    ...(providerConfigEntry !== undefined ? { provider: providerConfigEntry } : {}),
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  process.stderr.write(`opencode config written to ${configPath} (provider=${providerId}, mode=${mode})\n`);
  return configPath;
}

/** Build the opencode `run` argv for a non-interactive single-instruction session. */
function buildOpenCodeArgs(
  prompt: string,
  model: string | undefined,
  providerId: string,
  variant: string | undefined,
): string[] {
  const modelArg = model ? `${providerId}/${model}` : undefined;
  return [
    'run',
    '--format', 'json',
    '--auto',
    ...(modelArg ? ['--model', modelArg] : []),
    ...(variant ? ['--variant', variant] : []),
    prompt,
  ];
}

interface OpenCodeRunState {
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
 * Process one JSONL line from `opencode run --format json` stdout. The exact
 * event shape is not fully documented upstream — this parser is defensive and
 * needs live-CLI verification (same caveat as the Codex JSONL parser).
 */
function processOpenCodeLine(
  line: string,
  state: OpenCodeRunState,
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

  if (type === 'error' || type === 'session.error') {
    const message = typeof event['message'] === 'string' ? event['message'] : JSON.stringify(event);
    throw new Error(`OpenCode ${type}: ${message}`);
  }

  if (type === 'usage' || type === 'session.idle') {
    const usage = asRecord(event['usage']) ?? asRecord(event['tokens']);
    if (usage) {
      emitEvent('assistant.usage', {
        inputTokens: numberOrNull(usage['input'] ?? usage['input_tokens']),
        outputTokens: numberOrNull(usage['output'] ?? usage['output_tokens']),
        cacheReadTokens: numberOrNull(usage['cache_read'] ?? usage['cached_tokens']),
        cacheWriteTokens: numberOrNull(usage['cache_write']),
        model: modelLabel,
      });
    }
    return;
  }

  if (type === 'message' || type === 'assistant_message' || type === 'text') {
    const text = typeof event['text'] === 'string' ? event['text'] : typeof event['content'] === 'string' ? event['content'] : '';
    if (text) {
      onAssistantText(text);
      emitEvent('assistant.message', { content: text.slice(0, 3000) });
    }
    return;
  }

  if (type === 'tool_call' || type === 'tool.start' || type === 'tool_use') {
    const toolName = typeof event['tool'] === 'string' ? event['tool'] : typeof event['name'] === 'string' ? event['name'] : 'unknown';
    state.toolCallCount++;
    state.toolsByKind[toolName] = (state.toolsByKind[toolName] ?? 0) + 1;
    emitEvent('tool.execution_start', { name: toolName, callNumber: state.toolCallCount });
    return;
  }

  if (type === 'tool_result' || type === 'tool.end' || type === 'tool_result_end') {
    const toolName = typeof event['tool'] === 'string' ? event['tool'] : typeof event['name'] === 'string' ? event['name'] : 'unknown';
    const status = typeof event['status'] === 'string' ? event['status'] : '';
    const success = status === 'completed' || status === 'success' || event['success'] === true;
    const errorMessage = typeof event['error'] === 'string' ? event['error'] : undefined;
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
  return `OpenCode CLI exited with code ${code ?? 'null'}${tail ? `: ${tail}` : ''}`;
}

/** Run an OpenCode CLI session and return the assistant's final text + tool stats. */
export async function runOpenCodeAgent(
  prompt: string,
  options: AgentRunOptions,
): Promise<AgentRun> {
  const { model, agentInstructions, cwd, timeoutMs, mode, reviewOutputSchema, reviewStrategy } = options;
  const openCodeProviderSelector = process.env['OPENCODE_PROVIDER'];
  const providerId = resolveOpenCodeProviderId(openCodeProviderSelector);
  const nativeReview = mode === 'review' && reviewStrategy === 'opencode_native';
  const modelLabel = nativeReview ? 'CLI-managed' : (model ? `${providerId}/${model}` : 'cli-default');

  emitEvent('session.start', { model: modelLabel, mode, workingDirectory: cwd });
  process.stderr.write(`starting OpenCode CLI (mode=${mode}, model=${modelLabel})\n`);

  const submissionSchema = mode === 'review' ? reviewOutputSchema : CHANGE_SUBMISSION_JSON_SCHEMA;
  if (submissionSchema === undefined) {
    throw new Error(
      mode === 'review'
        ? 'REVIEW_OUTPUT_SCHEMA is required for OpenCode MCP review submissions'
        : 'Change submission schema is required for OpenCode MCP codegen submissions',
    );
  }
  const submission = buildSubmissionMcpConfig(mode, submissionSchema);
  const baseInstructions = nativeReview
    ? `${agentInstructions.trim()}\n\nDelegate the code analysis to a spawned subagent/task, then submit the findings yourself.`
    : agentInstructions;
  const fullAgentInstructions = appendSubmissionInstruction(baseInstructions, submission.toolName);

  // Isolate config + MCP registration in a per-run temp directory rather than
  // the shared default `~/.config/opencode`, so concurrent/successive runs
  // never see each other's registration.
  const tmpDir = mkdtempSync(join('/tmp', 've-opencode-'));
  const providerConfigEntry = buildProviderConfigEntry(providerId, openCodeProviderSelector);
  const configPath = writeOpenCodeConfig(tmpDir, submission.server, providerId, providerConfigEntry, mode);
  const env = buildOpenCodeEnv(configPath);

  const args = buildOpenCodeArgs(
    `${prompt}\n\n${fullAgentInstructions}`,
    nativeReview ? undefined : model,
    providerId,
    nativeReview ? undefined : process.env['OPENCODE_VARIANT'],
  );

  const state: OpenCodeRunState = { toolCallCount: 0, toolsByKind: {}, toolCalls: [] };
  let assistantText = '';
  let stderrAccum = '';

  const child = spawn(resolveOpenCodeBinary(), args, {
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
    processOpenCodeLine(line.trimEnd(), state, (chunk) => { assistantText += chunk; }, modelLabel);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`OpenCode session timed out after ${timeoutMs}ms`));
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
        for (const line of lines) process.stderr.write(`[opencode] ${line}\n`);
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
          reject(new Error(`OpenCode terminated by signal ${signal}`));
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

export const OPENCODE_PROVIDER: AgentProviderDefinition = {
  id: 'opencode',
  adapterLabel: 'opencode-cli',
  resolveModel: () => process.env['OPENCODE_MODEL'] ?? '',
  defaultModelLabel: 'cli-default',
  submissionTransport: 'mcp',
  runner: runOpenCodeAgent,
};
