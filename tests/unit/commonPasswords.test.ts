import { describe, expect, it } from "vitest";
import { isCommonPassword } from "../../src/admin/commonPasswords.js";

describe("isCommonPassword", () => {
  it("flags well-known weak passwords (case-insensitive, trimmed)", () => {
    expect(isCommonPassword("password123")).toBe(true);
    expect(isCommonPassword("PASSWORD123")).toBe(true);
    expect(isCommonPassword("  qwerty  ")).toBe(true);
    expect(isCommonPassword("letmein")).toBe(true);
  });

  it("allows strong, non-listed passwords", () => {
    expect(isCommonPassword("Str0ng-Pass-1x")).toBe(false);
    expect(isCommonPassword("correct horse battery staple")).toBe(false);
    expect(isCommonPassword("9f3!kQ2#zLm")).toBe(false);
  });
});
