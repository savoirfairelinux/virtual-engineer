import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import { maskAuditDetails, recordAudit, appendAuditWithRetry } from "../../src/admin/adminAudit.js";
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

  it("safe-list check is case-insensitive (e.g. RepoKey / REPOKEY must not be masked)", () => {
    expect(maskAuditDetails({
      RepoKey: "group/repo",
      REPOKEYS: ["a/b"],
      TicketProjectKey: "proj",
      PublicKey: "ssh-ed25519 AAAA...",
    })).toEqual({
      RepoKey: "group/repo",
      REPOKEYS: ["a/b"],
      TicketProjectKey: "proj",
      PublicKey: "ssh-ed25519 AAAA...",
    });
  });

  it("leaves empty/null secret values untouched", () => {
    expect(maskAuditDetails({ token: "", secret: null })).toEqual({ token: "", secret: null });
  });

  it("preserves keys ending in 'Path' (e.g. sshKeyPath) despite containing 'key'", () => {
    expect(maskAuditDetails({
      sshKeyPath: "/ve-home/.ssh/id_ed25519",
      apiKey: "should-be-masked",
    })).toEqual({
      sshKeyPath: "/ve-home/.ssh/id_ed25519",
      apiKey: "***",
    });
  });

  it("masks secret keys including separator-less compounds, but exempts safelisted identifiers", () => {
    expect(maskAuditDetails({
      // safelisted / non-secret identifiers — preserved
      publicKey: "ssh-ed25519 AAAA...",
      repoKey: "group/repo",
      sshKeyPath: "/ve-home/.ssh/id_ed25519",
      // genuine secrets in various shapes — all masked (fail-safe substring match)
      privateKey: "-----BEGIN-----",
      sessionToken: "abc",
      webhookSecret: "shh",
      apikey: "concat-lowercase",
      accesstoken: "concat-lowercase",
    })).toEqual({
      publicKey: "ssh-ed25519 AAAA...",
      repoKey: "group/repo",
      sshKeyPath: "/ve-home/.ssh/id_ed25519",
      privateKey: "***",
      sessionToken: "***",
      webhookSecret: "***",
      apikey: "***",
      accesstoken: "***",
    });
  });

  it("masks circular references as '[Circular]' instead of throwing or hanging", () => {
    const details: Record<string, unknown> = { name: "task" };
    details["self"] = details;
    const nested: Record<string, unknown> = {};
    nested["parent"] = details;
    details["nested"] = nested;

    const result = maskAuditDetails(details) as Record<string, unknown>;
    expect(result["name"]).toBe("task");
    expect(result["self"]).toBe("[Circular]");
    expect((result["nested"] as Record<string, unknown>)["parent"]).toBe("[Circular]");
  });

  it("masks circular references inside arrays as '[Circular]'", () => {
    const arr: unknown[] = ["a"];
    arr.push(arr);
    const result = maskAuditDetails({ list: arr }) as Record<string, unknown>;
    expect((result["list"] as unknown[])[0]).toBe("a");
    expect((result["list"] as unknown[])[1]).toBe("[Circular]");
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

describe("appendAuditWithRetry", () => {
  it("retries transient failures and succeeds on a later attempt", async () => {
    const appendAuditEntry = vi
      .fn()
      .mockRejectedValueOnce(new Error("db locked"))
      .mockRejectedValueOnce(new Error("db locked"))
      .mockResolvedValueOnce({});
    await appendAuditWithRetry({ appendAuditEntry }, { actorName: "root", action: "x" }, [0, 0, 0]);
    expect(appendAuditEntry).toHaveBeenCalledTimes(3);
  });

  it("gives up after exhausting retries without throwing", async () => {
    const appendAuditEntry = vi.fn().mockRejectedValue(new Error("db down"));
    await expect(
      appendAuditWithRetry({ appendAuditEntry }, { actorName: "root", action: "x" }, [0, 0])
    ).resolves.toBeUndefined();
    // 1 initial attempt + 2 retries
    expect(appendAuditEntry).toHaveBeenCalledTimes(3);
  });
});
