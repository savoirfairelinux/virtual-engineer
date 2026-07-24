#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { recordSubmission, validateSubmission } from './mcpSubmission.js';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseSchema(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('VE_SUBMISSION_SCHEMA_JSON must contain a JSON object');
  }
  return parsed as Record<string, unknown>;
}

async function main(): Promise<void> {
  const mode = requiredEnv('VE_SUBMISSION_MODE');
  if (mode !== 'codegen' && mode !== 'review') {
    throw new Error(`Unsupported VE_SUBMISSION_MODE: ${mode}`);
  }
  const submissionPath = requiredEnv('VE_SUBMISSION_PATH');
  const inputSchema = parseSchema(requiredEnv('VE_SUBMISSION_SCHEMA_JSON'));
  const toolName = mode === 'review' ? 've_submit_review' : 've_submit_changes';

  const server = new Server(
    { name: 'virtual-engineer-submission', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{
      name: toolName,
      description: mode === 'review'
        ? 'Submit the final structured review to Virtual Engineer exactly once.'
        : 'Submit the final change summary to Virtual Engineer exactly once.',
      inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    }],
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    if (request.params.name !== toolName) {
      throw new Error(`Unknown submission tool: ${request.params.name}`);
    }
    const submission = validateSubmission(inputSchema, request.params.arguments ?? {});
    recordSubmission(submissionPath, submission);
    return {
      content: [{ type: 'text', text: 'Submission accepted by Virtual Engineer.' }],
    };
  });

  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`FATAL: VE submission MCP server failed: ${message}\n`);
  process.exit(1);
});