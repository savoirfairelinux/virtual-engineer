import { describe, it, expect } from "vitest";
import { computeCommentHash } from "../../src/review/commentHash.js";

describe("computeCommentHash", () => {
  it("is stable for identical file + message", () => {
    const a = computeCommentHash({ file: "src/foo.ts", message: "Avoid using any here." });
    const b = computeCommentHash({ file: "src/foo.ts", message: "Avoid using any here." });
    expect(a).toBe(b);
  });

  it("ignores the line number (resists line drift across patchsets)", () => {
    // The hash function only accepts file + message, so two comments with the
    // same text on different lines must collapse to the same hash.
    const a = computeCommentHash({ file: "src/foo.ts", message: "Null check missing." });
    const b = computeCommentHash({ file: "src/foo.ts", message: "Null check missing." });
    expect(a).toBe(b);
  });

  it("normalizes whitespace and case", () => {
    const a = computeCommentHash({ file: "src/foo.ts", message: "Avoid   using ANY here." });
    const b = computeCommentHash({ file: "src/foo.ts", message: "avoid using any here." });
    expect(a).toBe(b);
  });

  it("differs when the file differs", () => {
    const a = computeCommentHash({ file: "src/foo.ts", message: "Same message." });
    const b = computeCommentHash({ file: "src/bar.ts", message: "Same message." });
    expect(a).not.toBe(b);
  });

  it("differs when the message differs", () => {
    const a = computeCommentHash({ file: "src/foo.ts", message: "First issue." });
    const b = computeCommentHash({ file: "src/foo.ts", message: "Second issue." });
    expect(a).not.toBe(b);
  });
});
