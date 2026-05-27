import { describe, it, expect } from "vitest";
import { slugifyTicketSubject, buildBranchSlug } from "../../src/utils/branchSlug.js";

describe("slugifyTicketSubject", () => {
  it("returns empty string for null/undefined/empty input", () => {
    expect(slugifyTicketSubject(null)).toBe("");
    expect(slugifyTicketSubject(undefined)).toBe("");
    expect(slugifyTicketSubject("")).toBe("");
    expect(slugifyTicketSubject("   ")).toBe("");
  });

  it("returns empty string when subject contains no alphanumerics", () => {
    expect(slugifyTicketSubject("???")).toBe("");
    expect(slugifyTicketSubject("***---")).toBe("");
  });

  it("lower-cases and joins up to 5 key words with dashes", () => {
    expect(slugifyTicketSubject("Fix Login Redirect Bug On Safari Mobile")).toBe(
      "fix-login-redirect-bug-on"
    );
  });

  it("strips diacritics and non-ASCII punctuation", () => {
    expect(slugifyTicketSubject("Améliorer l'éditeur de tickets!")).toBe(
      "ameliorer-l-editeur-de-tickets"
    );
  });

  it("collapses runs of separators into a single dash", () => {
    expect(slugifyTicketSubject("  fix   the   bug  ")).toBe("fix-the-bug");
  });

  it("honours a custom maxWords limit", () => {
    expect(slugifyTicketSubject("one two three four five six", { maxWords: 3 })).toBe(
      "one-two-three"
    );
  });

  it("clips the slug at the configured max length and trims trailing dashes", () => {
    const subject = "abcdefghij ".repeat(10).trim();
    const slug = slugifyTicketSubject(subject, { maxWords: 10, maxLength: 25 });
    expect(slug.length).toBeLessThanOrEqual(25);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("strips numbers-only prefixes consistently (treats digits as word chars)", () => {
    expect(slugifyTicketSubject("22404: Rename feature branch")).toBe(
      "22404-rename-feature-branch"
    );
  });
});

describe("buildBranchSlug", () => {
  it("uses the ticket subject when a usable one is provided", () => {
    expect(buildBranchSlug("task-uuid", "Fix bug X")).toBe("fix-bug-x");
  });

  it("falls back to the task ID when no subject is provided", () => {
    expect(buildBranchSlug("task-uuid")).toBe("task-uuid");
    expect(buildBranchSlug("task-uuid", null)).toBe("task-uuid");
  });

  it("falls back to the task ID when the subject yields an empty slug", () => {
    expect(buildBranchSlug("task-uuid", "***")).toBe("task-uuid");
    expect(buildBranchSlug("task-uuid", "   ")).toBe("task-uuid");
  });

  it("is deterministic for the same input (stable across retries)", () => {
    const a = buildBranchSlug("task-uuid", "Improve dashboard performance");
    const b = buildBranchSlug("task-uuid", "Improve dashboard performance");
    expect(a).toBe(b);
  });
});
