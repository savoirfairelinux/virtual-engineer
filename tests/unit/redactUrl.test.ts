import { describe, it, expect } from "vitest";
import { redactUrls } from "../../src/utils/redactUrl.js";

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
});
