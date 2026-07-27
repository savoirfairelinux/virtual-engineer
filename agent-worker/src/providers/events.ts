/**
 * Structured event emitter shared by all provider runners.
 *
 * Writes newline-delimited JSON to stderr with a `__ve_event` marker so the
 * host adapter can parse the agent's live event stream identically regardless
 * of which provider produced it.
 */

/** Emit a structured VE event on stderr. */
export function emitEvent(type: string, data: Record<string, unknown>): void {
  process.stderr.write(
    JSON.stringify({ __ve_event: true, type, data, ts: new Date().toISOString() }) + '\n',
  );
}
