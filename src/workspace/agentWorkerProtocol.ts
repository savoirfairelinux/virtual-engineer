import { redactUrls } from "../utils/redactUrl.js";

interface WorkerOutputContext {
  code: number;
  stderr: string;
  secrets?: readonly string[] | undefined;
}

export interface WorkerOutputDiagnostics {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  redacted: boolean;
  parseError: string | null;
}

function maskOutput(text: string, secrets: readonly string[] = []): string {
  let masked = text;
  for (const secret of secrets.filter(Boolean).sort((left, right) => right.length - left.length)) {
    masked = masked.replaceAll(secret, "<redacted>");
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) masked = masked.replaceAll(escaped, "<redacted>");
  }
  return redactUrls(masked)
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*)=[^\s]+/gi, "$1=<redacted>")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "<redacted private key>");
}

function boundOutput(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  const limit = 65_536;
  if (bytes.length <= limit) return { text, truncated: false };
  const marker = "\n[... output truncated ...]\n";
  const half = Math.floor((limit - Buffer.byteLength(marker)) / 2);
  const head = new TextDecoder().decode(bytes.subarray(0, half), { stream: true });
  let tailStart = bytes.length - half;
  while (((bytes[tailStart] ?? 0) & 0xc0) === 0x80) tailStart++;
  return { text: head + marker + bytes.subarray(tailStart).toString(), truncated: true };
}

export class AgentWorkerProtocolError extends Error {
  declare readonly diagnostics: WorkerOutputDiagnostics;

  constructor(
    message: string,
    stdout = "",
    context: WorkerOutputContext = { code: 0, stderr: "" },
    parseError: string | null = null,
  ) {
    super(maskOutput(message, context.secrets).slice(0, 2_000));
    this.name = "AgentWorkerProtocolError";
    const maskedStdout = maskOutput(stdout, context.secrets);
    const maskedStderr = maskOutput(context.stderr, context.secrets);
    const boundedStdout = boundOutput(maskedStdout);
    const boundedStderr = boundOutput(maskedStderr);
    const diagnostics: WorkerOutputDiagnostics = {
      exitCode: context.code,
      stdout: boundedStdout.text,
      stderr: boundedStderr.text,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(context.stderr),
      stdoutTruncated: boundedStdout.truncated,
      stderrTruncated: boundedStderr.truncated,
      redacted: maskedStdout !== stdout || maskedStderr !== context.stderr,
      parseError: parseError === null ? null : maskOutput(parseError, context.secrets).slice(0, 500),
    };
    Object.defineProperty(this, "diagnostics", { value: diagnostics, enumerable: false });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

/** Decode the JSON envelope written by the agent worker in review mode. */
export function decodeReviewWorkerOutput(stdout: string, context?: WorkerOutputContext): string {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new AgentWorkerProtocolError("Agent worker returned empty stdout", stdout, context);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch (error: unknown) {
    throw new AgentWorkerProtocolError("Agent worker returned invalid JSON", stdout, context,
      error instanceof Error ? error.message : "JSON parse failed");
  }

  const envelope = asRecord(decoded);
  if (!envelope) {
    throw new AgentWorkerProtocolError("Agent worker response must be a JSON object", stdout, context);
  }

  if (envelope["status"] === "failed") {
    const summary = envelope["summary"];
    throw new AgentWorkerProtocolError(
      typeof summary === "string" && summary.trim()
        ? summary.trim()
        : "Agent worker reported a failed review execution",
      stdout, context,
    );
  }

  if (envelope["status"] !== "success") {
    throw new AgentWorkerProtocolError("Agent worker response has an invalid status", stdout, context);
  }

  const rawOutput = envelope["rawOutput"];
  if (typeof rawOutput !== "string") {
    throw new AgentWorkerProtocolError("Agent worker response is missing string rawOutput", stdout, context);
  }

  return rawOutput;
}