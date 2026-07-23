import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSshFileSecure } from "../../src/utils/sshFilePath.js";

const fsMockState = vi.hoisted(() => ({
  failProcDescriptorLookup: false,
  realpathSync: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  fsMockState.realpathSync.mockImplementation((path) => {
    if (fsMockState.failProcDescriptorLookup && String(path).startsWith("/proc/self/fd/")) {
      throw new Error("procfs unavailable");
    }
    return actual.realpathSync(path);
  });
  return { ...actual, realpathSync: fsMockState.realpathSync };
});

const cleanupPaths: string[] = [];

afterEach(() => {
  fsMockState.failProcDescriptorLookup = false;
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("readSshFileSecure", () => {
  it("falls back to /dev/fd when procfs is unavailable", () => {
    const secretsDirectory = join(process.cwd(), "secrets", `test-${process.pid}-${Date.now()}`);
    const keyPath = join(secretsDirectory, "key");
    cleanupPaths.push(secretsDirectory);
    mkdirSync(secretsDirectory, { recursive: true });
    writeFileSync(keyPath, "approved-secret", { mode: 0o600 });
    fsMockState.failProcDescriptorLookup = true;

    expect(readSshFileSecure(keyPath, "SSH key").toString("utf8")).toBe("approved-secret");
    expect(fsMockState.realpathSync).toHaveBeenCalledWith(expect.stringMatching(/^\/dev\/fd\/\d+$/));
  });

  it("rejects an approved-root symlink that escapes the secrets directory", () => {
    const outsideDirectory = mkdtempSync(join(tmpdir(), "ve-ssh-outside-"));
    const secretsDirectory = join(process.cwd(), "secrets", `test-${process.pid}-${Date.now()}`);
    const outsideFile = join(outsideDirectory, "key");
    const symlinkPath = join(secretsDirectory, "key");
    cleanupPaths.push(outsideDirectory, secretsDirectory);
    mkdirSync(secretsDirectory, { recursive: true });
    writeFileSync(outsideFile, "outside-secret", { mode: 0o600 });
    symlinkSync(outsideFile, symlinkPath);

    expect(() => readSshFileSecure(symlinkPath, "SSH key")).toThrow(/outside|symbolic link|not allowed/i);
  });
});