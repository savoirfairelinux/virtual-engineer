import { describe, it, expect, vi } from "vitest";
import { validateGeminiConnection } from "../../src/agents/geminiConnectionValidator.js";

function jsonResponse(status: number): Response {
  return new Response(
    status === 200 ? JSON.stringify({ models: [{ name: "models/gemini-2.5-pro" }] }) : "err",
    { status }
  );
}

describe("validateGeminiConnection", () => {
  describe("api_key mode", () => {
    it("returns success and calls the models API with the key as a query param", async () => {
      const fetch = vi.fn().mockResolvedValue(jsonResponse(200));
      const result = await validateGeminiConnection(
        { authMode: "api_key", apiKey: "gemini-key" },
        { fetch: fetch as unknown as typeof globalThis.fetch }
      );
      expect(result.success).toBe(true);
      const [url] = fetch.mock.calls[0]!;
      expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models?key=gemini-key");
    });

    it("fails when no api key is provided", async () => {
      const fetch = vi.fn();
      const result = await validateGeminiConnection(
        { authMode: "api_key" },
        { fetch: fetch as unknown as typeof globalThis.fetch }
      );
      expect(result.success).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("reports 401 as invalid", async () => {
      const fetch = vi.fn().mockResolvedValue(jsonResponse(401));
      const result = await validateGeminiConnection(
        { authMode: "api_key", apiKey: "bad" },
        { fetch: fetch as unknown as typeof globalThis.fetch }
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("invalid");
    });
  });

  describe("vertex_ai mode", () => {
    it("returns success for a valid Express Mode key", async () => {
      const fetch = vi.fn().mockResolvedValue(jsonResponse(200));
      const result = await validateGeminiConnection(
        { authMode: "vertex_ai", apiKey: "vertex-key" },
        { fetch: fetch as unknown as typeof globalThis.fetch }
      );
      expect(result.success).toBe(true);
    });

    it("fails when no key is configured", async () => {
      const fetch = vi.fn();
      const result = await validateGeminiConnection(
        { authMode: "vertex_ai" },
        { fetch: fetch as unknown as typeof globalThis.fetch }
      );
      expect(result.success).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
