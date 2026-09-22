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
 * - Redmine issue: "Redmine: #14"
 * - Redmine issue with forceUrlFormat: "Redmine: http://redmine.local/issues/14"
 *
 * @param ticketId The ticket ID (e.g., "123", "PROJ-456")
 * @param ticketUrl The full ticket URL used when URL formatting is requested
 * @param ticketSourceLabel The canonical `<provider>:<integrationId>` source label
 *   (e.g., "gitlab:gl-1", "redmine:rm-1")
 * @param forceUrlFormat When true, always uses the "System: ticketUrl" format regardless
 *   of the system's default (used for the per-project "full ticket URL in commits" toggle).
 * @returns Formatted footer line, or null if the provider is unsupported or a required URL is missing
 */
export function formatTicketFooter(
  ticketId: string,
  ticketUrl: string,
  ticketSourceLabel?: string,
  forceUrlFormat = false
): string | null {
  if (!ticketSourceLabel) return null;

  // Check if system is configured (labels are `<provider>:<integrationId>`)
  const config = TICKET_SYSTEM_CONFIG[parseProviderFromSourceLabel(ticketSourceLabel)];
  if (!config) return null;

  const systemName = config.displayName;
  const isIdFormat = config.isTicketIdFormat && !forceUrlFormat;

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
