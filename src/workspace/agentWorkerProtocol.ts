export class AgentWorkerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentWorkerProtocolError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

/** Decode the JSON envelope written by the agent worker in review mode. */
export function decodeReviewWorkerOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new AgentWorkerProtocolError("Agent worker returned empty stdout");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    throw new AgentWorkerProtocolError("Agent worker returned invalid JSON");
  }

  const envelope = asRecord(decoded);
  if (!envelope) {
    throw new AgentWorkerProtocolError("Agent worker response must be a JSON object");
  }

  if (envelope["status"] === "failed") {
    const summary = envelope["summary"];
    throw new AgentWorkerProtocolError(
      typeof summary === "string" && summary.trim()
        ? summary.trim()
        : "Agent worker reported a failed review execution"
    );
  }

  if (envelope["status"] !== "success") {
    throw new AgentWorkerProtocolError("Agent worker response has an invalid status");
  }

  const rawOutput = envelope["rawOutput"];
  if (typeof rawOutput !== "string") {
    throw new AgentWorkerProtocolError("Agent worker response is missing string rawOutput");
  }

  return rawOutput;
}