import { describe, expect, it } from "vitest";
import {
  decryptManagedCredential,
  encryptToken,
  decryptToken,
  StoredCredentialDecryptionError,
} from "../../src/utils/encryption.js";

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

  it("returns explicitly allowed legacy plaintext unchanged", () => {
    expect(decryptManagedCredential("ghp_legacy_plaintext", SECRET, "token")).toBe("ghp_legacy_plaintext");
  });

  it("wraps an undecryptable managed token with a stable safe error", () => {
    const encrypted = encryptToken("ghu_secret", SECRET);

    expect(() => decryptManagedCredential(encrypted, "wrong-secret", "sessionToken"))
      .toThrow("Stored token cannot be decrypted; reconnect OAuth.");
    expect(() => decryptManagedCredential(encrypted, "wrong-secret", "sessionToken"))
      .toThrow(StoredCredentialDecryptionError);
  });

  it("reports a missing admin secret without attempting plaintext fallback", () => {
    const encrypted = encryptToken("ghu_secret", SECRET);

    expect(() => decryptManagedCredential(encrypted, undefined, "sessionToken"))
      .toThrow("ADMIN_AUTH_SECRET is required to decrypt stored credentials.");
  });

  it("handles long tokens", () => {
    const longToken = "ghu_" + "x".repeat(1000);
    const encrypted = encryptToken(longToken, SECRET);
    expect(decryptToken(encrypted, SECRET)).toBe(longToken);
  });
});
