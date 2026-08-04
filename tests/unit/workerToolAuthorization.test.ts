/**
 * Tests for per-agent tool authorization: the `AgentRunOptions` tool-list
 * fields and the `createToolAuthorizingPermissionHandler` Copilot wrapper.
 *
 * Covers:
 * - `AgentRunOptions.blockedTools` / `toolAuthorization` fields are present
 *   and typed (compile-time + runtime shape).
 * - `parseToolList()` splits a newline-separated env var into a trimmed,
 *   de-duplicated, empty-dropped string array.
 * - `createToolAuthorizingPermissionHandler`:
 *   - denies a tool in `blockedTools` and emits `permission.denied`.
 *   - delegates to the inner handler for non-blocked tools and emits
 *     `permission.approved` when the inner handler approves.
 *   - never lets a user list relax VE's network floor (a blocked network tool
 *     stays blocked even when the user never lists it).
 *   - emits `permission.denied` when the inner handler rejects.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createReviewPermissionHandler,
  createToolAuthorizingPermissionHandler,
  parseToolList,
  restrictNetworkPermissionHandler,
} from "../../agent-worker/src/networkGuard.js";
import type {
  AgentRunOptions,
  AgentProviderDefinition,
} from "../../agent-worker/src/providers/types.js";

const invocation = { sessionId: "test-session" };

/** Capture every `__ve_event` written to stderr during a test. */
function captureEvents(): { events: Array<{ type: string; data: Record<string, unknown> }>; restore: () => void } {
  const original = process.stderr.write.bind(process.stderr);
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  process.stderr.write = ((chunk: unknown) => {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (parsed["__ve_event"] === true && typeof parsed["type"] === "string") {
          events.push({
            type: parsed["type"],
            data: (parsed["data"] ?? {}) as Record<string, unknown>,
          });
        }
      } catch {
        // not JSON, ignore
      }
    }
    return true;
  }) as typeof process.stderr.write;
  return {
    events,
    restore: () => {
      process.stderr.write = original;
    },
  };
}

describe("AgentRunOptions tool-authorization fields", () => {
  it("accepts blockedTools and toolAuthorization", () => {
    const options: AgentRunOptions = {
      model: "claude-sonnet-5",
      agentInstructions: "do work",
      cwd: "/workspace",
      timeoutMs: 60_000,
      mode: "codegen",
      blockedTools: ["Bash"],
      toolAuthorization: { autoLint: true },
    };
    expect(options.blockedTools).toEqual(["Bash"]);
    expect(options.toolAuthorization).toEqual({ autoLint: true });
  });

  it("leaves the new fields optional", () => {
    const options: AgentRunOptions = {
      model: "",
      agentInstructions: "",
      cwd: "/workspace",
      timeoutMs: 60_000,
      mode: "codegen",
    };
    expect(options.blockedTools).toBeUndefined();
    expect(options.toolAuthorization).toBeUndefined();
  });
});

describe("parseToolList", () => {
  it("splits a newline-separated list, trims, drops empties, and de-duplicates", () => {
    expect(parseToolList("Read\nEdit\n\n  Bash  \nRead\n")).toEqual(["Read", "Edit", "Bash"]);
  });

  it("returns an empty array for undefined / empty input", () => {
    expect(parseToolList(undefined)).toEqual([]);
    expect(parseToolList("")).toEqual([]);
    expect(parseToolList("   \n  \n")).toEqual([]);
  });
});

