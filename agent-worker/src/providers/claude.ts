/**
 * Virtual Engineer — Claude Code session runner (agent worker).
 *
 * Runs INSIDE the Docker container for the `claude` provider. Drives the
 * Anthropic Claude Agent SDK against the pre-cloned `/workspace` repository and
 * maps its streamed messages onto the shared `__ve_event` stderr protocol used
 * by every provider, so the host adapter's event / commit / result pipeline is
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
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { NETWORK_DISALLOWED_TOOLS } from '../networkGuard.js';
import { emitLocalSkillsLoaded } from '../skills.js';
import { emitEvent } from './events.js';
import type { AgentProviderDefinition, AgentRun, AgentRunOptions } from './types.js';
import {
  CHANGE_SUBMISSION_JSON_SCHEMA,
  appendSubmissionInstruction,
  buildSubmissionMcpConfig,
} from '../mcpSubmission.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface ClaudeNativeOptions {
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  thinkingMode?: 'adaptive' | 'enabled' | 'disabled';
  thinkingBudgetTokens?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
}

function positiveNumberFromEnv(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveClaudeNativeOptions(): ClaudeNativeOptions {
  const effort = process.env['CLAUDE_EFFORT'];
  const thinkingMode = process.env['CLAUDE_THINKING_MODE'];
  const thinkingBudgetTokens = positiveNumberFromEnv('CLAUDE_THINKING_BUDGET_TOKENS');
  const maxTurns = positiveNumberFromEnv('CLAUDE_MAX_TURNS');
  const maxBudgetUsd = positiveNumberFromEnv('CLAUDE_MAX_BUDGET_USD');
  return {
    ...(effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max'
      ? { effort }
      : {}),
    ...(thinkingMode === 'adaptive' || thinkingMode === 'enabled' || thinkingMode === 'disabled'
      ? { thinkingMode }
      : {}),
    ...(thinkingBudgetTokens !== undefined ? { thinkingBudgetTokens } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
  };
}

export function buildClaudeQueryOptions(
  options: AgentRunOptions,
  nativeOptions: ClaudeNativeOptions = resolveClaudeNativeOptions(),
  runtime: Pick<Options, 'abortController' | 'stderr'> = {},
): Options {
  const {
    model,
    agentInstructions,
    cwd,
    mode,
    skillDiscovery,
    reviewOutputSchema,
  } = options;
  const thinking = nativeOptions.thinkingMode === 'enabled'
    ? { type: 'enabled' as const, budgetTokens: nativeOptions.thinkingBudgetTokens ?? 10_000 }
    : nativeOptions.thinkingMode === 'adaptive'
      ? { type: 'adaptive' as const }
      : nativeOptions.thinkingMode === 'disabled'
        ? { type: 'disabled' as const }
        : undefined;
  const submissionSchema = mode === 'review'
    ? reviewOutputSchema
    : CHANGE_SUBMISSION_JSON_SCHEMA;
  const submission = submissionSchema !== undefined
    ? buildSubmissionMcpConfig(mode, submissionSchema)
    : null;
  return {
    ...(model ? { model } : {}),
    cwd,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: submission !== null
        ? appendSubmissionInstruction(agentInstructions, submission.toolName)
        : agentInstructions,
    },
    ...(mode === 'review'
      ? {
          permissionMode: 'dontAsk' as const,
          tools: [
            'Read',
            'Glob',
            'Grep',
            ...(submission !== null ? [`mcp__ve-submission__${submission.toolName}`] : []),
          ],
          allowedTools: [
            'Read',
            'Glob',
            'Grep',
            ...(submission !== null ? [`mcp__ve-submission__${submission.toolName}`] : []),
          ],
        }
      : {
          permissionMode: 'bypassPermissions' as const,
          allowDangerouslySkipPermissions: true,
        }),
    disallowedTools: NETWORK_DISALLOWED_TOOLS,
    settingSources: skillDiscovery ? ['project'] : [],
    strictMcpConfig: true,
    ...(submission !== null
      ? { mcpServers: { 've-submission': submission.server } }
      : {}),
    ...(nativeOptions.effort !== undefined ? { effort: nativeOptions.effort } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(nativeOptions.maxTurns !== undefined ? { maxTurns: nativeOptions.maxTurns } : {}),
    ...(nativeOptions.maxBudgetUsd !== undefined ? { maxBudgetUsd: nativeOptions.maxBudgetUsd } : {}),
    ...runtime,
  };
}

/** Run a Claude Code session and return the assistant's final text + tool stats. */
export async function runClaudeAgent(
  prompt: string,
  options: AgentRunOptions,
): Promise<AgentRun> {
  const { model, cwd, timeoutMs, mode, skillDiscovery } = options;
  const modelLabel = model || 'cli-default';

  emitEvent('session.start', { model: modelLabel, mode, workingDirectory: cwd });
  if (skillDiscovery) emitLocalSkillsLoaded(cwd);
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
    options: buildClaudeQueryOptions(options, resolveClaudeNativeOptions(), {
      abortController,
      stderr: (data: string) => process.stderr.write(data),
    }),
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
        if (subtype === 'success') {
          if (typeof msg['result'] === 'string') {
            content = msg['result'];
          }
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

export const CLAUDE_PROVIDER: AgentProviderDefinition = {
  id: 'claude',
  adapterLabel: 'claude-agent-sdk',
  resolveModel: () => process.env['CLAUDE_MODEL'] ?? '',
  defaultModelLabel: 'cli-default',
  submissionTransport: 'mcp',
  runner: runClaudeAgent,
};
