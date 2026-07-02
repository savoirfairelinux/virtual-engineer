import { describe, it, expect } from "vitest";
import { patchsetFromRevisionSha } from "../../src/review/revisionPatchset.js";

describe("patchsetFromRevisionSha()", () => {
  it("derives a stable positive integer from a SHA", () => {
    const a = patchsetFromRevisionSha("abc123def4567890");
    expect(Number.isSafeInteger(a)).toBe(true);
    expect(a).toBeGreaterThan(0);
    // Deterministic: same SHA -> same number.
    expect(patchsetFromRevisionSha("abc123def4567890")).toBe(a);
  });

  it("yields different numbers for different revisions so dedup re-reviews on change", () => {
    expect(patchsetFromRevisionSha("1111111111111aaaa")).not.toBe(
      patchsetFromRevisionSha("2222222222222bbbb")
    );
  });

  it("ignores case and non-hex characters", () => {
    expect(patchsetFromRevisionSha("ABCDEF0123456")).toBe(patchsetFromRevisionSha("abcdef0123456"));
  });

  it("stays within Number.MAX_SAFE_INTEGER for a full 40-char SHA", () => {
    const n = patchsetFromRevisionSha("f".repeat(40));
    expect(Number.isSafeInteger(n)).toBe(true);
  });

  it("falls back to 1 when no usable SHA is available", () => {
    expect(patchsetFromRevisionSha(null)).toBe(1);
    expect(patchsetFromRevisionSha(undefined)).toBe(1);
    expect(patchsetFromRevisionSha("")).toBe(1);
    expect(patchsetFromRevisionSha("xyz")).toBe(1);
    expect(patchsetFromRevisionSha("0000000000000")).toBe(1);
  });
});