describe("createToolAuthorizingPermissionHandler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("denies a tool listed in blockedTools and emits permission.denied", async () => {
    const inner = vi.fn(() => ({ kind: "approve" as const }));
    const sink = captureEvents();
    try {
      const handler = createToolAuthorizingPermissionHandler(inner as never, {
        blockedTools: ["Bash"],
      });
      const result = await handler(
        { kind: "shell", fullCommandText: "rm -rf /" } as never,
        invocation,
      );
      expect(result).toEqual(expect.objectContaining({ kind: "reject" }));
      expect(inner).not.toHaveBeenCalled();
      const denied = sink.events.find((e) => e.type === "permission.denied");
      expect(denied).toBeDefined();
      expect(denied?.data["toolName"]).toBe("Bash");
    } finally {
      sink.restore();
    }
  });

  it("delegates to the inner handler for a non-blocked tool and emits permission.approved", async () => {
    const inner = vi.fn(() => ({ kind: "approve" as const }));
    const sink = captureEvents();
    try {
      const handler = createToolAuthorizingPermissionHandler(inner as never, {
        blockedTools: ["Bash"],
      });
      const result = await handler(
        { kind: "read", path: "README.md" } as never,
        invocation,
      );
      expect(result).toEqual(expect.objectContaining({ kind: "approve" }));
      expect(inner).toHaveBeenCalledOnce();
      expect(sink.events.some((e) => e.type === "permission.approved")).toBe(true);
    } finally {
      sink.restore();
    }
  });

  it("delegates to the inner handler when no user lists are configured", async () => {
    const inner = vi.fn(() => ({ kind: "approve" as const }));
    const handler = createToolAuthorizingPermissionHandler(inner as never, {});
    const result = await handler({ kind: "shell", fullCommandText: "ls" } as never, invocation);
    expect(result).toEqual(expect.objectContaining({ kind: "approve" }));
    expect(inner).toHaveBeenCalledOnce();
  });

  it("a tool in blockedTools is denied", async () => {
    const inner = vi.fn(() => ({ kind: "approve" as const }));
    const handler = createToolAuthorizingPermissionHandler(inner as never, {
      blockedTools: ["Bash"],
    });
    const result = await handler(
      { kind: "shell", fullCommandText: "echo hi" } as never,
      invocation,
    );
    expect(result).toEqual(expect.objectContaining({ kind: "reject" }));
    expect(inner).not.toHaveBeenCalled();
  });

  it("cannot relax VE's network floor: a network tool stays blocked even when the user never lists it", async () => {
    // The inner handler is the real network guard — it rejects curl.
    const sink = captureEvents();
    try {
      const handler = createToolAuthorizingPermissionHandler(
        restrictNetworkPermissionHandler,
        {}, // no user blocklist, but the floor still applies
      );
      const result = await handler(
        { kind: "shell", fullCommandText: "curl https://example.com" } as never,
        invocation,
      );
      expect(result).toEqual(expect.objectContaining({ kind: "reject" }));
      expect(sink.events.some((e) => e.type === "permission.denied")).toBe(true);
    } finally {
      sink.restore();
    }
  });

  it("emits permission.denied when the inner handler rejects", async () => {
    const inner = vi.fn(() => ({ kind: "reject" as const, feedback: "no" }));
    const sink = captureEvents();
    try {
      const handler = createToolAuthorizingPermissionHandler(inner as never, {});
      const result = await handler({ kind: "url" } as never, invocation);
      expect(result).toEqual(expect.objectContaining({ kind: "reject" }));
      expect(sink.events.some((e) => e.type === "permission.denied")).toBe(true);
    } finally {
      sink.restore();
    }
  });

  it("matches MCP tools by server-qualified name (mcp__server__tool)", async () => {
    const inner = vi.fn(() => ({ kind: "approve" as const }));
    const handler = createToolAuthorizingPermissionHandler(inner as never, {
      blockedTools: ["mcp__ve-submission__ve_submit_changes"],
    });
    const denied = await handler(
      { kind: "mcp", serverName: "ve-submission", toolName: "ve_submit_changes" } as never,
      invocation,
    );
    expect(denied).toEqual(expect.objectContaining({ kind: "reject" }));
    expect(inner).not.toHaveBeenCalled();
  });

  it("matches Bash(prefix:*) scoped patterns", async () => {
    const inner = vi.fn(() => ({ kind: "approve" as const }));
    const handler = createToolAuthorizingPermissionHandler(inner as never, {
      blockedTools: ["Bash(rm:*)"],
    });
    const denied = await handler(
      { kind: "shell", fullCommandText: "rm -rf /tmp/x" } as never,
      invocation,
    );
    expect(denied).toEqual(expect.objectContaining({ kind: "reject" }));
    const allowed = await handler(
      { kind: "shell", fullCommandText: "ls -la" } as never,
      invocation,
    );
    expect(allowed).toEqual(expect.objectContaining({ kind: "approve" }));
  });
});

/** Smoke-check that the provider registry type still compiles with the new
 *  AgentRunOptions shape (no runtime behavior asserted). */
describe("AgentProviderDefinition type compatibility", () => {
  it("accepts a definition whose runner ignores the new fields", () => {
    const def: AgentProviderDefinition = {
      id: "smoke",
      adapterLabel: "smoke",
      resolveModel: () => "smoke-model",
      defaultModelLabel: "smoke-model",
      submissionTransport: "text",
      runner: async (_prompt, options) => {
        // New fields are accessible.
        expect(Array.isArray(options.blockedTools)).toBe(true);
        return {
          content: "",
          toolCallCount: 0,
          toolsByKind: {},
          cleanup: async () => {},
        };
      },
    };
    expect(def.id).toBe("smoke");
  });
});

/** Keep the temp-dir helper around for future review-handler tests in this file. */
describe("createToolAuthorizingPermissionHandler with review inner", () => {
  it("preserves the review read floor when user lists tighten", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ve-toolauth-review-"));
    try {
      writeFileSync(join(workspace, "README.md"), "read me");
      const reviewInner = createReviewPermissionHandler(workspace);
      const handler = createToolAuthorizingPermissionHandler(reviewInner, {
        blockedTools: ["Write"],
      });
      const read = await handler(
        { kind: "read", path: "README.md" } as never,
        invocation,
      );
      expect(read).not.toEqual(expect.objectContaining({ kind: "reject" }));
      const write = await handler(
        { kind: "write", fileName: "x.ts" } as never,
        invocation,
      );
      expect(write).toEqual(expect.objectContaining({ kind: "reject" }));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
