import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isGeneratedSshFilePath,
  resolveAgentPubKeyPath,
  resolveKeyFromPem,
} from "../../src/utils/sshKeyResolver.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("sshKeyResolver", () => {
  it("does not follow an attacker-precreated legacy temporary-key symlink", () => {
    const attackerDirectory = mkdtempSync(join(tmpdir(), "ve-ssh-attacker-"));
    const attackerTarget = join(attackerDirectory, "target");
    const legacyPath = join(tmpdir(), "ve-ssh-key-e333826bd67a6e28.pem");
    cleanupPaths.push(attackerDirectory, legacyPath);
    writeFileSync(attackerTarget, "attacker-content", { mode: 0o600 });
    rmSync(legacyPath, { force: true });
    symlinkSync(attackerTarget, legacyPath);

    const generatedPath = resolveKeyFromPem("private-key", "integration-1");

    expect(generatedPath).not.toBe(legacyPath);
    expect(readFileSync(attackerTarget, "utf8")).toBe("attacker-content");
    expect(readFileSync(generatedPath, "utf8")).toBe("private-key");
  });

  it("uses a process-private directory and registers only generated paths", () => {
    const keyPath = resolveKeyFromPem("private-key", "integration-private");
    const publicKeyPath = resolveAgentPubKeyPath("ssh-ed25519 AAAA test", "integration-private");
    const directory = dirname(keyPath);

    expect(dirname(publicKeyPath)).toBe(directory);
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(keyPath).mode & 0o777).toBe(0o600);
    expect(isGeneratedSshFilePath(keyPath)).toBe(true);
    expect(isGeneratedSshFilePath(publicKeyPath)).toBe(true);
    expect(isGeneratedSshFilePath(join(tmpdir(), "ve-ssh-key-0123456789abcdef.pem"))).toBe(false);
  });

  it("repairs generated file permissions before returning an existing path", () => {
    const keyPath = resolveKeyFromPem("private-key", "integration-mode");
    chmodSync(keyPath, 0o644);

    expect(resolveKeyFromPem("private-key", "integration-mode")).toBe(keyPath);
    expect(lstatSync(keyPath).mode & 0o777).toBe(0o600);
  });
});