import { describe, expect, it } from "vitest";
import { encryptToken, decryptToken, isEncryptedToken } from "../../src/utils/encryption.js";

const SECRET = "test-admin-auth-secret-for-unit-tests";

describe("encryption", () => {
  it("round-trips a token through encrypt/decrypt", () => {
    const token = "ghu_abc123_session_token";
    const encrypted = encryptToken(token, SECRET);
    const decrypted = decryptToken(encrypted, SECRET);

    expect(encrypted).toMatch(/^veenc:v1:/);
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

  it("decrypts backward-compatible unprefixed AES ciphertext", () => {
    const encrypted = encryptToken("ghu_legacy_secret", SECRET);
    const legacyCiphertext = encrypted.replace(/^veenc:v1:/, "");

    expect(decryptToken(legacyCiphertext, SECRET)).toBe("ghu_legacy_secret");
  });

  it("encryptToken rejects writes without an admin secret", () => {
    expect(() => encryptToken("my-token", "")).toThrow("ADMIN_AUTH_SECRET");
    expect(() => encryptToken("my-token", undefined)).toThrow("ADMIN_AUTH_SECRET");
  });

  it("decryptToken reads a legacy plain: token without a secret", () => {
    const encrypted = `plain:${Buffer.from("ghu_plain_token", "utf8").toString("base64")}`;
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

describe("isEncryptedToken", () => {
  it("returns true for a marked AES-encrypted value without decrypting it", () => {
    const encrypted = encryptToken("ghp_test", SECRET);
    expect(isEncryptedToken(encrypted, SECRET)).toBe(true);
    expect(isEncryptedToken(encrypted, "wrong-secret")).toBe(true);
    expect(isEncryptedToken(encrypted, undefined)).toBe(true);
  });

  it("returns true only for decryptable unprefixed AES ciphertext", () => {
    const encrypted = encryptToken("ghp_test", SECRET).replace(/^veenc:v1:/, "");

    expect(isEncryptedToken(encrypted, SECRET)).toBe(true);
    expect(isEncryptedToken(encrypted, "wrong-secret")).toBe(false);
    expect(isEncryptedToken(encrypted, undefined)).toBe(false);
  });

  it("returns true for a plain:-prefixed value (no-secret path)", () => {
    const plain = `plain:${Buffer.from("ghp_test", "utf8").toString("base64")}`;
    expect(plain.startsWith("plain:")).toBe(true);
    expect(isEncryptedToken(plain, SECRET)).toBe(true);
    expect(isEncryptedToken(plain, undefined)).toBe(true);
  });

  it("returns false for a raw PAT (not encrypted)", () => {
    expect(isEncryptedToken("ghp_rawtoken123", SECRET)).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isEncryptedToken("", SECRET)).toBe(false);
  });
});
