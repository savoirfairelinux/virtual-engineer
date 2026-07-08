/**
 * Virtual Engineer — Claude Code session runner (agent worker).
 *
 * Runs INSIDE the Docker container when `AGENT_PROVIDER=claude`. Drives the
 * Anthropic Claude Agent SDK against the pre-cloned `/workspace` repository and
 * maps its streamed messages onto the same `__ve_event` stderr protocol used by
 * the Copilot path, so the host adapter's event/commit/result pipeline is
 * provider-agnostic.
 *
 * The agent edits files and creates git commits via the SDK's built-in Bash /
 * Edit / Write tools; commit collection is handled by the caller after this
 * runner returns the assistant's final text.
 *
 * Authentication is via the process environment: `ANTHROPIC_API_KEY`
 * (api-key integrations) or `CLAUDE_CODE_OAUTH_TOKEN` (subscription
 * integrations). The host adapter injects exactly one of these.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { NETWORK_DISALLOWED_TOOLS } from './networkGuard.js';

export interface ClaudeAgentRun {
  content: string;
  toolCallCount: number;
  toolsByKind: Record<string, number>;
  cleanup: () => Promise<void>;
}

export interface ClaudeAgentOptions {
  /** Model override; when empty the Claude CLI selects its own default. */
  model: string;
  systemPrompt: string;
  cwd: string;
  timeoutMs: number;
  mode: 'codegen' | 'review';
  /** When true, load project (.claude) settings/skills. */
  skillDiscovery?: boolean;
}

/** Emit a structured VE event on stderr (mirrors the copilot worker format). */
function emitEvent(type: string, data: Record<string, unknown>): void {
  process.stderr.write(
    JSON.stringify({ __ve_event: true, type, data, ts: new Date().toISOString() }) + '\n',
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Run a Claude Code session and return the assistant's final text + tool stats. */
export async function runClaudeAgent(
  prompt: string,
  options: ClaudeAgentOptions,
): Promise<ClaudeAgentRun> {
  const { model, systemPrompt, cwd, timeoutMs, mode, skillDiscovery } = options;
  const modelLabel = model || 'cli-default';

  emitEvent('session.start', { model: modelLabel, mode, workingDirectory: cwd });
  process.stderr.write(`starting Claude Agent SDK (mode=${mode}, model=${modelLabel})\n`);

  const state = { toolCallCount: 0, toolsByKind: {} as Record<string, number> };
  let content = '';
  // Accumulated assistant text — used as a fallback when the terminal `result`
  // message carries no string `result` (important for review mode's rawOutput).
  let assistantText = '';

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);

  const heartbeat = setInterval(() => {
    process.stderr.write(`agent working… (${state.toolCallCount} tool call(s) so far)\n`);
  }, 30_000);

  const stream = query({
    prompt,
    options: {
      // Omit `model` entirely when unset so the CLI applies its own default.
      ...(model ? { model } : {}),
      cwd,
      // Coding runs use Claude Code's default agent preset (tool-usage
      // scaffolding) with VE's instructions appended. Review runs replace the
      // prompt entirely with VE's reviewer prompt so it fully owns behavior.
      systemPrompt:
        mode === 'review'
          ? systemPrompt
          : { type: 'preset', preset: 'claude_code', append: systemPrompt },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      // Deny internet-reaching tools even under bypassPermissions.
      disallowedTools: NETWORK_DISALLOWED_TOOLS,
      // Load only team-shared project settings/skills when discovery is enabled;
      // otherwise start from a clean slate (no user/local settings on disk).
      settingSources: skillDiscovery ? ['project'] : [],
      abortController,
      stderr: (data: string) => process.stderr.write(data),
    },
  });

  try {
    for await (const message of stream) {
      const msg = asRecord(message);
      if (!msg) continue;
      const type = typeof msg['type'] === 'string' ? msg['type'] : '';

      if (type === 'assistant') {
        const inner = asRecord(msg['message']);
        const blocks = inner && Array.isArray(inner['content']) ? (inner['content'] as unknown[]) : [];
        for (const block of blocks) {
          const b = asRecord(block);
          if (!b) continue;
          if (b['type'] === 'tool_use') {
            state.toolCallCount++;
            const toolName = typeof b['name'] === 'string' ? b['name'] : 'unknown_tool';
            state.toolsByKind[toolName] = (state.toolsByKind[toolName] ?? 0) + 1;
            const input = asRecord(b['input']) ?? {};
            process.stderr.write(`[tool] #${state.toolCallCount} ${toolName}\n`);
            emitEvent('tool.execution_start', {
              name: toolName,
              input,
              callNumber: state.toolCallCount,
            });
          } else if (b['type'] === 'text' && typeof b['text'] === 'string') {
            const text = b['text'];
            if (text) {
              assistantText += (assistantText ? '\n' : '') + text;
              emitEvent('assistant.message', { content: text.slice(0, 3000) });
            }
          }
        }
        const usage = inner ? asRecord(inner['usage']) : null;
        if (usage) {
          emitEvent('assistant.usage', {
            inputTokens: numberOrNull(usage['input_tokens']),
            outputTokens: numberOrNull(usage['output_tokens']),
            cacheReadTokens: numberOrNull(usage['cache_read_input_tokens']),
            cacheWriteTokens: numberOrNull(usage['cache_creation_input_tokens']),
            model: modelLabel,
          });
        }
        continue;
      }

      if (type === 'result') {
        const subtype = typeof msg['subtype'] === 'string' ? msg['subtype'] : '';
        if (subtype === 'success' && typeof msg['result'] === 'string') {
          content = msg['result'];
        }
        const costUsd = numberOrNull(msg['total_cost_usd']);
        if (costUsd !== null) {
          emitEvent('cost.total', { costUsd, numTurns: numberOrNull(msg['num_turns']), model: modelLabel });
        }
        if (subtype && subtype !== 'success') {
          const errors = Array.isArray(msg['errors']) ? (msg['errors'] as unknown[]).join('; ') : subtype;
          emitEvent('session.error', { message: String(errors) });
          throw new Error(`Claude session ended with error: ${errors}`);
        }
        continue;
      }

      if (type === 'stream_event' || type === 'system') {
        // Non-essential lifecycle chatter; ignore.
        continue;
      }
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timer);
    // Ensure the underlying CLI subprocess is torn down even on abort/error.
    try {
      stream.close();
    } catch {
      /* ignore */
    }
  }

  // Fall back to accumulated assistant text when the terminal result carried no
  // string payload — otherwise review mode would emit empty output.
  const finalContent = content || assistantText;

  emitEvent('session.end', {
    mode,
    toolCallCount: state.toolCallCount,
    toolsByKind: state.toolsByKind,
    model: modelLabel,
    outputLength: finalContent.length,
  });

  return {
    content: finalContent || 'Task completed',
    toolCallCount: state.toolCallCount,
    toolsByKind: state.toolsByKind,
    cleanup: async (): Promise<void> => {
      try {
        stream.close();
      } catch {
        /* ignore */
      }
    },
  };
}
