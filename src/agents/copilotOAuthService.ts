/**
 * GitHub OAuth Device Flow for Copilot authentication.
 *
 * Implements the device authorization grant (RFC 8628) against GitHub's OAuth
 * endpoints using the public Copilot client ID. The flow produces a `ghu_...`
 * user access token that can be exchanged for a Copilot session token.
 */

import { getLogger } from "../logger.js";

const log = getLogger("copilot-oauth");

/** Public GitHub OAuth client ID for Copilot (VS Code). */
const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const REQUIRED_SCOPES = "read:user";

export interface DeviceFlowResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface OAuthServiceDependencies {
  fetch?: typeof globalThis.fetch | undefined;
}

/**
 * Start the GitHub device authorization flow.
 * Returns the device code + user code for the caller to display.
 */
export async function startDeviceFlow(
  deps: OAuthServiceDependencies = {},
): Promise<DeviceFlowResponse> {
  const fetchFn = deps.fetch ?? globalThis.fetch;

  log.info("starting GitHub OAuth device flow");

  const res = await fetchFn(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: REQUIRED_SCOPES,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub device code request failed: HTTP ${res.status} — ${text}`);
  }

  const data = (await res.json()) as Record<string, unknown>;

  const deviceCode = data["device_code"];
  const userCode = data["user_code"];
  const verificationUri = data["verification_uri"];
  const expiresIn = data["expires_in"];
  const interval = data["interval"];

  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string" ||
    typeof expiresIn !== "number" ||
    typeof interval !== "number"
  ) {
    throw new Error("GitHub device code response missing required fields");
  }

  log.info({ userCode, verificationUri, expiresIn }, "device flow started — waiting for user authorization");

  return { deviceCode, userCode, verificationUri, expiresIn, interval };
}

export interface PollTokenResult {
  accessToken: string;
  tokenType: string;
  scope: string;
}

/**
 * Poll GitHub for the access token after the user has entered the device code.
 * Respects the `interval` from the device code response.
 * Returns the OAuth access token (`ghu_...`).
 */
export async function pollForAccessToken(
  deviceCode: string,
  deps: OAuthServiceDependencies = {},
): Promise<PollTokenResult> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const interval = 5; // seconds (GitHub default)
  const maxAttempts = 360; // 30 minutes max

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await delay(interval * 1000);

    const res = await fetchFn(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    if (!res.ok) {
      throw new Error(`GitHub token poll failed: HTTP ${res.status}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    const error = data["error"];

    if (error === "authorization_pending") {
      continue;
    }
    if (error === "slow_down") {
      await delay(5000); // extra backoff
      continue;
    }
    if (error === "expired_token") {
      throw new DeviceFlowExpiredError("Device code expired — user did not authorize in time");
    }
    if (error === "access_denied") {
      throw new DeviceFlowDeniedError("User denied the authorization request");
    }
    if (error) {
      throw new Error(`GitHub OAuth error: ${String(error)}`);
    }

    const accessToken = data["access_token"];
    const tokenType = data["token_type"];
    const scope = data["scope"];

    if (typeof accessToken !== "string" || !accessToken) {
      throw new Error("GitHub token response missing access_token");
    }

    log.info("GitHub OAuth device flow completed successfully");

    return {
      accessToken,
      tokenType: typeof tokenType === "string" ? tokenType : "bearer",
      scope: typeof scope === "string" ? scope : "",
    };
  }

  throw new DeviceFlowExpiredError("Device flow polling timed out after max attempts");
}

export class DeviceFlowExpiredError extends Error {
  override readonly name = "DeviceFlowExpiredError";
}

export class DeviceFlowDeniedError extends Error {
  override readonly name = "DeviceFlowDeniedError";
}

/** Return a promise that resolves after the specified number of milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
