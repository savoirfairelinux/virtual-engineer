import { describe, it, expect } from "vitest";
import { redactUrls, redactDockerArgs } from "../../src/utils/redactUrl.js";

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

describe("redactDockerArgs", () => {
  it("masks the value of sensitive env-var assignments", () => {
    const args = [
      "run",
      "--rm",
      "-e",
      "HOME=/ve-home",
      "-e",
      "GITHUB_TOKEN=ghu_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
      "-e",
      "COPILOT_SDK_AUTH_TOKEN=gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
      "image",
    ];
    const out = redactDockerArgs(args);
    expect(out).toContain("GITHUB_TOKEN=<redacted>");
    expect(out).toContain("COPILOT_SDK_AUTH_TOKEN=<redacted>");
    // Non-sensitive values stay readable.
    expect(out).toContain("HOME=/ve-home");
    expect(out.join(" ")).not.toContain("ghu_");
    expect(out.join(" ")).not.toContain("gho_");
  });

  it("masks credentials embedded in URL-bearing args", () => {
    const args = [
      "git",
      "clone",
      "https://x-access-token:gho_ABCDEFGHIJKLMNOPQRST@github.com/org/repo.git",
      "/workspace",
    ];
    const out = redactDockerArgs(args);
    expect(out.join(" ")).not.toContain("gho_");
    expect(out.join(" ")).toContain("<redacted>@github.com/org/repo.git");
  });

  it("masks stray token-shaped values even without a sensitive key name", () => {
    const out = redactDockerArgs(["-e", "FOO=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"]);
    expect(out.join(" ")).not.toContain("ghp_");
    expect(out.join(" ")).toContain("<redacted>");
  });

  it("does not mask benign env-var names containing sensitive substrings", () => {
    const args = ["AUTHOR_NAME=alice", "TOKENIZER_MODE=strict", "PATH=/usr/bin"];
    expect(redactDockerArgs(args)).toEqual(args);
  });

  it("masks sensitive assignments in long Docker env syntax", () => {
    expect(redactDockerArgs(["--env=GITHUB_TOKEN=opaque-value"])).toEqual([
      "--env=GITHUB_TOKEN=<redacted>",
    ]);
  });
});
