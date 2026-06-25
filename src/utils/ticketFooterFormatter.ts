/**
 * Modular ticket footer formatter — supports any ticketing system.
 *
 * Maps ticket source labels to display names and format strategies.
 * Extensible: add new systems by extending the TICKET_SYSTEM_CONFIG map.
 */

import { parseProviderFromSourceLabel } from "./ticketSourceLabel.js";

/**
 * Configuration for a ticket system.
 *
 * @field displayName — How the system name appears in footers (e.g., "GitLab", "Redmine")
 * @field isTicketIdFormat — If true, uses `System: #ticketId`
 */
interface TicketSystemConfig {
  displayName: string;
  isTicketIdFormat: boolean;
}

/**
 * Ticket system configurations. Maps the provider prefix of a ticketSourceLabel
 * to a display name and format.
 *
 * Labels follow the canonical `<provider>:<integrationId>` scheme, so the
 * provider prefix is extracted before lookup.
 *
 * All systems use ID format: "System: #ticketId"
 *
 * Current systems:
 * - "gitlab" → "GitLab" display name, ID format (`GitLab: #123`)
 * - "github" → "GitHub" display name, ID format (`GitHub: #123`)
 * - "redmine" → "Redmine" display name, ID format (`Redmine: #456`)
 *
 * To add a new system, simply add a line:
 * "provider-id": { displayName: "Display Name", isTicketIdFormat: true }
 */
const TICKET_SYSTEM_CONFIG: Record<string, TicketSystemConfig> = {
  gitlab: {
    displayName: "GitLab",
    isTicketIdFormat: true,
  },
  github: {
    displayName: "GitHub",
    isTicketIdFormat: true,
  },
  redmine: {
    displayName: "Redmine",
    isTicketIdFormat: true,
  },
};

/**
 * Formats a ticket footer line based on ticket system and available data.
 *
 * Modular formatter that works with any configured ticket system.
 * Returns null if the system is not recognized or required data is missing.
 *
 * Examples:
 * - GitLab issue: "GitLab: #123"
 * - Redmine: "Redmine: http://redmine.local/issues/14"
 *
 * @param ticketId The ticket ID (e.g., "123", "PROJ-456")
 * @param ticketUrl The full ticket URL (used if system requires URL format)
 * @param ticketSourceLabel The source system label (e.g., "gitlab-issue", "redmine")
 * @returns Formatted footer line, or null if system not configured or URL missing
 */
export function formatTicketFooter(
  ticketId: string,
  ticketUrl: string,
  ticketSourceLabel?: string
): string | null {
  if (!ticketSourceLabel) return null;

  // Check if system is configured (labels are `<provider>:<integrationId>`)
  const config = TICKET_SYSTEM_CONFIG[parseProviderFromSourceLabel(ticketSourceLabel)];
  if (!config) return null;

  const systemName = config.displayName;
  const isIdFormat = config.isTicketIdFormat;

  // If system requires URL format but no URL available, skip footer
  if (!isIdFormat && !ticketUrl) {
    return null;
  }

  // ID format systems: "System: #ticketId"
  if (isIdFormat) {
    return `${systemName}: #${ticketId}`;
  }

  // URL format systems: "System: ticketUrl"
  return `${systemName}: ${ticketUrl}`;
}

/**
 * Checks if a commit message already contains a ticket footer.
 *
 * Idempotent — safe to call multiple times. Prevents duplicate footers.
 * Checks for both system-specific and generic footer keywords.
 *
 * @param message The commit message
 * @param systemLabel The ticket system label (used to check for existing footer)
 * @returns true if message already contains a footer for this system or generic footer
 */
export function hasTicketFooter(message: string, systemLabel?: string): boolean {
  // Always check for generic footer keywords (e.g., "Closes:", "Refs:")
  // These prevent duplicates across all systems
  const genericFooterPattern = /^(Closes|Refs):/m;
  if (genericFooterPattern.test(message)) return true;

  // If system label provided, check for system-specific footer
  if (systemLabel) {
    const config = TICKET_SYSTEM_CONFIG[parseProviderFromSourceLabel(systemLabel)];
    if (config) {
      const systemName = config.displayName;
      // Escape special regex chars if any, though system names are simple
      const footerPattern = new RegExp(`^${systemName}:`, "m");
      if (footerPattern.test(message)) return true;
    }
  }

  return false;
}
