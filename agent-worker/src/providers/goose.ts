/**
 * Virtual Engineer — Goose session runner (agent worker).
 *
 * Runs INSIDE the Docker container for the `goose` provider. Goose is a Rust CLI
 * (https://goose-docs.ai) from the AAIF that wraps any LLM provider. This
 * runner spawns `goose run --instructions <prompt-file>` as a subprocess against
 * the pre-cloned `/workspace` repository and maps its streamed output onto the
 * shared `__ve_event` stderr protocol used by every provider, so the host
 * adapter's event / commit / result pipeline is provider-agnostic.
 *
 * Unlike Aider (text transport), Goose uses **MCP submission transport**: the
 * runner writes a Goose `config.yaml` that registers the VE MCP submission
 * server (`/agent-worker/dist/mcpSubmissionServer.js`) as a Goose stdio
 * extension, so Goose calls `ve_submit_changes` / `ve_submit_review` to deliver
 * the structured result. The worker then reads the submission file and asserts
 * exactly one accepted tool call, exactly like Copilot/Claude.
 *
 * The agent edits files and creates git commits via Goose's built-in Developer
 * extension; commit collection is handled by the caller after this runner
 * returns the assistant's final text.
 *
 * Authentication is via the process environment: the host adapter injects the
 * provider's auth env var(s) (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
 * `OLLAMA_HOST`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `GROQ_API_KEY`,
 * `GOOGLE_API_KEY`, `OPENAI_API_BASE`). This runner never clones and never
 * pushes.
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

// Git identity forwarded into the goose subprocess environment.
const GIT_AUTHOR_NAME = process.env['GIT_AUTHOR_NAME'] ?? 'Virtual Engineer';
const GIT_AUTHOR_EMAIL = process.env['GIT_AUTHOR_EMAIL'] ?? 've@virtual-engineer.local';
const GIT_COMMITTER_NAME = process.env['GIT_COMMITTER_NAME'] ?? GIT_AUTHOR_NAME;
const GIT_COMMITTER_EMAIL = process.env['GIT_COMMITTER_EMAIL'] ?? GIT_AUTHOR_EMAIL;

interface GooseNativeOptions {
  gooseMode?: 'auto' | 'approve' | 'chat' | 'smart_approve';
  gooseMaxTurns?: number;
  gooseMaxTokens?: number;
  gooseTemperature?: number;
  gooseAutoCompactThreshold?: number;
}

function positiveNumberFromEnv(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function finiteNumberFromEnv(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : undefined;
}

function resolveGooseNativeOptions(): GooseNativeOptions {
  const gooseMode = process.env['GOOSE_MODE'];
  const gooseMaxTurns = positiveNumberFromEnv('GOOSE_MAX_TURNS');
  const gooseMaxTokens = positiveNumberFromEnv('GOOSE_MAX_TOKENS');
  const gooseTemperature = finiteNumberFromEnv('GOOSE_TEMPERATURE');
  const gooseAutoCompactThreshold = finiteNumberFromEnv('GOOSE_AUTO_COMPACT_THRESHOLD');
  return {
    ...(gooseMode === 'auto' || gooseMode === 'approve' || gooseMode === 'chat' || gooseMode === 'smart_approve'
      ? { gooseMode }
      : {}),
    ...(gooseMaxTurns !== undefined ? { gooseMaxTurns } : {}),
    ...(gooseMaxTokens !== undefined ? { gooseMaxTokens } : {}),
    ...(gooseTemperature !== undefined ? { gooseTemperature } : {}),
    ...(gooseAutoCompactThreshold !== undefined ? { gooseAutoCompactThreshold } : {}),
  };
}

/**
 * Environment Variable Allowlist (Security):
 * The subprocess receives only whitelisted env vars to prevent secrets leakage.
 * The provider auth vars are forwarded so Goose can reach the upstream LLM.
 *
 * The allowlist covers all supported Goose providers. Unrelated cloud
 * credentials not in the supported set are intentionally excluded to minimise
 * the blast radius if such secrets ever leak into the host env.
 */
