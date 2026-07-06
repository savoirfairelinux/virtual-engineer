import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  return { execFile };
});

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: (fn: unknown) => fn,
}));

import { execFile } from "node:child_process";
import { readFileSync, type PathOrFileDescriptor } from "node:fs";
import {
  createVolume,
  removeVolume,
  execInVolume,
} from "../../src/workspace/dockerVolume.js";

const mockExecFile = vi.mocked(execFile);
const mockReadFileSync = vi.mocked(readFileSync);

// Helper: make mockExecFile resolve with stdout/stderr
function mockExecFileSuccess(stdout = "", stderr = ""): void {
  mockExecFile.mockResolvedValue({ stdout, stderr } as never);
}

// Helper: make mockExecFile reject with an exec error (non-zero exit)
function mockExecFileFailure(code: number, stdout = "", stderr = ""): void {
  const err = Object.assign(new Error(`exit code ${code}`), { stdout, stderr, code });
  mockExecFile.mockRejectedValue(err as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── createVolume ─────────────────────────────────────────────────────────────

describe("createVolume", () => {
  it("runs docker volume create with the given name", async () => {
    mockExecFileSuccess();
    await createVolume("ve-ws-test-1234");

    expect(mockExecFile).toHaveBeenCalledWith(
      "docker",
      ["volume", "create", "ve-ws-test-1234"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });
});

// ─── removeVolume ─────────────────────────────────────────────────────────────

describe("removeVolume", () => {
  it("runs docker volume rm -f", async () => {
    mockExecFileSuccess();
    await removeVolume("ve-ws-old");

    expect(mockExecFile).toHaveBeenCalledWith(
      "docker",
      ["volume", "rm", "-f", "ve-ws-old"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("swallows 'no such volume' errors", async () => {
    mockExecFile.mockRejectedValue(new Error("no such volume: ve-ws-old") as never);
    await expect(removeVolume("ve-ws-old")).resolves.toBeUndefined();
  });

  it("swallows 'No such volume' errors (uppercase)", async () => {
    mockExecFile.mockRejectedValue(new Error("No such volume: ve-ws-old") as never);
    await expect(removeVolume("ve-ws-old")).resolves.toBeUndefined();
  });

  it("rethrows other errors", async () => {
    mockExecFile.mockRejectedValue(new Error("permission denied") as never);
    await expect(removeVolume("ve-ws-old")).rejects.toThrow("permission denied");
  });
});

// ─── execInVolume — basic (no SSH key) ────────────────────────────────────────

describe("execInVolume", () => {
  const baseOpts = {
    volumeName: "ve-ws-abc",
    image: "virtual-engineer-workspace:latest",
    command: ["git", "clone", "ssh://example.com/repo", "/workspace"],
  };

  describe("basic docker args (no sshKeyPath)", () => {
    let savedSshAuthSock: string | undefined;
    beforeEach(() => {
      // Unset SSH_AUTH_SOCK so these tests verify behaviour without an agent socket.
      savedSshAuthSock = process.env["SSH_AUTH_SOCK"];
      delete process.env["SSH_AUTH_SOCK"];
    });
    afterEach(() => {
      if (savedSshAuthSock !== undefined) {
        process.env["SSH_AUTH_SOCK"] = savedSshAuthSock;
      }
    });

    it("mounts volume and runs the command directly", async () => {
      mockExecFileSuccess("ok\n");

      const result = await execInVolume(baseOpts);

      expect(result).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });

      const args = mockExecFile.mock.calls[0]![1] as string[];
      expect(args).toEqual([
        "run", "--rm",
        "-v", "ve-ws-abc:/workspace",
        "virtual-engineer-workspace:latest",
        "git", "clone", "ssh://example.com/repo", "/workspace",
      ]);
    });

    it("mounts volume read-only when readOnly is set", async () => {
      mockExecFileSuccess();

      await execInVolume({ ...baseOpts, readOnly: true });

      const args = mockExecFile.mock.calls[0]![1] as string[];
      expect(args).toContain("ve-ws-abc:/workspace:ro");
    });

    it("includes --user when user is set", async () => {
      mockExecFileSuccess();

      await execInVolume({ ...baseOpts, user: "1000:1000" });

      const args = mockExecFile.mock.calls[0]![1] as string[];
      const userIdx = args.indexOf("--user");
      expect(userIdx).toBeGreaterThan(-1);
      expect(args[userIdx + 1]).toBe("1000:1000");
    });

    it("passes env vars as -e flags", async () => {
      mockExecFileSuccess();

      await execInVolume({
        ...baseOpts,
        env: { FOO: "bar", BAZ: "qux" },
      });

      const args = mockExecFile.mock.calls[0]![1] as string[];
      expect(args).toContain("FOO=bar");
      expect(args).toContain("BAZ=qux");
    });

    it("attaches --network when networkMode is set", async () => {
      mockExecFileSuccess();

      await execInVolume({ ...baseOpts, networkMode: "ve-agent-net" });

      const args = mockExecFile.mock.calls[0]![1] as string[];
      const netIdx = args.indexOf("--network");
      expect(netIdx).toBeGreaterThan(-1);
      expect(args[netIdx + 1]).toBe("ve-agent-net");
    });

    it("adds additional mounts", async () => {
      mockExecFileSuccess();

      await execInVolume({
        ...baseOpts,
        additionalMounts: ["/host/path:/container/path:ro"],
      });

      const args = mockExecFile.mock.calls[0]![1] as string[];
      expect(args).toContain("/host/path:/container/path:ro");
    });

    it("uses default timeout of 600s", async () => {
      mockExecFileSuccess();

      await execInVolume(baseOpts);

      const opts = mockExecFile.mock.calls[0]![2] as { timeout: number };
      expect(opts.timeout).toBe(600_000);
    });

    it("uses custom timeout", async () => {
      mockExecFileSuccess();

      await execInVolume({ ...baseOpts, timeout: 30_000 });

      const opts = mockExecFile.mock.calls[0]![2] as { timeout: number };
      expect(opts.timeout).toBe(30_000);
    });
  });

  // ─── execInVolume — with SSH key ──────────────────────────────────────────

  describe("with sshKeyPath", () => {
    const sshOpts = {
      ...baseOpts,
      sshKeyPath: "/app/secrets/gerrit_id_ed25519",
    };

    beforeEach(() => {
      mockReadFileSync.mockReturnValue(Buffer.from("FAKE-SSH-KEY-CONTENT"));
      mockExecFileSuccess();
    });

    it("reads the SSH key file from disk", async () => {
      await execInVolume(sshOpts);

      expect(mockReadFileSync).toHaveBeenCalledWith("/app/secrets/gerrit_id_ed25519");
    });

    it("injects VE_SSH_KEY_B64 env var with base64-encoded key content", async () => {
      await execInVolume(sshOpts);

      const args = mockExecFile.mock.calls[0]![1] as string[];
      const expectedB64 = Buffer.from("FAKE-SSH-KEY-CONTENT").toString("base64");
      expect(args).toContain(`VE_SSH_KEY_B64=${expectedB64}`);
    });

    it("injects GIT_SSH_COMMAND without port by default", async () => {
      await execInVolume(sshOpts);

      const args = mockExecFile.mock.calls[0]![1] as string[];
      const gitSshIdx = args.findIndex(a => a.startsWith("GIT_SSH_COMMAND="));
      expect(gitSshIdx).toBeGreaterThan(-1);
      expect(args[gitSshIdx]).toBe(
        "GIT_SSH_COMMAND=ssh -i /tmp/ssh-key -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
      );
    });

    it("includes -p <port> in GIT_SSH_COMMAND when sshPort is set", async () => {
      await execInVolume({ ...sshOpts, sshPort: 29418 });

      const args = mockExecFile.mock.calls[0]![1] as string[];
      const gitSshIdx = args.findIndex(a => a.startsWith("GIT_SSH_COMMAND="));
      expect(gitSshIdx).toBeGreaterThan(-1);
      expect(args[gitSshIdx]).toBe(
        "GIT_SSH_COMMAND=ssh -i /tmp/ssh-key -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 29418"
      );
    });

    it("wraps command in shell preamble that decodes, chmods, and unsets the key", async () => {
      await execInVolume(sshOpts);

      const args = mockExecFile.mock.calls[0]![1] as string[];
      // The last arg should be the shell preamble string
      const preamble = args[args.length - 1]!;

      expect(preamble).toContain('echo "$VE_SSH_KEY_B64" | base64 -d > /tmp/ssh-key');
      expect(preamble).toContain("chmod 600 /tmp/ssh-key");
      expect(preamble).toContain("unset VE_SSH_KEY_B64");
      // Command should be escaped and exec'd
      expect(preamble).toContain("exec 'git' 'clone' 'ssh://example.com/repo' '/workspace'");
    });

    it("uses sh -c to run the preamble", async () => {
      await execInVolume(sshOpts);

      const args = mockExecFile.mock.calls[0]![1] as string[];
      // Find image arg, then "sh", "-c"
      const imageIdx = args.indexOf(sshOpts.image);
      expect(args[imageIdx + 1]).toBe("sh");
      expect(args[imageIdx + 2]).toBe("-c");
    });

    it("escapes single quotes in command arguments", async () => {
      await execInVolume({
        ...sshOpts,
        command: ["echo", "it's a test"],
      });

      const args = mockExecFile.mock.calls[0]![1] as string[];
      const preamble = args[args.length - 1]!;
      // Single quotes should be escaped
      expect(preamble).toContain("'it'\\''s a test'");
    });

    it("throws descriptive error when SSH key file is unreadable", async () => {
      const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      mockReadFileSync.mockImplementation(() => { throw enoent; });

      await expect(execInVolume(sshOpts)).rejects.toThrow(
        /SSH key file not found or unreadable.*gerrit_id_ed25519/
      );
    });
  });

  // ─── execInVolume — with sshKnownHostsPath ───────────────────────────────

  describe("with sshKnownHostsPath (strict host key checking)", () => {
    const knownHostsOpts = {
      ...baseOpts,
      sshKeyPath: "/app/secrets/gerrit_id_ed25519",
      sshKnownHostsPath: "/app/secrets/known_hosts",
    };

    beforeEach(() => {
      mockReadFileSync.mockImplementation((p: PathOrFileDescriptor) => {
        if (String(p).includes("known_hosts")) return Buffer.from("example.com ssh-rsa AAAA...");
        return Buffer.from("FAKE-SSH-KEY-CONTENT");
      });
      mockExecFileSuccess();
    });

    it("reads the known_hosts file from disk", async () => {
      await execInVolume(knownHostsOpts);

      expect(mockReadFileSync).toHaveBeenCalledWith("/app/secrets/known_hosts");
    });

    it("injects VE_SSH_KNOWN_HOSTS_B64 env var with base64-encoded content", async () => {
      await execInVolume(knownHostsOpts);

      const args = mockExecFile.mock.calls[0]![1] as string[];
      const expectedB64 = Buffer.from("example.com ssh-rsa AAAA...").toString("base64");
      expect(args).toContain(`VE_SSH_KNOWN_HOSTS_B64=${expectedB64}`);
    });

    it("uses StrictHostKeyChecking=yes and UserKnownHostsFile=/tmp/ssh-known-hosts in GIT_SSH_COMMAND", async () => {
      await execInVolume(knownHostsOpts);

      const args = mockExecFile.mock.calls[0]![1] as string[];
      const gitSshIdx = args.findIndex(a => a.startsWith("GIT_SSH_COMMAND="));
      expect(gitSshIdx).toBeGreaterThan(-1);
      expect(args[gitSshIdx]).toBe(
        "GIT_SSH_COMMAND=ssh -i /tmp/ssh-key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/tmp/ssh-known-hosts"
      );
    });

    it("includes port in GIT_SSH_COMMAND when both sshPort and sshKnownHostsPath are set", async () => {
      await execInVolume({ ...knownHostsOpts, sshPort: 29418 });

      const args = mockExecFile.mock.calls[0]![1] as string[];
      const gitSshIdx = args.findIndex(a => a.startsWith("GIT_SSH_COMMAND="));
      expect(args[gitSshIdx]).toBe(
        "GIT_SSH_COMMAND=ssh -i /tmp/ssh-key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/tmp/ssh-known-hosts -p 29418"
      );
    });

    it("decodes known_hosts in shell preamble with chmod 644", async () => {
      await execInVolume(knownHostsOpts);

      const args = mockExecFile.mock.calls[0]![1] as string[];
      const preamble = args[args.length - 1]!;

      expect(preamble).toContain('echo "$VE_SSH_KNOWN_HOSTS_B64" | base64 -d > /tmp/ssh-known-hosts');
      expect(preamble).toContain("chmod 644 /tmp/ssh-known-hosts");
      expect(preamble).toContain("unset VE_SSH_KNOWN_HOSTS_B64");
    });

    it("throws descriptive error when known_hosts file is unreadable", async () => {
      const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      mockReadFileSync.mockImplementation((p: PathOrFileDescriptor) => {
        if (String(p).includes("known_hosts")) throw enoent;
        return Buffer.from("FAKE-SSH-KEY-CONTENT");
      });

      await expect(execInVolume(knownHostsOpts)).rejects.toThrow(
        /SSH known_hosts file not found or unreadable.*known_hosts/
      );
    });

    it("falls back to StrictHostKeyChecking=no when sshKnownHostsPath is not set", async () => {
      mockReadFileSync.mockReturnValue(Buffer.from("FAKE-SSH-KEY-CONTENT"));
      await execInVolume({
        ...baseOpts,
        sshKeyPath: "/app/secrets/gerrit_id_ed25519",
      });

      const args = mockExecFile.mock.calls[0]![1] as string[];
      const gitSshIdx = args.findIndex(a => a.startsWith("GIT_SSH_COMMAND="));
      expect(args[gitSshIdx]).toBe(
        "GIT_SSH_COMMAND=ssh -i /tmp/ssh-key -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
      );
    });
  });

  // ─── execInVolume — error handling ────────────────────────────────────────

  describe("error handling", () => {
    it("returns exitCode from exec failure", async () => {
      mockExecFileFailure(128, "", "fatal: repo not found");

      const result = await execInVolume(baseOpts);

      expect(result.exitCode).toBe(128);
      expect(result.stderr).toBe("fatal: repo not found");
    });

    it("returns exitCode 1 for generic errors", async () => {
      mockExecFile.mockRejectedValue(new Error("something went wrong") as never);

      const result = await execInVolume(baseOpts);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("something went wrong");
    });
  });
});
