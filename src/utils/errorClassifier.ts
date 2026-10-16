/**
 * Classify orchestrator errors so that infrastructure / connectivity / config
 * failures are not echoed back to the external ticket.
 *
 * When Virtual Engineer cannot reach a backing system (e.g. the Gerrit SSH
 * connection cannot be established), the failure is an operator-facing
 * configuration problem — already surfaced in the admin UI — not a task
 * outcome the ticket stakeholders need. Posting it as a ticket note duplicates
 * the admin view and adds noise to the ticket-following process.
 */

/**
 * Patterns that identify connectivity / authentication / configuration errors
 * (DNS, network, SSH, host-key, credentials) rather than genuine task failures.
 * Kept deliberately narrow so real task failures (merge conflicts, agent
 * errors, etc.) are still reported on the ticket.
 */
const INFRASTRUCTURE_ERROR_PATTERNS: readonly RegExp[] = [
  // Node socket / DNS error codes.
  /\bECONNREFUSED\b/i,
  /\bECONNRESET\b/i,
  /\bENOTFOUND\b/i,
  /\bEHOSTUNREACH\b/i,
  /\bENETUNREACH\b/i,
  /\bETIMEDOUT\b/i,
  /\bEAI_AGAIN\b/i,
  /getaddrinfo\b/i,
  // SSH / Gerrit connection establishment & auth/config failures.
  /could not resolve hostname/i,
  /connection (refused|timed out|closed|reset)/i,
  /permission denied \(publickey/i,
  /host key verification failed/i,
  /\bssh: connect to host\b/i,
  /\bspawn ssh ENOENT\b/i,
  /timed out after \d+\s*ms:\s*ssh\b/i,
];

/**
 * Returns true when the error looks like an infrastructure / connectivity /
 * configuration failure that should NOT be posted to the external ticket.
 */
export function isInfrastructureError(error: unknown): boolean {
  const message = errorMessage(error);
  return INFRASTRUCTURE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

interface ContextOverflowPattern {
  pattern: RegExp;
  /** Capture groups holding the prompt size and the model limit, when the message reports them. */
  counts?: { prompt: number; limit: number } | undefined;
}

/** Model-provider rejections of a prompt larger than the model context window. */
const CONTEXT_OVERFLOW_PATTERNS: readonly ContextOverflowPattern[] = [
  // GitHub Copilot API
  { pattern: /prompt token count of (\d+) exceeds the limit of (\d+)/i, counts: { prompt: 1, limit: 2 } },
  // Anthropic
  { pattern: /prompt is too long:\s*(\d+) tokens\s*>\s*(\d+) maximum/i, counts: { prompt: 1, limit: 2 } },
  // OpenAI
  {
    pattern: /maximum context length is (\d+) tokens[\s\S]*?(?:resulted in|requested) (\d+) tokens/i,
    counts: { prompt: 2, limit: 1 },
  },
  // Gemini
  {
    pattern: /input token count \(?(\d+)\)? exceeds the maximum number of tokens allowed \(?(\d+)\)?/i,
    counts: { prompt: 1, limit: 2 },
  },
  { pattern: /\bcontext_length_exceeded\b/i },
];

/**
 * Readable, non-retryable failure reason when a model rejected the prompt for
 * exceeding its context window; null for any other error.
 */
export function describeContextOverflow(error: unknown): string | null {
  const message = errorMessage(error);
  for (const { pattern, counts } of CONTEXT_OVERFLOW_PATTERNS) {
    const match = pattern.exec(message);
    if (match === null) continue;
    const promptTokens = counts === undefined ? undefined : match[counts.prompt];
    const limitTokens = counts === undefined ? undefined : match[counts.limit];
    const size = promptTokens !== undefined && limitTokens !== undefined
      ? ` (${formatTokenCount(promptTokens)} > ${formatTokenCount(limitTokens)} tokens)`
      : "";
    return `Prompt exceeds the model context window${size}. The input is too large for this model; retrying will not help.`;
  }
  return null;
}

function formatTokenCount(digits: string): string {
  return Number(digits).toLocaleString("en-US");
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : error === undefined || error === null
        ? ""
        : safeStringify(error);
}

/** Best-effort `JSON.stringify`; falls back to `String()` for circular/BigInt values that would throw. */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
