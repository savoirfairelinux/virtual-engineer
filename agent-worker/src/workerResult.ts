import type { Writable } from 'node:stream';
import type { AgentResult } from '../../src/interfaces.js';

interface WorkerOutput {
  stdout: Writable;
  stderr: Writable;
  exit: (code: number) => void;
}

function maskError(text: string): string {
  let masked = text;
  const secrets = Object.entries(process.env)
    .filter(([name]) => /TOKEN|SECRET|PASSWORD|API_KEY/i.test(name))
    .map(([, value]) => value)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) masked = masked.replaceAll(secret, '<redacted>');
  return masked
    .replace(/((?:Bearer|Basic)\s+)[^\s"'&,}]+/gi, '$1<redacted>')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s?#@]+@/gi, '$1<redacted>@')
    .replace(/((?:token|secret|password|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi, '$1<redacted>');
}

function writeOutput(stream: Writable, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.write(text, (error) => {
      if (error) {
        reject(error);
      } else {
        stream.removeListener('error', reject);
        resolve();
      }
    });
  });
}

export async function runWorker(
  main: () => Promise<AgentResult>,
  metadata: Record<string, unknown>,
  output: WorkerOutput = process,
): Promise<void> {
  let result: AgentResult;
  try {
    result = await main();
  } catch (error: unknown) {
    const message = maskError(error instanceof Error ? error.message : String(error));
    await writeOutput(output.stderr, `${JSON.stringify({
      __ve_event: true, type: 'worker.error', ts: new Date().toISOString(), data: { message: message.slice(0, 2_000) },
    })}\n`).catch(() => undefined);
    result = {
      status: 'failed',
      modifiedFiles: [],
      summary: `Agent worker error: ${message}`,
      agentLogs: maskError(error instanceof Error ? (error.stack ?? message) : message),
      metadata: { ...metadata, error: message },
    };
  }

  try {
    await writeOutput(output.stdout, `${JSON.stringify(result)}\n`);
  } catch (error: unknown) {
    const message = maskError(error instanceof Error ? error.message : String(error));
    await writeOutput(output.stderr, `Worker result output failed: ${message}\n`).catch(() => undefined);
    output.exit(1);
    return;
  }
  output.exit(0);
}