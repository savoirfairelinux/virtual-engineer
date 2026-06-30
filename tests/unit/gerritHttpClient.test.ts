/**
 * Tests for GerritHttpClient and GerritHttpConnector.
 * All external HTTP calls are mocked via vi.spyOn(globalThis, "fetch").
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GerritHttpClient, GerritHttpError } from "../../src/connectors/gerritHttpClient.js";
import { GerritHttpConnector } from "../../src/connectors/gerritConnector.js";
import { makeExternalChangeId } from "../../src/interfaces.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function gerritJson(data: unknown): string {
  return `)]}'\n${JSON.stringify(data)}`;
}

function mockFetch(status: number, body: string): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(body, { status, headers: { "Content-Type": "application/json" } })
  );
}

function makeClient(): GerritHttpClient {
  return new GerritHttpClient({
    baseUrl: "https://gerrit.example.com",
    username: "ve-bot",
    token: "secret-token",
  });
}

// ─── GerritHttpClient ─────────────────────────────────────────────────────────

describe("GerritHttpClient", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends Authorization: Basic header with base64-encoded credentials", async () => {
    const client = makeClient();
    const expectedCreds = Buffer.from("ve-bot:secret-token").toString("base64");
    mockFetch(200, gerritJson({ ok: true }));

    await client.fetchJson("accounts/self");

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(call).toBeDefined();
    const init = call![1] as RequestInit;
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Basic ${expectedCreds}`);
  });

  it("requests the /a/ API prefix for authenticated endpoints", async () => {
    const client = makeClient();
    mockFetch(200, gerritJson({ _number: 42 }));

    await client.fetchJson("changes/123");

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const url = call![0] as string;
    expect(url).toBe("https://gerrit.example.com/a/changes/123");
  });

  it("strips the XSSI prefix from Gerrit REST responses", async () => {
    const client = makeClient();
    mockFetch(200, gerritJson({ name: "my-project" }));

    const data = await client.fetchJson<{ name: string }>("projects/my-project");
    expect(data.name).toBe("my-project");
  });

  it("throws GerritHttpError on non-2xx response", async () => {
    const client = makeClient();
    mockFetch(404, "Not Found");

    await expect(client.fetchJson("projects/missing")).rejects.toBeInstanceOf(GerritHttpError);
  });

  it("GerritHttpError carries status code and URL", async () => {
    const client = makeClient();
    mockFetch(403, "Forbidden");

    const err = await client.fetchJson("changes/123").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GerritHttpError);
    expect((err as GerritHttpError).statusCode).toBe(403);
    expect((err as GerritHttpError).url).toContain("changes/123");
  });

  it("fetchVoid resolves on 2xx without returning a value", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 200 })
    );

    await expect(client.fetchVoid("changes/123/abandon", { method: "POST" })).resolves.toBeUndefined();
  });

  it("fetchVoid throws GerritHttpError on non-2xx", async () => {
    const client = makeClient();
    mockFetch(400, "Bad Request");

    await expect(client.fetchVoid("changes/123/abandon", { method: "POST" })).rejects.toBeInstanceOf(GerritHttpError);
  });

  describe("buildCloneUrl", () => {
    it("embeds username and token in the URL", () => {
      const client = makeClient();
      const url = client.buildCloneUrl("my-org/my-repo");
      expect(url).toBe("https://ve-bot:secret-token@gerrit.example.com/my-org/my-repo");
    });

    it("handles paths without a leading slash", () => {
      const client = makeClient();
      expect(client.buildCloneUrl("repo")).toBe("https://ve-bot:secret-token@gerrit.example.com/repo");
    });

    it("handles baseUrl with a trailing slash", () => {
      const client = new GerritHttpClient({
        baseUrl: "https://gerrit.example.com/",
        username: "u",
        token: "t",
      });
      expect(client.buildCloneUrl("repo")).toBe("https://u:t@gerrit.example.com/repo");
    });
  });

  describe("baseUrl and username accessors", () => {
    it("exposes baseUrl", () => {
      expect(makeClient().baseUrl).toBe("https://gerrit.example.com");
    });

    it("exposes username", () => {
      expect(makeClient().username).toBe("ve-bot");
    });
  });
});

// ─── GerritHttpConnector ──────────────────────────────────────────────────────

describe("GerritHttpConnector", () => {
  const CHANGE_ID = makeExternalChangeId("myproject~master~I8473b95934b5732ac55d26311a706c9c2bde9940");

  function makeConnector(): GerritHttpConnector {
    return new GerritHttpConnector({
      http: makeClient(),
      baseUrl: "https://gerrit.example.com",
    });
  }

  beforeEach(() => vi.clearAllMocks());

  it("getChange fetches change details and maps status NEW to OPEN", async () => {
    mockFetch(200, gerritJson({
      _number: 42,
      status: "NEW",
      current_revision: "abc123",
      revisions: { abc123: { _number: 3 } },
      web_links: [{ url: "https://gerrit.example.com/c/42" }],
    }));

    const change = await makeConnector().getChange(CHANGE_ID);

    expect(change.changeNumber).toBe(42);
    expect(change.patchsetNumber).toBe(3);
    expect(change.url).toContain("42");
  });

  it("getChange falls back to baseUrl for change link when no web_links", async () => {
    mockFetch(200, gerritJson({
      _number: 99,
      status: "MERGED",
      current_revision: "rev1",
      revisions: { rev1: { _number: 1 } },
    }));

    const change = await makeConnector().getChange(CHANGE_ID);
    expect(change.url).toBe("https://gerrit.example.com/c/99");
  });

  it("getChangeStatus maps NEW to OPEN", async () => {
    mockFetch(200, gerritJson({ _number: 1, status: "NEW" }));
    await expect(makeConnector().getChangeStatus(CHANGE_ID)).resolves.toBe("OPEN");
  });

  it("getChangeStatus passes MERGED through unchanged", async () => {
    mockFetch(200, gerritJson({ _number: 1, status: "MERGED" }));
    await expect(makeConnector().getChangeStatus(CHANGE_ID)).resolves.toBe("MERGED");
  });

  it("getChangeStatus passes ABANDONED through unchanged", async () => {
    mockFetch(200, gerritJson({ _number: 1, status: "ABANDONED" }));
    await expect(makeConnector().getChangeStatus(CHANGE_ID)).resolves.toBe("ABANDONED");
  });

  it("listRepositories returns DiscoveredRepository objects with repo names", async () => {
    mockFetch(200, gerritJson({
      "my-repo": { id: "my-repo", state: "ACTIVE" },
      "other-repo": { id: "other-repo", state: "ACTIVE" },
    }));

    const repos = await makeConnector().listRepositories();
    const names = repos.map((r) => r.name);
    expect(names).toContain("my-repo");
    expect(names).toContain("other-repo");
  });

  it("getUnresolvedComments returns unresolved comments filtered by reviewer account", async () => {
    mockFetch(200, gerritJson({
      "src/foo.ts": [
        {
          id: "c1",
          author: { username: "other-user", email: "other@test.com" },
          message: "Fix this",
          line: 5,
          unresolved: true,
          updated: "2024-01-15 10:00:00.000000000",
          patch_set: 2,
        },
        {
          id: "c2",
          author: { username: "ve-bot", email: "ve@test.com" },
          message: "My own comment — should be filtered",
          unresolved: true,
          updated: "2024-01-15 11:00:00.000000000",
          patch_set: 2,
        },
        {
          id: "c3",
          author: { username: "other-user", email: "other@test.com" },
          message: "Already resolved — should be filtered",
          unresolved: false,
          updated: "2024-01-15 12:00:00.000000000",
          patch_set: 2,
        },
      ],
    }));

    const comments = await makeConnector().getUnresolvedComments(CHANGE_ID);

    // Only c1 remains: c2 filtered (own account), c3 filtered (resolved)
    expect(comments).toHaveLength(1);
    expect(comments[0]!.id).toBe("c1");
    expect(comments[0]!.message).toBe("Fix this");
    expect(comments[0]!.line).toBe(5);
    expect(comments[0]!.unresolved).toBe(true);
  });

  it("getUnresolvedComments returns empty array on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network error"));
    const comments = await makeConnector().getUnresolvedComments(CHANGE_ID);
    expect(comments).toEqual([]);
  });

  it("addChangeComment posts to the review endpoint", async () => {
    // addChangeComment first calls getChange to get patchset number
    const changeInfoBody = gerritJson({
      _number: 42,
      status: "NEW",
      current_revision: "rev1",
      revisions: { rev1: { _number: 3 } },
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(changeInfoBody, { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));

    await makeConnector().addChangeComment(CHANGE_ID, "LGTM");

    const calls = vi.mocked(globalThis.fetch).mock.calls;
    const reviewCall = calls[1];
    const url = reviewCall![0] as string;
    expect(url).toContain("/review");
    expect(url).toContain(encodeURIComponent(CHANGE_ID));
  });
});
