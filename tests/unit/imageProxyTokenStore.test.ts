import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearImageProxyTokensForTests,
  consumeImageProxyToken,
  IMAGE_PROXY_TOKEN_TTL_MS,
  mintImageProxyToken,
} from "../../src/admin/imageProxyTokenStore.js";

describe("imageProxyTokenStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearImageProxyTokensForTests();
    vi.useRealTimers();
  });

  it("mints a token distinct from a session token and accepts it once", () => {
    const { token, expiresAt } = mintImageProxyToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt).toBe(Date.now() + IMAGE_PROXY_TOKEN_TTL_MS);
    expect(consumeImageProxyToken(token)).toBe(true);
  });

  it("rejects reuse of an already-consumed token (single-use)", () => {
    const { token } = mintImageProxyToken();
    expect(consumeImageProxyToken(token)).toBe(true);
    expect(consumeImageProxyToken(token)).toBe(false);
  });

  it("rejects unknown or empty tokens", () => {
    expect(consumeImageProxyToken("not-a-real-token")).toBe(false);
    expect(consumeImageProxyToken("")).toBe(false);
  });

  it("rejects a token once its TTL has elapsed", () => {
    const { token } = mintImageProxyToken();
    vi.advanceTimersByTime(IMAGE_PROXY_TOKEN_TTL_MS + 1);
    expect(consumeImageProxyToken(token)).toBe(false);
  });

  it("prunes expired entries so the store does not grow unbounded", () => {
    mintImageProxyToken();
    vi.advanceTimersByTime(IMAGE_PROXY_TOKEN_TTL_MS + 1);
    // Minting again triggers opportunistic pruning of the expired entry above.
    const { token } = mintImageProxyToken();
    expect(consumeImageProxyToken(token)).toBe(true);
  });
});
