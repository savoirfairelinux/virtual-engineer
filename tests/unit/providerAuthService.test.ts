import { describe, expect, it, vi } from "vitest";
import {
  DefaultProviderAuthService,
  type DeviceProviderAuthHandler,
  type RedirectProviderAuthHandler,
} from "../../src/agents/providerAuthService.js";

function makeDeviceHandler(overrides: Partial<DeviceProviderAuthHandler> = {}): DeviceProviderAuthHandler {
  return {
    kind: "device",
    start: vi.fn(async () => ({
      deviceCode: "dc_test",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 5,
    })),
    complete: vi.fn(async () => ({
      token: "ghu_test_token",
    })),
    ...overrides,
  };
}

function makeRedirectHandler(overrides: Partial<RedirectProviderAuthHandler> = {}): RedirectProviderAuthHandler {
  return {
    kind: "redirect",
    start: vi.fn(async ({ redirectUri, state, codeChallenge, codeChallengeMethod }) => ({
      authorizationUrl: `https://gitlab.example.com/oauth/authorize?redirect_uri=${encodeURIComponent(redirectUri)}${state ? `&state=${encodeURIComponent(state)}` : ""}${codeChallenge ? `&code_challenge=${encodeURIComponent(codeChallenge)}` : ""}${codeChallengeMethod ? `&code_challenge_method=${encodeURIComponent(codeChallengeMethod)}` : ""}`,
    })),
    complete: vi.fn(async () => ({
      token: "gloauth_test_token",
    })),
    ...overrides,
  };
}

describe("DefaultProviderAuthService", () => {
  it("delegates auth start to the provider handler", async () => {
    const handler = makeDeviceHandler();
    const service = new DefaultProviderAuthService();

    const result = await service.startAuthFlow(handler);

    expect(handler.start).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      deviceCode: "dc_test",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 5,
    });
  });

  it("delegates redirect auth start with the redirect uri", async () => {
    const handler = makeRedirectHandler();
    const service = new DefaultProviderAuthService();

    const result = await service.startAuthFlow(handler, {
      redirectUri: "http://127.0.0.1:3100/admin",
      state: "oauth-state",
      codeChallenge: "pkce-challenge",
      codeChallengeMethod: "S256",
    });

    expect(handler.start).toHaveBeenCalledWith({
      redirectUri: "http://127.0.0.1:3100/admin",
      state: "oauth-state",
      codeChallenge: "pkce-challenge",
      codeChallengeMethod: "S256",
    });
    expect(result).toEqual({
      authorizationUrl: "https://gitlab.example.com/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A3100%2Fadmin&state=oauth-state&code_challenge=pkce-challenge&code_challenge_method=S256",
    });
  });

  it("encrypts the returned access token when completing auth", async () => {
    const encryptTokenFn = vi.fn(() => "enc_token");
    const handler = makeDeviceHandler();
    const service = new DefaultProviderAuthService({ encryptTokenFn });

    const result = await service.completeAuthFlow(
      handler,
      { deviceCode: "dc_test" },
      { adminAuthSecret: "super-secret" }
    );

    expect(handler.complete).toHaveBeenCalledWith({ deviceCode: "dc_test" });
    expect(encryptTokenFn).toHaveBeenCalledWith("ghu_test_token", "super-secret");
    expect(result).toEqual({ encryptedToken: "enc_token", isPlaintext: false });
  });

  it("rejects auth completion before token exchange when no admin secret is configured", async () => {
    const encryptTokenFn = vi.fn(() => "enc_token");
    const handler = makeDeviceHandler();
    const service = new DefaultProviderAuthService({ encryptTokenFn });

    await expect(service.completeAuthFlow(
      handler,
      { deviceCode: "dc_test" },
      { adminAuthSecret: undefined }
    )).rejects.toThrow("ADMIN_AUTH_SECRET");

    expect(handler.complete).not.toHaveBeenCalled();
    expect(encryptTokenFn).not.toHaveBeenCalled();
  });

  it("encrypts the returned token when completing redirect auth", async () => {
    const encryptTokenFn = vi.fn(() => "enc_redirect_token");
    const handler = makeRedirectHandler();
    const service = new DefaultProviderAuthService({ encryptTokenFn });

    const result = await service.completeAuthFlow(
      handler,
      {
        code: "oauth-code",
        redirectUri: "http://127.0.0.1:3100/admin",
        state: "oauth-state",
        codeVerifier: "pkce-verifier",
      },
      { adminAuthSecret: "super-secret" }
    );

    expect(handler.complete).toHaveBeenCalledWith({
      code: "oauth-code",
      redirectUri: "http://127.0.0.1:3100/admin",
      state: "oauth-state",
      codeVerifier: "pkce-verifier",
    });
    expect(encryptTokenFn).toHaveBeenCalledWith("gloauth_test_token", "super-secret");
    expect(result).toEqual({ encryptedToken: "enc_redirect_token", isPlaintext: false });
  });
});