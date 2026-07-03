import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import type { AdminUser, UserRole, UserSession } from "../interfaces.js";

/**
 * Admin session auth service — scrypt password hashing plus DB-backed opaque
 * bearer tokens with sliding expiry. Raw tokens are never persisted; only
 * their SHA-256 hex digest is stored in `user_sessions.token_hash`.
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_SALT_LENGTH = 32;
// 128 * N * r = 16 MiB for the default params; give scrypt ample headroom.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/**
 * `crypto.scrypt()` has accepted `{ N, r, p }` cost-parameter options since
 * Node.js 10.5.0 (in addition to the `cost`/`blockSize`/`parallelization`
 * aliases) — this codebase targets Node 22+ (see `Dockerfile.orchestrator`),
 * so the options are always supported. Still, verify against the RFC 7914
 * §12 test vector (`scrypt("", "", N=16, r=1, p=1, dkLen=64)`) once at module
 * load: this proves N/r/p are actually wired into the KDF rather than
 * silently ignored (which would quietly weaken every password hash).
 */
const RFC7914_TEST_VECTOR =
  "77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede2144" +
  "2fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906";

function assertScryptSupportsNrp(): void {
  const derived = scryptSync("", "", 64, { N: 16, r: 1, p: 1, maxmem: SCRYPT_MAXMEM });
  if (derived.toString("hex") !== RFC7914_TEST_VECTOR) {
    throw new Error(
      "crypto.scrypt() did not honor the N/r/p cost parameters as expected on this Node.js " +
      "runtime (RFC 7914 test vector mismatch). Password hashing requires a Node.js version " +
      "with full scrypt N/r/p option support (Node.js >= 10.5)."
    );
  }
}
assertScryptSupportsNrp();

/**
 * Idle session lifetime — refreshed on use (sliding expiry). Kept deliberately
 * short (12h) as XSS defense-in-depth: session tokens are held in the SPA's
 * sessionStorage, so a shorter window bounds how long an exfiltrated token is
 * usable. Active users are kept signed in via the sliding refresh below.
 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Only persist a sliding-expiry touch when the last one is older than this. */
const TOUCH_THROTTLE_MS = 60_000;

/** Authenticated request identity. `userId` is null for bootstrap actors (no users exist yet). */
export interface AuthContext {
  userId: string | null;
  username: string;
  role: UserRole;
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  params: { N: number; r: number; p: number }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM }, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(derivedKey);
    });
  });
}

/** Hash a password with scrypt into the `scrypt:N:r:p:saltB64:hashB64` format. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_LENGTH);
  const key = await scryptAsync(password, salt, SCRYPT_KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("base64")}:${key.toString("base64")}`;
}

/** Verify a password against a stored `scrypt:N:r:p:saltB64:hashB64` hash. */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n <= 1 || r <= 0 || p <= 0) {
    return false;
  }
  const salt = Buffer.from(parts[4] ?? "", "base64");
  const expected = Buffer.from(parts[5] ?? "", "base64");
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = await scryptAsync(password, salt, expected.length, { N: n, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** SHA-256 hex digest of a raw session token — the value stored in the DB. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Subset of the state store the auth service needs (satisfied by SqliteStateStore). */
export interface AdminAuthStateStore {
  getUserByUsername(username: string): Promise<AdminUser | null>;
  createSession(input: { tokenHash: string; userId: string; expiresAt: Date }): Promise<UserSession>;
  getSessionByTokenHash(tokenHash: string): Promise<(UserSession & { user: AdminUser }) | null>;
  touchSession(tokenHash: string, update: { lastSeenAt: Date; expiresAt: Date }): Promise<void>;
  deleteSessionByTokenHash(tokenHash: string): Promise<boolean>;
  purgeExpiredSessions(now: Date): Promise<number>;
}

export interface AdminAuthService {
  /** Null on unknown user, disabled user, or bad password. */
  login(username: string, password: string): Promise<{ token: string; user: { id: string; username: string; role: UserRole } } | null>;
  /** Resolve a bearer token to an AuthContext; refreshes sliding expiry (throttled). */
  validateSession(token: string): Promise<AuthContext | null>;
  /** Revoke the session behind the token; false when no such session existed. */
  logout(token: string): Promise<boolean>;
}

/** Create the admin session auth service over the given store. */
export function createAdminAuthService(deps: { stateStore: AdminAuthStateStore }): AdminAuthService {
  const { stateStore } = deps;

  return {
    async login(username, password): Promise<{ token: string; user: { id: string; username: string; role: UserRole } } | null> {
      const user = await stateStore.getUserByUsername(username);
      if (!user || !user.enabled) return null;
      if (!(await verifyPassword(password, user.passwordHash))) return null;
      const now = new Date();
      try {
        await stateStore.purgeExpiredSessions(now);
      } catch {
        // Opportunistic cleanup — a purge failure must not block login.
      }
      const token = randomBytes(32).toString("hex");
      await stateStore.createSession({
        tokenHash: hashSessionToken(token),
        userId: user.id,
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      });
      return { token, user: { id: user.id, username: user.username, role: user.role } };
    },

    async validateSession(token): Promise<AuthContext | null> {
      if (!token) return null;
      const tokenHash = hashSessionToken(token);
      const session = await stateStore.getSessionByTokenHash(tokenHash);
      if (!session) return null;
      const now = new Date();
      if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_THROTTLE_MS) {
        try {
          await stateStore.touchSession(tokenHash, {
            lastSeenAt: now,
            expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
          });
        } catch {
          // Sliding-expiry touch is best-effort; do not fail the request if it can't be persisted.
        }
      }
      return { userId: session.user.id, username: session.user.username, role: session.user.role };
    },

    async logout(token): Promise<boolean> {
      if (!token) return false;
      return stateStore.deleteSessionByTokenHash(hashSessionToken(token));
    },
  };
}