function buildGooseEnv(): Record<string, string> {
  const allowlist = [
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'USER',
    'XDG_RUNTIME_DIR',
    'XDG_CONFIG_HOME',
    'LANG',
    'LC_ALL',
    // Git identity (Goose attributes commits via the Developer extension).
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
    // Goose model + global settings.
    'GOOSE_MODEL',
    'GOOSE_MODE',
    'GOOSE_MAX_TURNS',
    'GOOSE_MAX_TOKENS',
    'GOOSE_TEMPERATURE',
    'GOOSE_AUTO_COMPACT_THRESHOLD',
    'GOOSE_DISABLE_KEYRING',
    // Provider auth env vars — supported Goose providers.
    'ANTHROPIC_API_KEY',     // anthropic
    'ANTHROPIC_HOST',        // anthropic (optional override)
    'OPENAI_API_KEY',        // openai, openai_compat
    'OPENAI_API_BASE',       // openai_compat
    'OPENAI_HOST',           // openai (optional override)
    'OPENROUTER_API_KEY',    // openrouter
    'OLLAMA_HOST',           // ollama
    'OLLAMA_API_KEY',        // ollama (optional auth)
    'DEEPSEEK_API_KEY',     // deepseek
    'GROQ_API_KEY',          // groq
    'GOOGLE_API_KEY',        // gemini
    'AZURE_OPENAI_API_KEY',  // azure_openai
    'AZURE_OPENAI_ENDPOINT', // azure_openai
    'PERPLEXITY_API_KEY',    // perplexity
    'MISTRAL_API_KEY',       // mistral
    'XAI_API_KEY',           // xai
    'CEREBRAS_API_KEY',      // cerebras
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
    if (value !== undefined && value !== '') {
      env[key] = value;
    }
  }
  // Always provide git identity defaults so Goose can commit.
  env['GIT_AUTHOR_NAME'] = GIT_AUTHOR_NAME;
  env['GIT_AUTHOR_EMAIL'] = GIT_AUTHOR_EMAIL;
  env['GIT_COMMITTER_NAME'] = GIT_COMMITTER_NAME;
  env['GIT_COMMITTER_EMAIL'] = GIT_COMMITTER_EMAIL;
  // Goose must not use the system keyring inside the container (no desktop
  // keyring service); force file-based secret storage off — keys come from env.
  env['GOOSE_DISABLE_KEYRING'] = 'true';
  return env;
}

/** Resolve the goose binary path. Falls back to `goose` on PATH. */
function resolveGooseBinary(): string {
  // The Dockerfile installs goose to /usr/local/bin/goose.
  return process.env['GOOSE_BIN'] ?? 'goose';
}

/**
 * Write the Goose `config.yaml` into the HOME volume so Goose picks up the VE
 * MCP submission server as a stdio extension. Goose reads its config from
 * `~/.config/goose/config.yaml` (or `$XDG_CONFIG_HOME/goose/config.yaml`).
 *
 * The VE MCP submission server is registered under the key `ve-submission` as a
 * stdio extension pointing at `node /agent-worker/dist/mcpSubmissionServer.js`
 * with the `VE_SUBMISSION_*` env vars. For codegen, the builtin `developer`
 * extension is enabled so Goose can edit files; for review, all builtin
 * extensions are disabled (read-only analysis).
 */
