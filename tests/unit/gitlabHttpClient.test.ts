import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GitLabHttpClient, DISCOVERY_TIMEOUT_MS } from "../../src/connectors/gitlabHttpClient.js";
import { TicketApiError } from "../../src/interfaces.js";
import { jsonResponse, errorResponse } from "./helpers/fixtures.js";

const TOKEN = "glpat-test-token";
const URL = "https://gitlab.test/api/v4/resource";

class TestApiError extends TicketApiError {
  constructor(statusCode: number, url: string, body: string) {
    super(statusCode, url, body);
    this.name = "TestApiError";
  }
}

function errorFactory(statusCode: number, url: string, body: string): TicketApiError {
  return new TestApiError(statusCode, url, body);
}

function makeClient(): GitLabHttpClient {
  return new GitLabHttpClient(TOKEN, errorFactory);
}

describe("GitLabHttpClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── fetchJson ─────────────────────────────────────────────────────────────

  describe("fetchJson", () => {
    it("returns parsed JSON on success", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 1 }));
      const result = await makeClient().fetchJson<{ id: number }>(URL);
      expect(result).toEqual({ id: 1 });
    });

    it("injects Authorization Bearer header", async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));
      await makeClient().fetchJson(URL);
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { headers: Record<string, string> };
      expect(init.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    });

    it("merges caller-supplied headers without overwriting Authorization", async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));
      await makeClient().fetchJson(URL, { headers: { "X-Custom": "yes" } });
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { headers: Record<string, string> };
      expect(init.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
      expect(init.headers["x-custom"] ?? init.headers["X-Custom"]).toBe("yes");
    });

    it("throws errorFactory error on non-OK response", async () => {
      fetchMock.mockResolvedValue(errorResponse(401, "Unauthorized"));
      await expect(makeClient().fetchJson(URL)).rejects.toBeInstanceOf(TestApiError);
    });

    it("thrown error carries status code and url", async () => {
      fetchMock.mockResolvedValue(errorResponse(403, "Forbidden"));
      const err = await makeClient().fetchJson(URL).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TicketApiError);
      expect((err as TicketApiError).statusCode).toBe(403);
    });
  });

  // ─── fetchJsonVoid ─────────────────────────────────────────────────────────

  describe("fetchJsonVoid", () => {
    it("resolves without value on success", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));
      await expect(makeClient().fetchJsonVoid(URL, { method: "PUT" })).resolves.toBeUndefined();
    });

    it("injects Authorization Bearer header", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));
      await makeClient().fetchJsonVoid(URL);
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { headers: Record<string, string> };
      expect(init.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    });

    it("throws errorFactory error on non-OK response", async () => {
      fetchMock.mockResolvedValue(errorResponse(422, "Unprocessable"));
      await expect(makeClient().fetchJsonVoid(URL)).rejects.toBeInstanceOf(TestApiError);
    });
  });

  // ─── fetchPaginated ────────────────────────────────────────────────────────

  describe("fetchPaginated", () => {
    function paginatedResponse(data: unknown, nextPage: string | null, status = 200): Response {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (nextPage !== null) headers["x-next-page"] = nextPage;
      return new Response(JSON.stringify(data), { status, headers });
    }

    it("returns body and nextPage when x-next-page header is present", async () => {
      fetchMock.mockResolvedValue(paginatedResponse([{ id: 1 }], "2"));
      const result = await makeClient().fetchPaginated(URL);
      expect(result.body).toEqual([{ id: 1 }]);
      expect(result.nextPage).toBe(2);
    });

    it("returns nextPage null when x-next-page header is absent", async () => {
      fetchMock.mockResolvedValue(paginatedResponse([{ id: 2 }], null));
      const result = await makeClient().fetchPaginated(URL);
      expect(result.nextPage).toBeNull();
    });

    it("returns nextPage null when x-next-page is empty string", async () => {
      fetchMock.mockResolvedValue(paginatedResponse([], ""));
      const result = await makeClient().fetchPaginated(URL);
      expect(result.nextPage).toBeNull();
    });

    it("throws errorFactory error on non-OK response", async () => {
      fetchMock.mockResolvedValue(errorResponse(500, "Server error"));
      await expect(makeClient().fetchPaginated(URL)).rejects.toBeInstanceOf(TestApiError);
    });

    it("injects Authorization Bearer header", async () => {
      fetchMock.mockResolvedValue(paginatedResponse([], null));
      await makeClient().fetchPaginated(URL);
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { headers: Record<string, string> };
      expect(init.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    });

    it("aborts on timeout", async () => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            (init.signal as AbortSignal).addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError"))
            );
          })
      );
      const pending = makeClient().fetchPaginated(URL);
      vi.advanceTimersByTime(DISCOVERY_TIMEOUT_MS + 1);
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      vi.useRealTimers();
    });
  });
});
