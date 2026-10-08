import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { getBuildInfo, resolveBuildInfo } from "../../src/version.js";

const rootPackage = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
const workerPackage = JSON.parse(readFileSync(new URL("../../agent-worker/package.json", import.meta.url), "utf8")) as { version: string };
const manifest = JSON.parse(readFileSync(new URL("../../.release-please-manifest.json", import.meta.url), "utf8")) as Record<string, string>;

describe("resolveBuildInfo", () => {
  it("prefers injected build metadata over the git fallback", () => {
    const readGitSha = vi.fn(() => "deadbee");

    const info = resolveBuildInfo({
      env: { VE_GIT_SHA: "abc1234", VE_BUILD_DATE: "2026-10-08T12:00:00Z" },
      readPackageVersion: () => "1.2.3",
      readGitSha,
    });

    expect(info).toEqual({ version: "1.2.3", gitSha: "abc1234", buildDate: "2026-10-08T12:00:00Z" });
    expect(readGitSha).not.toHaveBeenCalled();
  });

  it("falls back to the local git checkout when no SHA is injected", () => {
    const info = resolveBuildInfo({ env: {}, readPackageVersion: () => "1.2.3", readGitSha: () => "deadbee" });

    expect(info).toEqual({ version: "1.2.3", gitSha: "deadbee", buildDate: undefined });
  });

  it("treats blank env values and git failures as unknown", () => {
    const info = resolveBuildInfo({
      env: { VE_GIT_SHA: "  ", VE_BUILD_DATE: "" },
      readPackageVersion: () => "1.2.3",
      readGitSha: () => { throw new Error("not a git repository"); },
    });

    expect(info).toEqual({ version: "1.2.3", gitSha: undefined, buildDate: undefined });
  });

  it("reports an unknown version when package metadata cannot be read", () => {
    const info = resolveBuildInfo({
      env: {},
      readPackageVersion: () => { throw new Error("missing"); },
      readGitSha: () => undefined,
    });

    expect(info.version).toBe("0.0.0-unknown");
  });
});

describe("getBuildInfo", () => {
  it("reads the version from the root package.json and memoizes the result", () => {
    const first = getBuildInfo();

    expect(first.version).toBe(rootPackage.version);
    expect(getBuildInfo()).toBe(first);
  });
});

describe("release versioning", () => {
  it("keeps the agent worker and release manifest aligned with the root package", () => {
    expect(workerPackage.version).toBe(rootPackage.version);
    expect(manifest["."]).toBe(rootPackage.version);
  });
});
