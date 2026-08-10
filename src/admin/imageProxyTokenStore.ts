import { createHash, randomBytes } from "node:crypto";

/**
 * Short-lived, single-use tokens for the image proxy — distinct from session
 * tokens so the value that ever appears in a URL query string (`?t=`) is
 * never the long-lived bearer session token. Minting requires an already
 * authenticated request; this store only tracks validity, not identity.
 */

export const IMAGE_PROXY_TOKEN_TTL_MS = 60_000;

interface TokenEntry {
  expiresAt: number;
}

const tokens = new Map<string, TokenEntry>();

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function pruneExpired(now: number): void {
  for (const [hash, entry] of tokens) {
    if (entry.expiresAt <= now) tokens.delete(hash);
  }
}

/** Mint a new image-proxy token, valid once within `IMAGE_PROXY_TOKEN_TTL_MS`. */
export function mintImageProxyToken(): { token: string; expiresAt: number } {
  const now = Date.now();
  pruneExpired(now);
  const token = randomBytes(32).toString("hex");
  const expiresAt = now + IMAGE_PROXY_TOKEN_TTL_MS;
  tokens.set(hashToken(token), { expiresAt });
  return { token, expiresAt };
}

/** Consume a token (single-use). Returns true only if it existed and had not expired. */
export function consumeImageProxyToken(rawToken: string): boolean {
  if (!rawToken || !/^[0-9a-f]{64}$/.test(rawToken)) return false;
  const hash = hashToken(rawToken);
  const entry = tokens.get(hash);
  tokens.delete(hash);
  return entry !== undefined && entry.expiresAt > Date.now();
}

/** Test-only reset so token state doesn't leak across test files. */
export function clearImageProxyTokensForTests(): void {
  tokens.clear();
}
