import { describe, expect, it } from "vitest";
import { LoginRateLimiter, clientIpKey, usernameKey } from "../../src/admin/loginRateLimiter.js";

describe("LoginRateLimiter", () => {
  it("allows attempts before the failure threshold is reached", () => {
    const limiter = new LoginRateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) {
      limiter.recordFailure("user:alice", now);
    }
    expect(limiter.check("user:alice", now)).toEqual({ allowed: true });
  });

  it("locks out after the failure threshold and reports retryAfterMs", () => {
    const limiter = new LoginRateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) {
      limiter.recordFailure("user:alice", now);
    }
    const decision = limiter.check("user:alice", now);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBeGreaterThan(0);
  });

  it("uses exponential backoff for repeated failures past the threshold", () => {
    const limiter = new LoginRateLimiter();
    let now = 1_000_000;
    for (let i = 0; i < 5; i++) limiter.recordFailure("user:alice", now);
    const firstLockout = limiter.check("user:alice", now).retryAfterMs ?? 0;

    // Wait past the first lockout, then fail once more — backoff should grow.
    now += firstLockout + 1;
    limiter.recordFailure("user:alice", now);
    const secondLockout = limiter.check("user:alice", now).retryAfterMs ?? 0;
    expect(secondLockout).toBeGreaterThan(firstLockout);
  });

  it("caps the lockout duration", () => {
    const limiter = new LoginRateLimiter();
    let now = 1_000_000;
    for (let i = 0; i < 5; i++) limiter.recordFailure("user:alice", now);
    for (let i = 0; i < 20; i++) {
      const retry = limiter.check("user:alice", now).retryAfterMs ?? 0;
      now += retry + 1;
      limiter.recordFailure("user:alice", now);
    }
    const decision = limiter.check("user:alice", now);
    expect(decision.retryAfterMs).toBeLessThanOrEqual(15 * 60_000);
  });

  it("resets the failure count once the sliding window has elapsed", () => {
    const limiter = new LoginRateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) limiter.recordFailure("user:alice", now);
    // Well past the 15-minute window — failures should not accumulate with earlier ones.
    const later = now + 16 * 60_000;
    limiter.recordFailure("user:alice", later);
    expect(limiter.check("user:alice", later)).toEqual({ allowed: true });
  });

  it("clears tracked failures on success", () => {
    const limiter = new LoginRateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) limiter.recordFailure("user:alice", now);
    expect(limiter.check("user:alice", now).allowed).toBe(false);
    limiter.recordSuccess("user:alice");
    expect(limiter.check("user:alice", now)).toEqual({ allowed: true });
  });

  it("tracks independent keys separately", () => {
    const limiter = new LoginRateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) limiter.recordFailure("user:alice", now);
    expect(limiter.check("user:alice", now).allowed).toBe(false);
    expect(limiter.check("user:bob", now).allowed).toBe(true);
    expect(limiter.check("ip:1.2.3.4", now).allowed).toBe(true);
  });
});

describe("clientIpKey / usernameKey", () => {
  it("builds distinguishable, normalized keys", () => {
    expect(clientIpKey("127.0.0.1")).toBe("ip:127.0.0.1");
    expect(clientIpKey(undefined)).toBe("ip:unknown");
    expect(usernameKey("Alice")).toBe("user:alice");
    expect(usernameKey("alice")).toBe(usernameKey("Alice"));
  });
});
