import { describe, it, expect } from "vitest";
import { redactUrls, sanitizeErrorDetail } from "../../src/utils/redactUrl.js";

describe("redactUrls", () => {
  it("masks credentials embedded in an https clone URL", () => {
    const url =
      "https://x-access-token:gho_ABCDEFGHIJKLMNOPQRST@github.com/savoirfairelinux/virtual-engineer.git";
    const out = redactUrls(url);
    expect(out).toBe("https://<redacted>@github.com/savoirfairelinux/virtual-engineer.git");
    expect(out).not.toContain("gho_");
  });

  it("leaves credential-free URLs untouched", () => {
    const url = "https://github.com/savoirfairelinux/virtual-engineer.git";
    expect(redactUrls(url)).toBe(url);
  });

  it("handles uppercase schemes without redacting at-signs in URL paths", () => {
    expect(redactUrls("HTTPS://user:secret@example.com/org/repo.git")).toBe(
      "HTTPS://<redacted>@example.com/org/repo.git"
    );
    expect(redactUrls("https://example.com/users/dev@example.com")).toBe(
      "https://example.com/users/dev@example.com"
    );
  });

  it("masks GitHub tokens outside URL userinfo", () => {
    const text =
      "fatal: unable to access 'https://github.com/org/repo.git?access_token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'";
    const out = redactUrls(text);
    expect(out).not.toContain("ghp_");
    expect(out).toContain("access_token=<redacted>");
  });

  it("redacts userinfo credentials for non-HTTP schemes and schemeless URLs", () => {
    expect(redactUrls("ssh://git:private@git.example.com:29418/group/repo.git"))
      .toBe("ssh://<redacted>@git.example.com:29418/group/repo.git");
    expect(redactUrls("git:private@git.example.com:29418/group/repo.git"))
      .toBe("<redacted>@git.example.com:29418/group/repo.git");
  });

  it("redacts sensitive query keys and response-style key/value pairs", () => {
    const text = "https://git.example.com/repo?token=one&access_token=two&keep=visible " +
      JSON.stringify({ private_token: "three", client_secret: "four" });

    const out = redactUrls(text);

    expect(out).toContain("token=<redacted>");
    expect(out).toContain("access_token=<redacted>");
    expect(out).toContain('private_token: "<redacted>"');
    expect(out).toContain('client_secret: "<redacted>"');
    expect(out).toContain("keep=visible");
    expect(out).not.toMatch(/one|two|three|four/);
  });

  it("redacts bearer and basic values in response-style errors", () => {
    const out = redactUrls('authorization: "Bearer bearer-secret" basic=Basic basic-secret');

    expect(out).toBe('authorization: "<redacted>" basic=Basic <redacted>');
  });

  it("bounds sanitized error details after redaction", () => {
    const detail = sanitizeErrorDetail(`access_token=${"secret".repeat(200)}`, 80);

    expect(detail).toBe("access_token=<redacted>");
    expect(detail.length).toBeLessThanOrEqual(80);
  });
});
