import { describe, expect, it, vi } from "vitest";
import {
  fetchGitLabProxyImage,
  GITLAB_IMAGE_PROXY_MAX_BYTES,
} from "../../src/admin/adminImageProxy.js";

const BASE_URL = "https://gitlab.example.com";
const SECRET = "0123456789abcdef0123456789abcdef";
const TARGET_URL = `${BASE_URL}/group/project/uploads/${SECRET}/image.png`;

describe("fetchGitLabProxyImage", () => {
  it("rewrites project uploads and attaches GitLab authorization", async () => {
    const fetchImpl = vi.fn(async () => new Response("png-bytes", {
      status: 200,
      headers: { "content-type": "image/png" },
    }));

    const result = await fetchGitLabProxyImage({
      targetUrl: TARGET_URL,
      gitlabBaseUrl: BASE_URL,
      gitlabToken: "oauth-token",
      fetchImpl,
    });

    expect(result).toEqual({
      ok: true,
      contentType: "image/png",
      body: Buffer.from("png-bytes"),
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${BASE_URL}/api/v4/projects/group%2Fproject/uploads/${SECRET}/image.png`,
      expect.objectContaining({
        headers: { Authorization: "Bearer oauth-token" },
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("rejects non-image upstream content", async () => {
    const result = await fetchGitLabProxyImage({
      targetUrl: TARGET_URL,
      gitlabBaseUrl: BASE_URL,
      gitlabToken: "oauth-token",
      fetchImpl: async () => new Response("plain text", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    });

    expect(result).toEqual({ ok: false, statusCode: 502, error: "Upstream did not return an image" });
  });

  it("rejects an oversized declared content length before reading", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull: vi.fn(),
    });
    const result = await fetchGitLabProxyImage({
      targetUrl: TARGET_URL,
      gitlabBaseUrl: BASE_URL,
      gitlabToken: "oauth-token",
      fetchImpl: async () => new Response(body, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(GITLAB_IMAGE_PROXY_MAX_BYTES + 1),
        },
      }),
    });

    expect(result).toEqual({ ok: false, statusCode: 413, error: "Upstream image is too large" });
  });

  it("cancels a streamed response that exceeds the byte limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await fetchGitLabProxyImage({
      targetUrl: TARGET_URL,
      gitlabBaseUrl: BASE_URL,
      gitlabToken: "oauth-token",
      maxResponseBytes: 5,
      fetchImpl: async () => new Response(body, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    });

    expect(result).toEqual({ ok: false, statusCode: 413, error: "Upstream image is too large" });
    expect(cancelled).toBe(true);
  });

  it("aborts an upstream request after the timeout", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));

    const result = await fetchGitLabProxyImage({
      targetUrl: TARGET_URL,
      gitlabBaseUrl: BASE_URL,
      gitlabToken: "oauth-token",
      timeoutMs: 1,
      fetchImpl,
    });

    expect(result).toEqual({ ok: false, statusCode: 502, error: "Proxy fetch timed out" });
  });
});