import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSshFileSecure } from "../../src/utils/sshFilePath.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("readSshFileSecure", () => {
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