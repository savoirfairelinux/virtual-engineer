import { describe, expect, it } from "vitest";
import { getPasswordStrength } from "../../src/admin/commonPasswords.js";

describe("getPasswordStrength", () => {
  it("returns weak for passwords shorter than 8 characters", () => {
    expect(getPasswordStrength("abc")).toBe("weak");
    expect(getPasswordStrength("abc12")).toBe("weak");
  });

  it("returns weak for single-class passwords (all lower-case)", () => {
    expect(getPasswordStrength("abcdefgh")).toBe("weak");
    expect(getPasswordStrength("alllowercase")).toBe("weak");
  });

  it("returns fair for two-class passwords under 16 chars", () => {
    expect(getPasswordStrength("abcdef12")).toBe("fair");
    expect(getPasswordStrength("admin123")).toBe("fair");
  });

  it("returns strong for three-class passwords", () => {
    expect(getPasswordStrength("Admin1234")).toBe("strong");
    expect(getPasswordStrength("abcDEF123")).toBe("strong");
  });

  it("returns strong for long two-class passwords (≥ 16 chars)", () => {
    expect(getPasswordStrength("abcdefghijklmnop1")).toBe("strong");
  });

  it("returns very-strong for four-class passwords", () => {
    expect(getPasswordStrength("Str0ng-Pass!")).toBe("very-strong");
    expect(getPasswordStrength("9f3!kQ2#zLm")).toBe("very-strong");
  });
});
