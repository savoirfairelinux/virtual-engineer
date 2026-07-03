import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createClaudeRedirectOAuthHandler,
  CLAUDE_CODE_OAUTH_CLIENT_ID,
} from "../../src/plugins/descriptors/claudeOAuth.js";

const REDIRECT_URI = "http://127.0.0.1:3100/api/admin/plugins/claude/oauth/callback";
/** Anthropic's fixed manual-code callback page (the handler ignores the caller's redirectUri). */
const CLAUDE_MANUAL_REDIRECT = "https://console.anthropic.com/oauth/code/callback";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createClaudeRedirectOAuthHandler", () => {
  it("builds an authorization URL with PKCE + code=true and Anthropic's fixed redirect URI", async () => {
    const handler = createClaudeRedirectOAuthHandler();
    const { authorizationUrl } = await handler.start({
      redirectUri: REDIRECT_URI,
      state: "st",
      codeChallenge: "chal",
      codeChallengeMethod: "S256",
    });
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://claude.ai/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(CLAUDE_CODE_OAUTH_CLIENT_ID);
    // The caller-supplied redirectUri is ignored in favour of Anthropic's fixed callback.
    expect(url.searchParams.get("redirect_uri")).toBe(CLAUDE_MANUAL_REDIRECT);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code")).toBe("true");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("st");
  });

  it("requires a PKCE code challenge with S256", async () => {
    const handler = createClaudeRedirectOAuthHandler();
    await expect(
      handler.start({ redirectUri: REDIRECT_URI, codeChallengeMethod: "S256" })
    ).rejects.toThrow(/code challenge/i);
    await expect(
      handler.start({ redirectUri: REDIRECT_URI, codeChallenge: "chal", codeChallengeMethod: "plain" })
    ).rejects.toThrow(/S256/);
  });

  it("exchanges the authorization code for an access token", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ access_token: "sk-ant-oat-xyz" }), { status: 200 }));
    const handler = createClaudeRedirectOAuthHandler();
    const { token } = await handler.complete({
      code: "auth-code",
      redirectUri: REDIRECT_URI,
      codeVerifier: "verifier",
    });
    expect(token).toBe("sk-ant-oat-xyz");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://console.anthropic.com/v1/oauth/token");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      grant_type: "authorization_code",
      code: "auth-code",
      code_verifier: "verifier",
      client_id: CLAUDE_CODE_OAUTH_CLIENT_ID,
      redirect_uri: CLAUDE_MANUAL_REDIRECT,
    });
  });

  it("requires a code verifier on completion", async () => {
    const handler = createClaudeRedirectOAuthHandler();
    await expect(
      handler.complete({ code: "c", redirectUri: REDIRECT_URI })
    ).rejects.toThrow(/code verifier/i);
  });

  it("strips a trailing #state fragment from the authorization code before exchange", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ access_token: "sk-ant-oat-1" }), { status: 200 }));
    const handler = createClaudeRedirectOAuthHandler();
    await handler.complete({
      code: "the-code#the-state",
      redirectUri: REDIRECT_URI,
      codeVerifier: "verifier",
    });
    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.code).toBe("the-code");
    // The state embedded after the '#' is used for the exchange when not passed explicitly.
    expect(body.state).toBe("the-state");
  });

  it("throws when the token response lacks an access_token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const handler = createClaudeRedirectOAuthHandler();
    await expect(
      handler.complete({ code: "c", redirectUri: REDIRECT_URI, codeVerifier: "v" })
    ).rejects.toThrow(/access_token/);
  });
});
