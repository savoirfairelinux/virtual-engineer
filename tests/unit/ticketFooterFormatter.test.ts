/**
 * Unit tests for ticket footer formatter utilities.
 * Focused on GitLab and Redmine ticketing systems.
 */

import { describe, it, expect } from "vitest";
import {
  formatTicketFooter,
  hasTicketFooter,
} from "../../src/utils/ticketFooterFormatter.js";

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

  it("returns null when no ticketSourceLabel provided", () => {
    expect(formatTicketFooter("123", "", undefined)).toBeNull();
  });
});

describe("hasTicketFooter", () => {
  it("detects existing GitLab footer", () => {
    const msg = "feat: add feature\n\nGitLab: #123\n";
    expect(hasTicketFooter(msg, "gitlab:gl-1")).toBe(true);
  });

  it("detects existing Redmine footer", () => {
    const msg = "feat: add feature\n\nRedmine: #14\n";
    expect(hasTicketFooter(msg, "redmine:redmine-1")).toBe(true);
  });

  it("returns false when system footer not present", () => {
    const msg = "feat: add feature";
    expect(hasTicketFooter(msg, "gitlab:gl-1")).toBe(false);
    expect(hasTicketFooter(msg, "redmine:redmine-1")).toBe(false);
  });

  it("detects generic 'Closes:' keyword", () => {
    const msg = "feat: add feature\n\nCloses: #456\n";
    expect(hasTicketFooter(msg, "gitlab:gl-1")).toBe(true);
  });

  it("returns false for empty message", () => {
    expect(hasTicketFooter("", "gitlab:gl-1")).toBe(false);
  });

  it("returns false when no label provided", () => {
    const msg = "feat: add feature\n\nGitLab: #123\n";
    expect(hasTicketFooter(msg, undefined)).toBe(false);
  });
});
