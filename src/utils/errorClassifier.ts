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
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error ?? "");
  return INFRASTRUCTURE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
