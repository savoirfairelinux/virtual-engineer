/**
 * Unit tests for ticket footer formatter utilities.
 * Focused on GitLab and Redmine ticketing systems.
 */

import { describe, it, expect } from "vitest";
import { formatTicketFooter } from "../../src/utils/ticketFooterFormatter.js";

describe("formatTicketFooter", () => {
  it("formats gitlab footer as 'GitLab: #123'", () => {
    const result = formatTicketFooter("123", "", "gitlab:gl-1");
    expect(result).toBe("GitLab: #123");
  });

  it("formats github footer as 'GitHub: #99'", () => {
    const result = formatTicketFooter("99", "", "github:gh-1");
    expect(result).toBe("GitHub: #99");
  });

  it("formats redmine footer as 'Redmine: #14'", () => {
    const result = formatTicketFooter("14", "", "redmine:redmine-1");
    expect(result).toBe("Redmine: #14");
  });

  it("accepts a bare provider label without an integration suffix", () => {
    expect(formatTicketFooter("14", "", "redmine")).toBe("Redmine: #14");
  });

  it("ignores URL parameter for both systems", () => {
    expect(formatTicketFooter("123", "http://ignored-url.com", "gitlab:gl-1")).toBe("GitLab: #123");
    expect(formatTicketFooter("456", "http://ignored-url.com", "redmine:redmine-1")).toBe("Redmine: #456");
  });

  it("returns null for unknown system", () => {
    expect(formatTicketFooter("123", "", "unknown-system")).toBeNull();
  });

  it("uses URL format when forceUrlFormat is true, even for ID-format systems", () => {
    expect(formatTicketFooter("123", "https://gitlab.example.com/issues/123", "gitlab:gl-1", true)).toBe(
      "GitLab: https://gitlab.example.com/issues/123"
    );
    expect(formatTicketFooter("14", "http://redmine.local/issues/14", "redmine:redmine-1", true)).toBe(
      "Redmine: http://redmine.local/issues/14"
    );
  });

  it("with forceUrlFormat true, returns null when no URL is available", () => {
    expect(formatTicketFooter("123", "", "gitlab:gl-1", true)).toBeNull();
  });

  it("returns null when no ticketSourceLabel provided", () => {
    expect(formatTicketFooter("123", "", undefined)).toBeNull();
  });
});