function writeGooseConfig(
  options: AgentRunOptions,
  nativeOptions: GooseNativeOptions,
  submissionServer: { command: string; args: string[]; env: Record<string, string> },
  submissionToolName: string,
): string {
  const configDir = join(homedir(), '.config', 'goose');
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, 'config.yaml');

  const lines: string[] = [
    '# Written by Virtual Engineer agent-worker for the goose provider.',
    'GOOSE_PROVIDER: auto',
    ...(options.model ? [`GOOSE_MODEL: ${options.model}`] : []),
    'keyring: false',
  ];

  if (nativeOptions.gooseMode) lines.push(`GOOSE_MODE: ${nativeOptions.gooseMode}`);
  if (nativeOptions.gooseMaxTurns !== undefined) lines.push(`GOOSE_MAX_TURNS: ${nativeOptions.gooseMaxTurns}`);
  if (nativeOptions.gooseMaxTokens !== undefined) lines.push(`GOOSE_MAX_TOKENS: ${nativeOptions.gooseMaxTokens}`);
  if (nativeOptions.gooseTemperature !== undefined) lines.push(`GOOSE_TEMPERATURE: ${nativeOptions.gooseTemperature}`);
  if (nativeOptions.gooseAutoCompactThreshold !== undefined) lines.push(`GOOSE_AUTO_COMPACT_THRESHOLD: ${nativeOptions.gooseAutoCompactThreshold}`);

  lines.push('', 'extensions:');
  // VE MCP submission extension (always enabled).
  lines.push('  ve-submission:');
  lines.push('    type: stdio');
  lines.push('    name: ve-submission');
  lines.push('    enabled: true');
  lines.push(`    cmd: ${submissionServer.command}`);
  lines.push(`    args: ${JSON.stringify(submissionServer.args)}`);
  lines.push('    envs:');
  for (const [k, v] of Object.entries(submissionServer.env)) {
    lines.push(`      ${k}: ${JSON.stringify(v)}`);
  }
  lines.push('    timeout: 300');

  if (options.mode === 'codegen') {
    // Enable the builtin Developer extension so Goose can edit files and run
    // shell commands inside the workspace. It is bundled with Goose.
    lines.push('  developer:');
    lines.push('    type: builtin');
    lines.push('    name: developer');
    lines.push('    enabled: true');
    lines.push('    bundled: true');
    lines.push('    timeout: 300');
  }
  // For review mode, no builtin extensions are enabled — Goose runs read-only.

  writeFileSync(configPath, lines.join('\n') + '\n', 'utf8');
  process.stderr.write(`goose config written to ${configPath} (tool=${submissionToolName}, mode=${options.mode})\n`);
  return configPath;
}

/** Build the goose argv for a non-interactive single-instruction session. */
function buildGooseArgs(
  promptFile: string,
  options: AgentRunOptions,
): string[] {
  const { mode } = options;
  const baseArgs = [
    'run',
    '--instructions', promptFile,
    '--no-session',
  ];
  if (mode === 'review') {
    // Review mode: read-only analysis. GOOSE_MODE=chat is set via env/config so
    // Goose does not execute tools; the review container also mounts /workspace
    // read-only as a hard backstop. The agent submits via ve_submit_review.
    return [...baseArgs, '--no-tui'];
  }
  // Codegen mode: Goose edits files and commits via the Developer extension.
  return [...baseArgs, '--no-tui'];
}

