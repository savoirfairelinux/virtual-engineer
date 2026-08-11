#!/usr/bin/env node
/**
 * Validate the Copilot connection from inside the agent container.
 * Used by copilotConnectionValidator when node:sqlite is not available on the host.
 */

import { CopilotClient, approveAll } from '@github/copilot-sdk';
import type { CopilotSession } from '@github/copilot-sdk';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { createConnection } from 'net';
import { buildCopilotCliArgs, buildCopilotNetworkEnvironment } from './copilotCliArgs.js';

const GITHUB_TOKEN = (process.env['GITHUB_TOKEN'] ?? '').trim();
const COPILOT_MODEL = (process.env['COPILOT_MODEL'] ?? '').trim();
const VALIDATION_PROMPT = 'Return only the word OK.';
const VALIDATION_TIMEOUT_MS = 15_000;

interface ValidationResult {
  success: boolean;
  error: string | null;
  models: Array<{ id: string; name: string }>;
}

interface LocalCliServer {
  child: ChildProcess;
  cliUrl: string;
}

function trimOptional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function toFailure(error: string, models: Array<{ id: string; name: string }> = []): ValidationResult {
  return { success: false, error, models };
}

function getAuthFailureMessage(status: { statusMessage?: string | undefined }): string {
  return (status.statusMessage && status.statusMessage.trim())
    ? status.statusMessage.trim()
    : 'GitHub Copilot authentication is not available.';
}

function serializeModels(models: Array<{ id: string; name: string }>): Array<{ id: string; name: string }> {
  return models.map((model) => ({ id: model.id, name: model.name }));
}

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

async function startLocalCliServer(): Promise<LocalCliServer> {
  const cliPath = '/app/agent-worker/node_modules/.bin/copilot';
  const port = 3000;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const child = spawn(cliPath, buildCopilotCliArgs(port), {
    env: {
      GITHUB_TOKEN: process.env['GITHUB_TOKEN'] ?? '',
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

  child.stdout?.on('data', (chunk: unknown) => stdoutChunks.push(String(chunk)));
  child.stderr?.on('data', (chunk: unknown) => stderrChunks.push(String(chunk)));

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

async function validateConnection(): Promise<ValidationResult> {
  if (!GITHUB_TOKEN) {
    return toFailure('Failed to get GitHub OAuth token. Set the GITHUB_TOKEN environment variable.');
  }

  let localCliServer: LocalCliServer | null = null;
  let client: CopilotClient | undefined;
  let session: CopilotSession | undefined;
  let models: Array<{ id: string; name: string }> = [];
  let selectedModel: string | undefined;

  try {
    localCliServer = await startLocalCliServer();

    client = new CopilotClient({ cliUrl: localCliServer.cliUrl });
    await client.start();

    const authStatus = await client.getAuthStatus();
    if (!authStatus.isAuthenticated) {
      return toFailure(getAuthFailureMessage(authStatus));
    }

    models = serializeModels(await client.listModels());
    if (models.length === 0) {
      return toFailure('GitHub Copilot returned no available models.');
    }

    const configuredModel = trimOptional(COPILOT_MODEL);
    if (configuredModel && !models.some((model) => model.id === configuredModel)) {
      return toFailure(`Configured Copilot model "${configuredModel}" is not available.`, models);
    }

    selectedModel = configuredModel ?? models[0]?.id;
    if (!selectedModel) {
      return toFailure('GitHub Copilot returned no available models.', models);
    }
    session = await client.createSession({
      model: selectedModel,
      onPermissionRequest: approveAll,
    });

    const response = await session.sendAndWait(
      { prompt: VALIDATION_PROMPT },
      VALIDATION_TIMEOUT_MS,
    );

    if (!response) {
      return toFailure(
        `GitHub Copilot did not return a validation response for model "${selectedModel}".`,
        models,
      );
    }

    return { success: true, error: null, models };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (selectedModel) {
      return toFailure(
        `GitHub Copilot session validation failed for model "${selectedModel}": ${errorMessage}`,
        models,
      );
    }
    return toFailure(errorMessage, models);
  } finally {
    if (session?.disconnect != null) {
      await session.disconnect().catch(() => undefined);
    }
    if (client != null) {
      await client.stop().catch(() => undefined);
    }
    if (localCliServer?.child != null) {
      localCliServer.child.kill('SIGTERM');
    }
  }
}

validateConnection()
  .then((result) => {
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  })
  .catch((err: unknown) => {
    const errorMessage = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify(toFailure(errorMessage)) + '\n');
    process.exit(0);
  });
