import { describe, expect, it } from "vitest";
import { encryptToken, decryptToken } from "../../src/utils/encryption.js";

const SECRET = "test-admin-auth-secret-for-unit-tests";

describe("encryption", () => {
  it("round-trips a token through encrypt/decrypt", () => {
    const token = "ghu_abc123_session_token";
    const encrypted = encryptToken(token, SECRET);
    const decrypted = decryptToken(encrypted, SECRET);

    expect(decrypted).toBe(token);
  });

  it("produces different ciphertext for the same input (unique IV)", () => {
    const token = "ghu_same_token";
    const a = encryptToken(token, SECRET);
    const b = encryptToken(token, SECRET);

    expect(a).not.toBe(b);
    expect(decryptToken(a, SECRET)).toBe(token);
    expect(decryptToken(b, SECRET)).toBe(token);
  });

  it("fails to decrypt with a wrong secret", () => {
    const encrypted = encryptToken("ghu_secret", SECRET);

    expect(() => decryptToken(encrypted, "wrong-secret")).toThrow();
  });

  it("encryptToken without a secret stores token with plain: prefix", () => {
    const encrypted = encryptToken("my-token", "");
    expect(encrypted).toMatch(/^plain:/);
    const encrypted2 = encryptToken("my-token", undefined);
    expect(encrypted2).toMatch(/^plain:/);
  });

  it("decryptToken round-trips a plain: token without a secret", () => {
    const encrypted = encryptToken("ghu_plain_token", undefined);
    expect(decryptToken(encrypted, undefined)).toBe("ghu_plain_token");
    expect(decryptToken(encrypted, "")).toBe("ghu_plain_token");
  });

  it("decryptToken throws when given an AES token but no secret", () => {
    const encrypted = encryptToken("ghu_secret", SECRET);
    expect(() => decryptToken(encrypted, undefined)).toThrow("ADMIN_AUTH_SECRET");
    expect(() => decryptToken(encrypted, "")).toThrow("ADMIN_AUTH_SECRET");
  });

  it("throws on invalid encrypted data (too short)", () => {
    expect(() => decryptToken("dG9v", SECRET)).toThrow("too short");
  });

  it("handles long tokens", () => {
    const longToken = "ghu_" + "x".repeat(1000);
    const encrypted = encryptToken(longToken, SECRET);
    expect(decryptToken(encrypted, SECRET)).toBe(longToken);
  });
});