/** Run a Goose CLI session and return the assistant's final text + tool stats. */
export async function runGooseAgent(
  prompt: string,
  options: AgentRunOptions,
): Promise<AgentRun> {
  const { model, agentInstructions, cwd, timeoutMs, mode, reviewOutputSchema } = options;
  const modelLabel = model || 'goose-default';

  emitEvent('session.start', { model: modelLabel, mode, workingDirectory: cwd });
  process.stderr.write(`starting Goose CLI (mode=${mode}, model=${modelLabel})\n`);

  // Build the VE MCP submission config. The submission server is a stdio MCP
  // server spawned by Goose as a child process; it writes the submission
  // artifact to /ve-home/agent-submission.json, which the worker reads after
  // the run.
  const submissionSchema = mode === 'review' ? reviewOutputSchema : CHANGE_SUBMISSION_JSON_SCHEMA;
  if (submissionSchema === undefined) {
    throw new Error(
      mode === 'review'
        ? 'REVIEW_OUTPUT_SCHEMA is required for Goose MCP review submissions'
        : 'Change submission schema is required for Goose MCP codegen submissions',
    );
  }
  const submission = buildSubmissionMcpConfig(mode, submissionSchema);

  // Append the submission instruction to the agent instructions so Goose knows
  // to call ve_submit_changes / ve_submit_review exactly once.
  const fullAgentInstructions = appendSubmissionInstruction(agentInstructions, submission.toolName);

  // Write the workflow request to a temp file; Goose reads it via --instructions.
  const tmpDir = mkdtempSync(join('/tmp', 've-goose-'));
  const promptFile = join(tmpDir, 'prompt.txt');
  const agentInstructionsFile = join(tmpDir, 'agent-instructions.md');
  writeFileSync(promptFile, `${prompt}\n\n${fullAgentInstructions}`, 'utf8');
  // Goose does not have a separate --read flag for instructions like Aider; the
  // instructions are appended to the prompt file above. We keep the separate
  // file for parity with the Aider runner and potential future use.
  writeFileSync(agentInstructionsFile, fullAgentInstructions, 'utf8');

  const nativeOptions = resolveGooseNativeOptions();
  // For review mode, force GOOSE_MODE=chat so Goose does not execute tools.
  if (mode === 'review' && !nativeOptions.gooseMode) {
    nativeOptions.gooseMode = 'chat';
  }
  writeGooseConfig(options, nativeOptions, submission.server, submission.toolName);

  const args = buildGooseArgs(promptFile, options);
  const env = buildGooseEnv();

  const state = {
    toolCallCount: 0,
    toolsByKind: {} as Record<string, number>,
    toolCalls: [] as ObservedToolCall[],
  };
  let content = '';
  let assistantText = '';
  let stderrAccum = '';

  const child = spawn(resolveGooseBinary(), args, {
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

  const heartbeat = setInterval(() => {
    process.stderr.write(`agent working… (${state.toolCallCount} tool call(s) so far)\n`);
  }, 30_000);

  // Line buffers for stdout/stderr: streaming delivers partial lines across
  // multiple 'data' events; accumulate until a newline before parsing.
  let stdoutBuf = '';
  let stderrBuf = '';

  const flushStdoutLine = (line: string): void => {
    processGooseLine(line.trimEnd(), state, (chunk) => { assistantText += chunk; });
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Goose session timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) flushStdoutLine(line);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stderrAccum += text;
        stderrBuf += text;
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop() ?? '';
        for (const line of lines) processGooseStderrLine(line.trimEnd(), state);
      });
      child.on('error', (err) => reject(err));
      child.on('close', (code, signal) => {
        // Flush any trailing output not terminated by a newline.
        if (stdoutBuf.trim()) flushStdoutLine(stdoutBuf);
        if (stderrBuf.trim()) processGooseStderrLine(stderrBuf.trimEnd(), state);
        if (typeof signal === 'string') {
          reject(new Error(`Goose terminated by signal ${signal}`));
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

  // Goose's final assistant message is the accumulated stdout. For review mode
  // with MCP transport, the actual review output comes from the submission file
  // (read by the caller); the streamed text is a fallback only.
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
    toolCalls: state.toolCalls,
    cleanup: async (): Promise<void> => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    },
  };
}

export const GOOSE_PROVIDER: AgentProviderDefinition = {
  id: 'goose',
  adapterLabel: 'goose-cli',
  resolveModel: () => process.env['GOOSE_MODEL'] ?? '',
  defaultModelLabel: 'goose-default',
  submissionTransport: 'mcp',
  validateEnvironment: () => {
    // Goose reads provider keys from the environment. We do not hard-fail here
    // for a specific provider since the operator may use Bedrock (AWS env
    // chain) or Ollama (no key). The adapter's resolveAuthEnv validates the
    // key requirement per-provider on the host side.
  },
  runner: runGooseAgent,
};

/**
 * Build a descriptive error message from a Goose non-zero exit code.
 * Extracts the last error-class line from the accumulated stderr so the
 * operator sees the actual exception rather than just the exit code.
 */
function buildExitError(code: number, stderr: string): string {
  const base = `Goose exited with code ${code}`;
  if (!stderr.trim()) return base;

  const lines = stderr.split('\n');
  let errorLine: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? '';
    if (!line) continue;
    if (/Error:|Exception:|panic:|FATAL:|fatal:/i.test(line)) {
      errorLine = line;
      break;
    }
  }
  if (!errorLine) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim() ?? '';
      if (line) { errorLine = line; break; }
    }
  }
  if (!errorLine) return base;
  const summary = errorLine.length > 300 ? errorLine.slice(0, 297) + '...' : errorLine;
  return `${base}: ${summary}`;
}

