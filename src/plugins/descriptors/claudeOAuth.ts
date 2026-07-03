/**
 * Claude (Anthropic) OAuth handler for the interactive subscription flow.
 *
 * Implements the authorization-code + PKCE (S256) redirect flow used by
 * Claude Code to authenticate Pro/Max subscription accounts. The resulting
 * `CLAUDE_CODE_OAUTH_TOKEN` is stored (encrypted) in the integration config
 * under `sessionToken`.
 *
 * NOTE: Anthropic does not publicly document third-party OAuth app
 * registration. The client id and endpoints below are the public Claude Code
 * values and are treated as best-effort defaults; each can be overridden via
 * the integration config (`oauthClientId`, `oauthAuthorizeUrl`,
 * `oauthTokenUrl`). Users who cannot complete the interactive flow can instead
 * paste a token produced by `claude setup-token`.
 */
import type {
  ProviderAuthRedirectCompleteInput,
  ProviderAuthRedirectStartInput,
  RedirectProviderAuthHandler,
} from "../../agents/providerAuthService.js";

/** Public Claude Code OAuth client id. Overridable via config.oauthClientId. */
export const CLAUDE_CODE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const CLAUDE_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_OAUTH_SCOPE = "org:create_api_key user:profile user:inference";

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Create the redirect (authorization-code + PKCE) OAuth handler for Claude subscriptions. */
export function createClaudeRedirectOAuthHandler(
  config?: Record<string, unknown>
): RedirectProviderAuthHandler {
  const resolved = config ?? {};
  const clientId = optionalString(resolved["oauthClientId"]) ?? CLAUDE_CODE_OAUTH_CLIENT_ID;
  const authorizeUrl = optionalString(resolved["oauthAuthorizeUrl"]) ?? CLAUDE_AUTHORIZE_URL;
  const tokenUrl = optionalString(resolved["oauthTokenUrl"]) ?? CLAUDE_TOKEN_URL;

  return {
    kind: "redirect",
    async start({
      redirectUri,
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
      redirectUri,
      state,
      codeVerifier,
    }: ProviderAuthRedirectCompleteInput): Promise<{ token: string }> {
      if (!codeVerifier) {
        throw new Error("Claude OAuth PKCE code verifier is required");
      }
      // Claude's OAuth callback may return the authorization code concatenated
      // with the state as `code#state`; the token endpoint only accepts the
      // bare code, so split it off defensively.
      const hashIndex = code.indexOf("#");
      const authCode = hashIndex >= 0 ? code.slice(0, hashIndex) : code;
      const response = await globalThis.fetch(tokenUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: clientId,
          code: authCode,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
          ...(state ? { state } : {}),
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
