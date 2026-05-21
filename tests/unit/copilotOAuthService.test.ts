import { describe, expect, it, vi } from "vitest";
import { startDeviceFlow, pollForAccessToken, DeviceFlowExpiredError, DeviceFlowDeniedError } from "../../src/agents/copilotOAuthService.js";

describe("startDeviceFlow", () => {
  it("returns device flow response from GitHub", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        device_code: "dc_abc",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
    })) as unknown as typeof globalThis.fetch;

    const result = await startDeviceFlow({ fetch: mockFetch });

    expect(result).toEqual({
      deviceCode: "dc_abc",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 5,
    });
  });

  it("sends the correct client_id and scope", async () => {
    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body["client_id"]).toBe("Iv1.b507a08c87ecfe98");
      expect(body["scope"]).toBe("read:user");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          device_code: "dc",
          user_code: "UC",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        }),
      };
    }) as unknown as typeof globalThis.fetch;

    await startDeviceFlow({ fetch: mockFetch });
  });

  it("throws when GitHub returns an error", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    })) as unknown as typeof globalThis.fetch;

    await expect(startDeviceFlow({ fetch: mockFetch }))
      .rejects.toThrow("GitHub device code request failed");
  });
});

describe("pollForAccessToken", () => {
  it("returns access token after authorization_pending then success", async () => {
    let callCount = 0;
    const mockFetch = vi.fn(async () => {
      callCount++;
      if (callCount <= 2) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ error: "authorization_pending" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "ghu_abc123",
          token_type: "bearer",
          scope: "read:user",
        }),
      };
    }) as unknown as typeof globalThis.fetch;

    // Speed up test by mocking setTimeout
    vi.useFakeTimers();
    const promise = pollForAccessToken("dc_test", { fetch: mockFetch });
    // Advance past 3 intervals (5s each)
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);

    const result = await promise;
    vi.useRealTimers();

    expect(result.accessToken).toBe("ghu_abc123");
    expect(result.tokenType).toBe("bearer");
  });

  it("throws DeviceFlowExpiredError when token expires", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: "expired_token" }),
    })) as unknown as typeof globalThis.fetch;

    vi.useFakeTimers();
    const promise = pollForAccessToken("dc_expired", { fetch: mockFetch });
    // Attach catch immediately to prevent unhandled rejection
    const caught = promise.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(5000);

    const err = await caught;
    expect(err).toBeInstanceOf(DeviceFlowExpiredError);
    vi.useRealTimers();
  });

  it("throws DeviceFlowDeniedError when user denies", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: "access_denied" }),
    })) as unknown as typeof globalThis.fetch;

    vi.useFakeTimers();
    const promise = pollForAccessToken("dc_denied", { fetch: mockFetch });
    // Attach catch immediately to prevent unhandled rejection
    const caught = promise.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(5000);

    const err = await caught;
    expect(err).toBeInstanceOf(DeviceFlowDeniedError);
    vi.useRealTimers();
  });
});
