import { createHash, randomBytes } from "node:crypto";
import type { AdminUser, UserRole, UserSession } from "../interfaces.js";
import { createLocalPasswordAuthenticator } from "./authentication/localPasswordAuthenticator.js";
import type { PasswordAuthenticator } from "./authentication/passwordAuthenticator.js";

export { hashPassword, verifyPassword } from "./authentication/passwordHash.js";

/**
 * Admin session auth service — delegates credential checks to a
 * `PasswordAuthenticator` and issues DB-backed opaque bearer tokens with
 * sliding expiry. Raw tokens are never persisted; only their SHA-256 hex
 * digest is stored in `user_sessions.token_hash`.
 */

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
  /** Null when the authenticator rejects the credentials. */
  login(username: string, password: string): Promise<AdminLoginSession | null>;
  /** Resolve a bearer token to an AuthContext; refreshes sliding expiry (throttled). */
  validateSession(token: string): Promise<AuthContext | null>;
  /** Revoke the session behind the token; false when no such session existed. */
  logout(token: string): Promise<boolean>;
}

export interface AdminLoginSession {
  token: string;
  user: { id: string; username: string; role: UserRole };
}

export interface AdminAuthServiceDeps {
  stateStore: AdminAuthStateStore;
  /** Defaults to verifying the scrypt hash stored on the local user row. */
  authenticator?: PasswordAuthenticator | undefined;
}

/** Create the admin session auth service over the given store. */
export function createAdminAuthService(deps: AdminAuthServiceDeps): AdminAuthService {
  const { stateStore } = deps;
  const authenticator = deps.authenticator ?? createLocalPasswordAuthenticator(stateStore);

  async function issueSession(user: AdminUser): Promise<AdminLoginSession> {
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
  }

  return {
    async login(username, password): Promise<AdminLoginSession | null> {
      const outcome = await authenticator.authenticate(username, password);
      if (outcome.status !== "authenticated") return null;
      return issueSession(outcome.user);
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
