import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import { maskAuditDetails, recordAudit } from "../../src/admin/adminAudit.js";
import { setAuthContext } from "../../src/admin/authContext.js";

function fakeRequest(): IncomingMessage {
  return {} as IncomingMessage;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("maskAuditDetails", () => {
  it("masks secret-like keys at the top level", () => {
    expect(maskAuditDetails({
      token: "abc",
      webhookSecret: "s3cret",
      password: "pw",
      apiKey: "k",
      credential: "c",
      name: "safe",
    })).toEqual({
      token: "***",
      webhookSecret: "***",
      password: "***",
      apiKey: "***",
      credential: "***",
      name: "safe",
    });
  });

  it("masks recursively inside nested objects and arrays", () => {
    expect(maskAuditDetails({
      config: { sessionToken: "tok", nested: [{ clientSecret: "x" }, { plain: 1 }] },
      list: ["a", "b"],
    })).toEqual({
      config: { sessionToken: "***", nested: [{ clientSecret: "***" }, { plain: 1 }] },
      list: ["a", "b"],
    });
  });

  it("preserves known-safe identifier keys (repoKey, repoKeys, ticketProjectKey)", () => {
    expect(maskAuditDetails({
      repoKey: "group/repo",
      repoKeys: ["a/b", "c/d"],
      ticketProjectKey: "proj",
    })).toEqual({
      repoKey: "group/repo",
      repoKeys: ["a/b", "c/d"],
      ticketProjectKey: "proj",
    });
  });

  it("leaves empty/null secret values untouched", () => {
    expect(maskAuditDetails({ token: "", secret: null })).toEqual({ token: "", secret: null });
  });
});

describe("recordAudit", () => {
  it("appends an entry with the actor resolved from the request auth context", async () => {
    const appendAuditEntry = vi.fn().mockResolvedValue({});
    const req = fakeRequest();
    setAuthContext(req, { userId: "u-1", username: "alice", role: "admin" });
    recordAudit({ appendAuditEntry }, req, {
      action: "integration.create",
      targetType: "integration",
      targetId: "int-1",
      details: { name: "GitLab", token: "raw" },
    });
    await flushMicrotasks();
    expect(appendAuditEntry).toHaveBeenCalledWith({
      actorUserId: "u-1",
      actorName: "alice",
      action: "integration.create",
      targetType: "integration",
      targetId: "int-1",
      details: { name: "GitLab", token: "***" },
    });
  });

  it("falls back to actorName 'unknown' when no auth context is attached", async () => {
    const appendAuditEntry = vi.fn().mockResolvedValue({});
    recordAudit({ appendAuditEntry }, fakeRequest(), { action: "task.pause" });
    await flushMicrotasks();
    expect(appendAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: null,
      actorName: "unknown",
      action: "task.pause",
      targetType: null,
      targetId: null,
      details: {},
    }));
  });

  it("no-ops when the store is missing or lacks appendAuditEntry", () => {
    expect(() => recordAudit(undefined, fakeRequest(), { action: "x" })).not.toThrow();
    expect(() => recordAudit(null, fakeRequest(), { action: "x" })).not.toThrow();
    expect(() => recordAudit({}, fakeRequest(), { action: "x" })).not.toThrow();
  });

  it("swallows append rejections (fire-and-forget)", async () => {
    const appendAuditEntry = vi.fn().mockRejectedValue(new Error("db locked"));
    expect(() => recordAudit({ appendAuditEntry }, fakeRequest(), { action: "x" })).not.toThrow();
    await flushMicrotasks();
    expect(appendAuditEntry).toHaveBeenCalledOnce();
  });

  it("swallows synchronous append throws", () => {
    const appendAuditEntry = vi.fn(() => { throw new Error("sync boom"); });
    expect(() => recordAudit(
      { appendAuditEntry: appendAuditEntry as unknown as () => Promise<unknown> },
      fakeRequest(),
      { action: "x" }
    )).not.toThrow();
  });
});