/**
 * Parse a single line of Goose stdout. Goose prints assistant text, tool-call
 * announcements, and commit subjects. We emit `__ve_event`s for tool calls and
 * commits, and accumulate assistant text for the final result.
 *
 * Goose's CLI output format is not fully stable; this parser is intentionally
 * permissive and matches common patterns. The authoritative submission signal
 * is the MCP tool call (observed via the submission file), not stdout parsing.
 */
function processGooseLine(
  line: string,
  state: { toolCallCount: number; toolsByKind: Record<string, number>; toolCalls: ObservedToolCall[] },
  onAssistant: (chunk: string) => void,
): void {
  if (!line) return;

  // Goose announces tool calls like "[tool] edit(path)" or "Calling tool: edit".
  const toolCallMatch = line.match(/^(?:\[tool\]\s*|Calling tool:\s*|🔧\s*)(.+)$/i);
  if (toolCallMatch) {
    const toolName = toolCallMatch[1]!.trim().split(/\s+/)[0] ?? 'unknown';
    state.toolCallCount++;
    state.toolsByKind[toolName] = (state.toolsByKind[toolName] ?? 0) + 1;
    process.stderr.write(`[tool] #${state.toolCallCount} ${toolName}\n`);
    emitEvent('tool.execution_start', { name: toolName, input: {}, callNumber: state.toolCallCount });
    return;
  }

  // Detect the VE MCP submission tool call. Goose reports MCP tools as
  // `mcp__<server>__<tool>` (Claude-style) or `<server>-<tool>` (CLI-style).
  // We record an ObservedToolCall so the worker's assertSuccessfulSubmissionToolCall
  // can validate exactly one accepted submission.
  const submissionMatch = line.match(/(?:ve_submit_changes|ve_submit_review|mcp__ve-submission__ve_submit_(?:changes|review)|ve-submission-ve_submit_(?:changes|review))/i);
  if (submissionMatch) {
    const rawName = submissionMatch[0]!;
    // Normalize to the mcp__ve-submission__<tool> form that assertSuccessfulSubmissionToolCall accepts.
    const toolName = rawName.includes('review') ? 've_submit_review' : 've_submit_changes';
    const normalizedName = `mcp__ve-submission__${toolName}`;
    // We cannot determine success from stdout alone; the submission file's
    // existence (checked by the caller via readSubmission) is the source of
    // truth. Mark as success=true optimistically; assertSuccessfulSubmissionToolCall
    // + readSubmission enforce the real invariant.
    const existing = state.toolCalls.find((c) => c.name === normalizedName);
    if (!existing) {
      state.toolCalls.push({ name: normalizedName, input: {}, success: true });
    }
    return;
  }

  // Detect commit announcements (Goose commits via the Developer extension).
  const commitMatch = line.match(/(?:^commit\s+|Created commit\s+)([0-9a-f]{7,40})/i);
  if (commitMatch) {
    emitEvent('commit.created', { sha: commitMatch[1] });
    return;
  }

  // Token / cost line. Goose prints usage summaries; the exact format varies by
  // provider. Match common patterns like "Tokens: X sent, Y received" or
  // "input_tokens: X, output_tokens: Y".
  const tokenMatch = line.match(/Tokens?:\s*(\d+)\s*sent,?\s*(\d+)\s*received/i)
    ?? line.match(/input_tokens:\s*(\d+),?\s*output_tokens:\s*(\d+)/i);
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

  // Otherwise treat as assistant text.
  onAssistant(line + '\n');
  if (line.length > 0) {
    emitEvent('assistant.message', { content: line.slice(0, 3000) });
  }
}

/** Parse a single line of Goose stderr — mostly progress/warnings. */
function processGooseStderrLine(
  line: string,
  _state: { toolCallCount: number; toolsByKind: Record<string, number>; toolCalls: ObservedToolCall[] },
): void {
  if (!line) return;
  // Forward verbatim so the host adapter's stderr parser captures plain log lines.
  process.stderr.write(line + '\n');
}