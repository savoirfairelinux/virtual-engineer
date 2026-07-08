/**
 * In-memory brute-force protection for the unauthenticated admin auth
 * endpoints (`POST /api/admin/auth/login` and `POST /api/admin/auth/setup`).
 *
 * Tracks failed attempts per key (caller supplies one entry per client IP and
 * one per attempted username, so either axis can trigger a lockout) using a
 * sliding failure window plus exponential backoff once a threshold is
 * crossed. This is intentionally process-local (no shared store): the admin
 * server is a single Node process, and a restart resetting counters is an
 * acceptable trade-off for keeping this dependency-free.
 */

/** Failures allowed within {@link WINDOW_MS} before any lockout kicks in. */
const MAX_FAILURES_BEFORE_LOCKOUT = 5;
/** Failure count resets once this long has elapsed since the last failure. */
const WINDOW_MS = 15 * 60_000;
/** Initial lockout duration once the threshold is crossed. */
const BASE_LOCKOUT_MS = 30_000;
/** Lockout duration never exceeds this, no matter how many failures pile up. */
const MAX_LOCKOUT_MS = 15 * 60_000;
/** Entries idle longer than this are evicted on the next sweep to bound memory. */
const ENTRY_TTL_MS = 60 * 60_000;
/** Sweep stale entries at most this often. */
const SWEEP_INTERVAL_MS = 5 * 60_000;

interface RateLimitEntry {
  failures: number;
  lastFailureAt: number;
  lockedUntil: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Milliseconds the caller should wait before retrying; only set when `allowed` is false. */
  retryAfterMs?: number;
}

/**
 * Sliding-window, exponential-backoff limiter keyed by arbitrary strings
 * (e.g. `ip:1.2.3.4` and `user:alice`). Callers should check all relevant
 * keys before attempting auth and record the outcome against the same keys.
 */
export class LoginRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();
  private lastSweepAt = 0;

  /** Returns whether an attempt for `key` is currently allowed. */
  check(key: string, now: number = Date.now()): RateLimitDecision {
    this.maybeSweep(now);
    const entry = this.entries.get(key);
    if (!entry || now >= entry.lockedUntil) {
      return { allowed: true };
    }
    return { allowed: false, retryAfterMs: entry.lockedUntil - now };
  }

  /** Record a failed attempt for `key`, extending/creating a lockout past the threshold. */
  recordFailure(key: string, now: number = Date.now()): void {
    const existing = this.entries.get(key);
    const withinWindow = existing !== undefined && now - existing.lastFailureAt <= WINDOW_MS;
    const failures = (withinWindow ? existing.failures : 0) + 1;
    let lockedUntil = withinWindow ? existing.lockedUntil : 0;
    if (failures >= MAX_FAILURES_BEFORE_LOCKOUT) {
      const exponent = failures - MAX_FAILURES_BEFORE_LOCKOUT;
      const lockoutMs = Math.min(MAX_LOCKOUT_MS, BASE_LOCKOUT_MS * 2 ** exponent);
      lockedUntil = Math.max(lockedUntil, now + lockoutMs);
    }
    this.entries.set(key, { failures, lastFailureAt: now, lockedUntil });
  }

  /** Clear any tracked failures for `key` (call on successful auth). */
  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  /** Drop entries that have been idle long enough to no longer matter. */
  private maybeSweep(now: number): void {
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now;
    for (const [key, entry] of this.entries) {
      if (now - entry.lastFailureAt > ENTRY_TTL_MS && now >= entry.lockedUntil) {
        this.entries.delete(key);
      }
    }
  }
}

/** Best-effort client IP extraction (no proxy trust chain — single-hop deployments only). */
export function clientIpKey(remoteAddress: string | undefined): string {
  return `ip:${remoteAddress ?? "unknown"}`;
}

export function usernameKey(username: string): string {
  return `user:${username.toLowerCase()}`;
}
