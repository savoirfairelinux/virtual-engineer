/**
 * Claude (Anthropic) OAuth handler for the interactive subscription flow.
 *
 * Implements the authorization-code + PKCE (S256) "manual code" flow used by
 * Claude Code to authenticate Pro/Max subscription accounts:
 *   1. VE builds an authorization link (fixed Anthropic redirect URI + `code=true`).
 *   2. The user opens it, signs in, and Anthropic shows an authorization code
 *      (returned as `code#state`) on its own callback page.
 *   3. The user pastes that code back; VE exchanges it (with the PKCE verifier)
 *      for a `CLAUDE_CODE_OAUTH_TOKEN`, stored encrypted under `sessionToken`.
 *
 * The redirect URI is Anthropic's fixed manual-callback page — NOT VE's admin
 * app — because Anthropic's public Claude Code OAuth client only accepts its
 * own callback. The client id and endpoints are the fixed public Claude Code
 * values and are intentionally NOT overridable from request/config input, so a
 * malicious/misconfigured config cannot redirect the authorization code + PKCE
 * verifier to an attacker-controlled host (SSRF / credential redirection).
 */
import type {
  ProviderAuthRedirectCompleteInput,
  ProviderAuthRedirectStartInput,
  RedirectProviderAuthHandler,
} from "../../agents/providerAuthService.js";

/** Public Claude Code OAuth client id (fixed). */
export const CLAUDE_CODE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/** claude.ai authorize endpoint (Pro/Max subscription sign-in). */
const CLAUDE_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
/** Claude Code token endpoint. */
const CLAUDE_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
/** Fixed Anthropic manual-code callback page — the user copies the code shown here. */
const CLAUDE_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const CLAUDE_OAUTH_SCOPE = "org:create_api_key user:profile user:inference";
/** Required beta header for the Claude Code OAuth token endpoint. */
const CLAUDE_OAUTH_BETA_HEADER = "oauth-2025-04-20";

/**
 * Create the redirect (authorization-code + PKCE) OAuth handler for Claude
 * subscriptions. All endpoints/client id are fixed public Claude Code values;
 * `_config` is accepted for interface parity but intentionally ignored so the
 * token-exchange target cannot be redirected by request input.
 */
export function createClaudeRedirectOAuthHandler(
  _config?: Record<string, unknown>
): RedirectProviderAuthHandler {
  const clientId = CLAUDE_CODE_OAUTH_CLIENT_ID;
  const authorizeUrl = CLAUDE_AUTHORIZE_URL;
  const tokenUrl = CLAUDE_TOKEN_URL;
  const redirectUri = CLAUDE_REDIRECT_URI;

  return {
    kind: "redirect",
    async start({
      state,
      codeChallenge,
      codeChallengeMethod,
    }: ProviderAuthRedirectStartInput): Promise<{ authorizationUrl: string }> {
      if (!codeChallenge) {
        throw new Error("Claude OAuth PKCE code challenge is required");
      }
      if (codeChallengeMethod !== "S256") {
        throw new Error("Claude OAuth PKCE requires codeChallengeMethod=S256");
      }
      const url = new URL(authorizeUrl);
      // `code=true` tells Anthropic to render the authorization code on the
      // callback page for manual copy instead of auto-posting it to an app.
      url.searchParams.set("code", "true");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", CLAUDE_OAUTH_SCOPE);
      if (state) {
        url.searchParams.set("state", state);
      }
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", codeChallengeMethod);
      return { authorizationUrl: url.toString() };
    },
    async complete({
      code,
      state,
      codeVerifier,
    }: ProviderAuthRedirectCompleteInput): Promise<{ token: string }> {
      if (!codeVerifier) {
        throw new Error("Claude OAuth PKCE code verifier is required");
      }
      // Anthropic's callback returns the code as `code#state`; the token
      // endpoint only accepts the bare code, and the state after the `#` can be
      // used when the caller did not pass one explicitly.
      const hashIndex = code.indexOf("#");
      const authCode = hashIndex >= 0 ? code.slice(0, hashIndex) : code;
      const pastedState = hashIndex >= 0 ? code.slice(hashIndex + 1) : undefined;
      const effectiveState = state ?? pastedState;
      const response = await globalThis.fetch(tokenUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "anthropic-beta": CLAUDE_OAUTH_BETA_HEADER,
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: clientId,
          code: authCode,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
          ...(effectiveState ? { state: effectiveState } : {}),
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => `HTTP ${response.status}`);
        throw new Error(`Claude OAuth token exchange failed: ${errorBody}`);
      }

      const rawPayload = await response.json().catch(() => ({}));
      const payload =
        typeof rawPayload === "object" && rawPayload !== null
          ? (rawPayload as Record<string, unknown>)
          : {};
      const accessToken =
        typeof payload["access_token"] === "string" ? payload["access_token"] : undefined;
      if (!accessToken) {
        throw new Error("Claude OAuth token exchange failed: missing access_token");
      }
      return { token: accessToken };
    },
  };
}
