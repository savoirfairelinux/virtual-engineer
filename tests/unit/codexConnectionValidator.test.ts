import { describe, it, expect, vi } from "vitest";
import { validateCodexConnection } from "../../src/agents/codexConnectionValidator.js";

function jsonResponse(status: number): Response {
  return new Response(status === 200 ? JSON.stringify({ data: [{ id: "gpt-5.5" }] }) : "err", { status });
}

describe("validateCodexConnection", () => {
  describe("api_key mode", () => {
    it("returns success and calls the models API with a bearer token", async () => {
      const fetch = vi.fn().mockResolvedValue(jsonResponse(200));
      const result = await validateCodexConnection(
        { authMode: "api_key", apiKey: "sk-openai-key" },
        { fetch: fetch as unknown as typeof globalThis.fetch }
      );
      expect(result.success).toBe(true);
      const [url, init] = fetch.mock.calls[0]!;
      expect(url).toBe("https://api.openai.com/v1/models");
      expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer sk-openai-key" });
    });

    it("fails when no api key is provided", async () => {
      const fetch = vi.fn();
      const result = await validateCodexConnection(
        { authMode: "api_key" },
        { fetch: fetch as unknown as typeof globalThis.fetch }
      );
      expect(result.success).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("reports 401 as invalid", async () => {
      const fetch = vi.fn().mockResolvedValue(jsonResponse(401));
      const result = await validateCodexConnection(
        { authMode: "api_key", apiKey: "bad" },
        { fetch: fetch as unknown as typeof globalThis.fetch }
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("invalid");
    });
  });

  describe("subscription mode", () => {
    it("accepts a non-empty access token without a live network call", async () => {
      const fetch = vi.fn();
      const result = await validateCodexConnection(
        { authMode: "subscription", accessToken: "codex-access-token" },
        { fetch: fetch as unknown as typeof globalThis.fetch }
      );
      expect(result.success).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("fails when no access token is configured", async () => {
      const fetch = vi.fn();
      const result = await validateCodexConnection(
        { authMode: "subscription" },
        { fetch: fetch as unknown as typeof globalThis.fetch }
      );
      expect(result.success).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
