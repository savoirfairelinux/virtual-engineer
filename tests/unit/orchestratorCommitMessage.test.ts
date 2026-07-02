/**
 * Unit tests for Orchestrator.buildCommitMessage() — conventional commit fallback.
 * Unit tests for Orchestrator.appendTicketFooter() — ticket reference footer.
 *
 * NOTE: As of the modular refactor, ticket footer formatting is delegated to
 * the ticketFooterFormatter utility. These tests verify orchestrator integration.
 * For comprehensive footer format tests, see ticketFooterFormatter.test.ts.
 */

import { describe, it, expect } from "vitest";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";

// buildCommitMessage is private — access via any cast
function callBuildCommitMessage(subject: string): string {
  return (Orchestrator.prototype as any).buildCommitMessage.call({}, {}, subject) as string;
}

// buildTicketFooter is private — access via any cast
function callBuildTicketFooter(
  reviewSystem: string,
  ticketId: string,
  ticketUrl: string,
  ticketSourceLabel?: string
): string | null {
  const proto = Orchestrator.prototype as any;
  const self = {
    config: { reviewSystem },
  };
  return proto.buildTicketFooter.call(self, ticketId, ticketUrl, ticketSourceLabel) as string | null;
}

// appendTicketFooter is private — access via any cast
function callAppendTicketFooter(
  reviewSystem: string,
  message: string,
  ticketId: string,
  ticketUrl: string,
  ticketSourceLabel?: string
): string {
  const proto = Orchestrator.prototype as any;
  const self = {
    config: { reviewSystem },
    buildTicketFooter: proto.buildTicketFooter,
  };
  return proto.appendTicketFooter.call(self, message, ticketId, ticketUrl, ticketSourceLabel) as string;
}

describe("Orchestrator.buildCommitMessage", () => {
  it("produces a conventional commit with feat type", () => {
    const msg = callBuildCommitMessage("Add /exit endpoint");
    expect(msg).toBe("feat: Add /exit endpoint");
  });

  it("strips trailing period from subject", () => {
    const msg = callBuildCommitMessage("Add /exit endpoint.");
    expect(msg).toBe("feat: Add /exit endpoint");
  });

  it("truncates subject to 72 chars", () => {
    const longSubject = "A".repeat(100);
    const msg = callBuildCommitMessage(longSubject);
    // "feat: " is 6 chars + 72 from subject = 78 total
    expect(msg).toBe(`feat: ${"A".repeat(72)}`);
  });

  it("does NOT contain task ID, ticket ID, or cycle number", () => {
    const msg = callBuildCommitMessage("Some task");
    expect(msg).not.toMatch(/Task:/);
    expect(msg).not.toMatch(/Ticket:/);
    expect(msg).not.toMatch(/Cycle:/);
    expect(msg).not.toMatch(/Automated by/);
  });
});

describe("Orchestrator.buildTicketFooter (modular approach)", () => {
  it("formats gitlab as 'GitLab: #14'", () => {
    const result = callBuildTicketFooter("gitlab", "14", "https://example.com/14", "gitlab:gl-1");
    expect(result).toBe("GitLab: #14");
  });

  it("formats redmine as 'Redmine: #123'", () => {
    const result = callBuildTicketFooter("gerrit", "123", "http://redmine.local/issues/123", "redmine");
    expect(result).toBe("Redmine: #123");
  });

  it("returns null for unknown system", () => {
    const result = callBuildTicketFooter("gerrit", "42", "https://example.com/42", "unknown-system");
    expect(result).toBeNull();
  });

  it("returns null when no ticketSourceLabel provided", () => {
    const result = callBuildTicketFooter("gerrit", "42", "https://example.com/42", undefined);
    expect(result).toBeNull();
  });
});

describe("Orchestrator.appendTicketFooter (integration)", () => {
  it("appends 'GitLab: #14' footer for gitlab", () => {
    const result = callAppendTicketFooter("gitlab", "feat: add feature", "14", "", "gitlab:gl-1");
    expect(result).toMatch(/\n\nGitLab: #14\n$/);
  });

  it("appends 'Redmine: #123' footer for redmine", () => {
    const result = callAppendTicketFooter(
      "gerrit",
      "feat: add feature",
      "123",
      "http://redmine.local/issues/123",
      "redmine"
    );
    expect(result).toMatch(/\n\nRedmine: #123\n$/);
  });

  it("does NOT duplicate footer if message already contains 'GitLab:'", () => {
    const msg = "feat: add feature\n\nGitLab: #14\n";
    const result = callAppendTicketFooter("gitlab", msg, "14", "", "gitlab:gl-1");
    expect(result).toBe(msg);
    const occurrences = (result.match(/GitLab:/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("does NOT duplicate footer if message already contains 'Redmine:'", () => {
    const msg = "feat: add feature\n\nRedmine: #123\n";
    const result = callAppendTicketFooter("gerrit", msg, "123", "http://redmine.local/issues/123", "redmine");
    expect(result).toBe(msg);
    const occurrences = (result.match(/Redmine:/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("skips footer when source label is unknown", () => {
    const msg = "feat: add feature";
    const result = callAppendTicketFooter("gerrit", msg, "42", "https://example.com/42", "unknown-system");
    expect(result).toBe(msg);
  });

  it("skips footer if reviewSystem is not a known type", () => {
    const msg = "feat: add exit endpoint";
    const result = callAppendTicketFooter("unknown-system", msg, "14", "https://example.com/123");
    expect(result).toBe(msg);
  });
});
