/**
 * Unit tests for Orchestrator.buildCommitMessage() — conventional commit fallback.
 *
 * NOTE: Ticket footer formatting was previously tested here but has been moved
 * to ticketFooterFormatter.test.ts, which tests the utility directly.
 */

import { describe, it, expect } from "vitest";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";

// buildCommitMessage is private — access via any cast
function callBuildCommitMessage(subject: string): string {
  return (Orchestrator.prototype as any).buildCommitMessage.call({}, {}, subject) as string;
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
