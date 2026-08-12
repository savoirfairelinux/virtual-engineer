import { readFileSync, writeFileSync } from 'fs';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { ObservedToolCall } from './providers/types.js';

export type SubmissionMode = 'codegen' | 'review';

export interface SubmissionMcpServerConfig {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface SubmissionMcpConfig {
  toolName: 've_submit_changes' | 've_submit_review';
  server: SubmissionMcpServerConfig;
}

const SUBMISSION_SERVER_PATH = '/app/agent-worker/dist/mcpSubmissionServer.js';
// /tmp is one of the few paths the sandbox's deny-by-default filesystem policy makes writable.
export const DEFAULT_SUBMISSION_PATH = '/tmp/ve-agent-submission.json';
const MAX_SUBMISSION_BYTES = 256 * 1024;

export const SUBMISSION_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export const CHANGE_SUBMISSION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['completed', 'no_change'] },
    summary: { type: 'string', minLength: 1 },
  },
  required: ['status', 'summary'],
  additionalProperties: false,
};

export function appendSubmissionInstruction(
  agentInstructions: string,
  toolName: SubmissionMcpConfig['toolName'],
): string {
  return `${agentInstructions.trim()}\n\n` +
    `Submit the final structured result through ${toolName} before ending. ` +
    'Exactly one submission must be accepted; correct and retry rejected attempts.';
}

export function assertSuccessfulSubmissionToolCall(
  mode: SubmissionMode,
  toolCalls: ObservedToolCall[],
): void {
  const toolName = mode === 'review' ? 've_submit_review' : 've_submit_changes';
  const submissionNames = new Set([
    toolName,
    `mcp__ve-submission__${toolName}`,
    `ve-submission-${toolName}`,
    `virtual-engineer-submission-${toolName}`,
    // Gemini CLI's documented MCP tool FQN scheme is `mcp_{serverName}_{toolName}`
    // (server name here is `ve-submission`, hyphenated so it doesn't collide
    // with the parser's underscore-splitting rule) — verify against a live run.
    `mcp_ve-submission_${toolName}`,
  ]);
  const calls = toolCalls.filter(({ name }) => submissionNames.has(name));
  const acceptedCalls = calls.filter(({ success }) => success === true);
  if (acceptedCalls.length === 1) return;
  if (acceptedCalls.length > 1) {
    throw new Error(
      `${toolName} MCP submission must be accepted exactly once; observed ${acceptedCalls.length} accepted submissions`,
    );
  }

  const lastFailedCall = [...calls].reverse().find(({ success }) => success === false);
  if (lastFailedCall !== undefined) {
    throw new Error(
      `${toolName} MCP tool failed: ${lastFailedCall.error ?? 'unknown tool execution error'}`,
    );
  }
  throw new Error(`${toolName} MCP submission was not accepted`);
}

export function assertSingleNativeReviewDelegation(toolCalls: ObservedToolCall[]): void {
  const observedCalls = toolCalls.filter(({ name, input }) =>
    name === 'task' &&
    input['agent_type'] === 'code-review' &&
    input['mode'] === 'sync'
  ).length;
  if (observedCalls !== 1) {
    throw new Error(
      `Copilot native review must delegate to task(agent_type=code-review, mode=sync) exactly once; observed ${observedCalls} calls`,
    );
  }
}

export function buildSubmissionMcpConfig(
  mode: SubmissionMode,
  schema: Record<string, unknown>,
  submissionPath: string = DEFAULT_SUBMISSION_PATH,
): SubmissionMcpConfig {
  const toolName = mode === 'review' ? 've_submit_review' : 've_submit_changes';
  return {
    toolName,
    server: {
      type: 'stdio',
      command: 'node',
      args: [SUBMISSION_SERVER_PATH],
      env: {
        VE_SUBMISSION_MODE: mode,
        VE_SUBMISSION_PATH: submissionPath,
        VE_SUBMISSION_SCHEMA_JSON: JSON.stringify(schema),
      },
    },
  };
}

export function recordSubmission(path: string, value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('MCP submission must be a JSON object');
  }

  const encoded = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_SUBMISSION_BYTES) {
    throw new Error(`MCP submission exceeds ${MAX_SUBMISSION_BYTES} bytes`);
  }

  try {
    writeFileSync(path, encoded, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (err) {
    const code = err instanceof Error && 'code' in err
      ? String((err as Error & { code?: unknown }).code)
      : '';
    if (code === 'EEXIST') {
      throw new Error('MCP submission was already recorded');
    }
    throw err;
  }
}

export function validateSubmission(
  schema: Record<string, unknown>,
  value: unknown,
): Record<string, unknown> {
  const validator = new AjvJsonSchemaValidator().getValidator<Record<string, unknown>>(
    schema,
  );
  const result = validator(value);
  if (!result.valid) {
    throw new Error(`MCP submission does not match its JSON Schema: ${result.errorMessage}`);
  }
  if (typeof result.data !== 'object' || result.data === null || Array.isArray(result.data)) {
    throw new Error('MCP submission must be a JSON object');
  }
  return result.data;
}

export function readSubmission(
  path: string = DEFAULT_SUBMISSION_PATH,
  schema?: Record<string, unknown>,
): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = err instanceof Error && 'code' in err
      ? String((err as Error & { code?: unknown }).code)
      : '';
    if (code === 'ENOENT') {
      throw new Error('Agent did not submit a result through the VE MCP tool');
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`VE MCP submission contains invalid JSON: ${message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('VE MCP submission must contain a JSON object');
  }
  return schema !== undefined
    ? validateSubmission(schema, parsed)
    : parsed as Record<string, unknown>;
}