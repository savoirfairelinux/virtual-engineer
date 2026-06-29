/**
 * Canonical ticket/review source-label scheme: `<provider>:<integrationId>`.
 *
 * Every event-intake path — polling, webhooks, and stream-events — tags a task
 * with the same label format so failure counts, footers, and integration
 * resolution behave identically regardless of how the task was created.
 *
 * `<provider>` is the registry provider id (`redmine` | `gitlab` | `github` |
 * `gerrit`), NOT a connector-specific alias.
 */

/** Build the canonical `<provider>:<integrationId>` source label. */
export function buildTicketSourceLabel(provider: string, integrationId: string): string {
  return `${provider}:${integrationId}`;
}

/**
 * Extract the bare provider prefix from a source label.
 *
 * Returns the whole string when no `:` separator is present (bare label).
 */
export function parseProviderFromSourceLabel(label: string): string {
  const separatorIndex = label.indexOf(":");
  return separatorIndex > 0 ? label.slice(0, separatorIndex) : label;
}

/**
 * Extract the integration id from a `<provider>:<integrationId>` source label.
 *
 * Returns `null` for bare labels (no separator) or malformed input.
 */
export function parseIntegrationIdFromSourceLabel(label: string | null | undefined): string | null {
  if (!label) {
    return null;
  }
  const separatorIndex = label.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === label.length - 1) {
    return null;
  }
  return label.slice(separatorIndex + 1);
}
