#!/usr/bin/env node
import { CopilotClient, approveAll } from '@github/copilot-sdk';
import net from 'net';
import { spawn } from 'child_process';

const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const COPILOT_MODEL = (process.env.COPILOT_MODEL || '').trim();
const VALIDATION_PROMPT = 'Return only the word OK.';
const VALIDATION_TIMEOUT_MS = 15_000;

function trimOptional(value) {
  const trimmed = value && value.trim();
  return trimmed ? trimmed : undefined;
}

function toFailure(error, models = []) {
  return {
    success: false,
    error,
    models,
  };
}

function getAuthFailureMessage(status) {
  return status.statusMessage && status.statusMessage.trim()
    ? status.statusMessage.trim()
    : 'GitHub Copilot authentication is not available.';
}

function serializeModels(models) {
  return models.map((model) => ({
    id: model.id,
    name: model.name,
  }));
}

function waitForPort(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const attempt = () => {
      const socket = net.createConnection({ host, port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(undefined);
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

async function startLocalCliServer() {
  const cliPath = '/agent-worker/node_modules/.bin/copilot';
  const port = 3000;
  const stdoutChunks = [];
  const stderrChunks = [];

  const child = spawn(cliPath, ['--headless', '--port', String(port)], {
    env: {
      GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      TMPDIR: process.env.TMPDIR || '',
      TMP: process.env.TMP || '',
      TEMP: process.env.TEMP || '',
      USER: process.env.USER || '',
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => stdoutChunks.push(String(chunk)));
  child.stderr.on('data', (chunk) => stderrChunks.push(String(chunk)));

  try {
    await waitForPort('127.0.0.1', port, 30_000);
  } catch (err) {
    child.kill('SIGTERM');
    const detail = `${stdoutChunks.join('')}\n${stderrChunks.join('')}`.trim();
    throw new Error(
      `Failed to start local Copilot CLI server: ${err.message}${detail ? `\n${detail}` : ''}`
    );
  }

  return {
    child,
    cliUrl: `127.0.0.1:${port}`,
  };
}

async function validateConnection() {
  if (!GITHUB_TOKEN) {
    return toFailure('Failed to get GitHub OAuth token. Set the GITHUB_TOKEN environment variable.');
  }

  let localCliServer = null;
  let client;
  let session;
  let models = [];
  let selectedModel;

  try {
    localCliServer = await startLocalCliServer();

    client = new CopilotClient({
      cliUrl: localCliServer.cliUrl,
    });

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

    selectedModel = configuredModel || models[0].id;
    session = await client.createSession({
      model: selectedModel,
      onPermissionRequest: approveAll,
    });

    const response = await session.sendAndWait(
      {
        prompt: VALIDATION_PROMPT,
        mode: 'immediate',
      },
      VALIDATION_TIMEOUT_MS
    );

    if (!response) {
      return toFailure(
        `GitHub Copilot did not return a validation response for model "${selectedModel}".`,
        models
      );
    }

    return {
      success: true,
      error: null,
      models,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (selectedModel) {
      return toFailure(
        `GitHub Copilot session validation failed for model "${selectedModel}": ${errorMessage}`,
        models
      );
    }

    return toFailure(errorMessage, models);
  } finally {
    if (session && session.disconnect) {
      await session.disconnect().catch(() => undefined);
    }
    if (client) {
      await client.stop().catch(() => undefined);
    }
    if (localCliServer && localCliServer.child) {
      localCliServer.child.kill('SIGTERM');
    }
  }
}

validateConnection()
  .then((result) => {
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  })
  .catch((err) => {
    const errorMessage = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify(toFailure(errorMessage)) + '\n');
    process.exit(0);
  });