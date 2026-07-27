import { describe, it, expect, vi } from "vitest";
import { validateClaudeConnection } from "../../src/agents/claudeConnectionValidator.js";

function jsonResponse(status: number): Response {
  return new Response(status === 200 ? JSON.stringify({ data: [] }) : "err", { status });
}

describe("validateClaudeConnection", () => {
  describe("api_key mode", () => {
    it("returns success and calls the models API with x-api-key", async () => {
      const fetch = vi.fn().mockResolvedValue(jsonResponse(200));
      const result = await validateClaudeConnection(
        { authMode: "api_key", apiKey: "sk-ant-key" },
        { fetch: fetch as unknown as typeof globalThis.fetch }
      );
      expect(result.success).toBe(true);
      const [url, init] = fetch.mock.calls[0]!;
      expect(url).toBe("https://api.anthropic.com/v1/models");
      expect((init as RequestInit).headers).toMatchObject({ "x-api-key": "sk-ant-key" });
    });

    it("fails when no api key is provided", async () => {
      const fetch = vi.fn();
      const result = await validateClaudeConnection(
        { authMode: "api_key" },
        { fetch: fetch as unknown as typeof globalThis.fetch }
      );
      expect(result.success).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("reports 401 as invalid", async () => {
      const fetch = vi.fn().mockResolvedValue(jsonResponse(401));
      const result = await validateClaudeConnection(
        { authMode: "api_key", apiKey: "bad" },
        { fetch: fetch as unknown as typeof globalThis.fetch }
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("invalid");
    });
  });

  describe("subscription mode", () => {
    it("uses the session token as a bearer + oauth beta header", async () => {
      const fetch = vi.fn().mockResolvedValue(jsonResponse(200));
      const result = await validateClaudeConnection(
        { authMode: "subscription", sessionToken: "sk-ant-oat-123" },
        { fetch: fetch as unknown as typeof globalThis.fetch }
      );
      expect(result.success).toBe(true);
      const [, init] = fetch.mock.calls[0]!;
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: "Bearer sk-ant-oat-123",
        "anthropic-beta": "oauth-2025-04-20",
      });
    });

    it("fails when no subscription token is configured", async () => {
      const fetch = vi.fn();
      const result = await validateClaudeConnection(
        { authMode: "subscription" },
        { fetch: fetch as unknown as typeof globalThis.fetch }
      );
      expect(result.success).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
