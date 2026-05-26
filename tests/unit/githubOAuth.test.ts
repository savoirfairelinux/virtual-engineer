import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createGitHubOAuthConfig,
  createGitHubDeviceOAuthHandler,
} from "../../src/plugins/descriptors/githubOAuth.js";
import { jsonResponse, errorResponse } from "./helpers/fixtures.js";

describe("createGitHubOAuthConfig", () => {
  it("returns a device-mode config with provider-scoped paths", () => {
    const cfg = createGitHubOAuthConfig("github-issue", "GitHub Issues Authentication");
    expect(cfg).toEqual({
      mode: "device",
      tokenField: "token",
      dependsOn: { field: "authMode", value: "oauth" },
      providerName: "GitHub",
      heading: "GitHub Issues Authentication",
      connectLabel: "Connect with GitHub",
      reconnectLabel: "Re-connect",
      pendingLabel: "Waiting\u2026",
      startPath: "/api/admin/plugins/github-issue/oauth/device-code",
      completePath: "/api/admin/plugins/github-issue/oauth/token",
    });
  });

  it("uses the integration type to scope the device endpoints", () => {
    const cfg = createGitHubOAuthConfig("github-pull-request", "GitHub PR Auth");
    expect(cfg.startPath).toBe("/api/admin/plugins/github-pull-request/oauth/device-code");
    expect(cfg.completePath).toBe("/api/admin/plugins/github-pull-request/oauth/token");
  });
});

describe("createGitHubDeviceOAuthHandler", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws when oauthClientId is missing", () => {
    expect(() => createGitHubDeviceOAuthHandler({ mode: "github.com" })).toThrow(
      /OAuth Client ID is required/
    );
  });

  it("throws when enterprise mode lacks baseUrl", () => {
    expect(() =>
      createGitHubDeviceOAuthHandler({ mode: "github-enterprise", oauthClientId: "Iv1.x" })
    ).toThrow(/customBaseUrl is required/);
  });

  it("start() hits github.com/login/device/code with the client id", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        device_code: "dev-123",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        interval: 5,
        expires_in: 900,
      })
    );

    const handler = createGitHubDeviceOAuthHandler({
      mode: "github.com",
      oauthClientId: "Iv1.client",
    });
    const result = await handler.start();

    expect(result).toEqual({
      deviceCode: "dev-123",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 5,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://github.com/login/device/code");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: "Iv1.client",
      scope: "repo",
    });
  });

  it("start() uses enterprise webBaseUrl when configured", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        device_code: "d",
        user_code: "u",
        verification_uri: "https://ghe.corp.com/login/device",
        interval: 5,
        expires_in: 900,
      })
    );

    const handler = createGitHubDeviceOAuthHandler({
      mode: "github-enterprise",
      baseUrl: "https://ghe.corp.com",
      oauthClientId: "Iv1.enterprise",
    });
    await handler.start();

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://ghe.corp.com/login/device/code");
  });

  it("complete() returns the access token on success", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: "gho_abc123",
        token_type: "bearer",
        scope: "repo",
      })
    );

    const handler = createGitHubDeviceOAuthHandler({
      mode: "github.com",
      oauthClientId: "Iv1.client",
    });
    const result = await handler.complete({ deviceCode: "dev-123" });
    expect(result).toEqual({ token: "gho_abc123" });
  });

  it("complete() throws authorization_pending while pending", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "authorization_pending" }));
    const handler = createGitHubDeviceOAuthHandler({
      mode: "github.com",
      oauthClientId: "Iv1.client",
    });
    await expect(handler.complete({ deviceCode: "d" })).rejects.toThrow(/authorization_pending/);
  });

  it("complete() throws on expired token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "expired_token" }));
    const handler = createGitHubDeviceOAuthHandler({
      mode: "github.com",
      oauthClientId: "Iv1.client",
    });
    await expect(handler.complete({ deviceCode: "d" })).rejects.toThrow(/expired/i);
  });

  it("complete() surfaces server errors", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(500, "boom"));
    const handler = createGitHubDeviceOAuthHandler({
      mode: "github.com",
      oauthClientId: "Iv1.client",
    });
    await expect(handler.complete({ deviceCode: "d" })).rejects.toThrow();
  });
});
