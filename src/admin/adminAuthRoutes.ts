import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getLogger } from "../logger.js";
import type { AdminUser, UserRole } from "../interfaces.js";
import { writeJson, readBody, toIsoTimestamp, parseNonNegativeInt, requireStore } from "./adminRouteUtils.js";
import type { Router } from "./router.js";
import { hashPassword, verifyPassword, type AdminAuthService } from "./adminAuthService.js";
import { getAuthContext, getEffectivePermissions } from "./authContext.js";
import { serializeEffectivePermissions } from "./authorization/policyEngine.js";
import { recordAudit, UNAUTHENTICATED_ACTOR_NAME } from "./adminAudit.js";
import { LoginRateLimiter, clientIpKey, usernameKey } from "./loginRateLimiter.js";
import { getPasswordStrength } from "./commonPasswords.js";
import type { DirectoryAccountResolution, DirectoryAccountResolver } from "./authentication/directoryAuthenticator.js";
import { normalizeUsername } from "./authentication/username.js";
import type { AuthSourceRecord } from "../state/stores/authSourceStore.js";
import type { UserIdentityRecord, UserIdentityStoreApi } from "../state/stores/userIdentityStore.js";
import type { DirectoryGroupStoreApi } from "../state/stores/directoryGroupStore.js";

const log = getLogger("admin-auth");

const VALID_ROLES: readonly UserRole[] = ["admin", "operator", "viewer"];
const MIN_PASSWORD_LENGTH = 8;
const DEFAULT_USERS_LIMIT = 50;
const MAX_USERS_LIMIT = 200;

/**
 * Validate a candidate password against the minimum-length and common-password
 * policies. Returns an error message when rejected, or `null` when acceptable.
 */
function validatePasswordStrength(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (getPasswordStrength(password) === "weak") {
    return "password is too weak; mix uppercase letters, numbers, or symbols";
  }
  return null;
}

/**
 * Extract the client IP for rate-limiting purposes.
 *
 * By default (`trustProxy = false`) uses the raw socket address — safe for
 * the standard loopback-bound deployment (`ADMIN_API_HOST = 127.0.0.1`).
 * When `trustProxy = true` the first entry of `X-Forwarded-For` is used so
 * per-client rate-limiting works correctly behind a trusted reverse proxy.
 * Only enable trust-proxy mode when you control the upstream proxy; a
 * publicly reachable header lets clients spoof their IP and defeat limits.
 */
function requestIp(req: IncomingMessage, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    const first = raw?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? undefined;
}

function writeRateLimited(res: ServerResponse, retryAfterMs: number): void {
  res.setHeader("retry-after", String(Math.ceil(retryAfterMs / 1000)));
  writeJson(res, 429, { error: "Too many attempts. Try again later." });
}

/** Subset of user-store methods needed by the auth routes (satisfied by SqliteStateStore). */
export interface AuthRouteUserStore {
  createUser(input: { id: string; username: string; passwordHash: string; role: UserRole; enabled?: boolean }): Promise<AdminUser>;
  createInitialAdmin?: ((input: { id: string; username: string; passwordHash: string }) => Promise<AdminUser>) | undefined;
  getUserById(id: string): Promise<AdminUser | null>;
  listUsers(): Promise<AdminUser[]>;
  /** Rejects with `LAST_ADMIN` / `LAST_LOCAL_ADMIN` instead of removing the last (local) admin. */
  updateUser(id: string, partial: { role?: UserRole; enabled?: boolean }): Promise<AdminUser | null>;
  updateUserPassword(id: string, passwordHash: string): Promise<boolean>;
  /** Same last-admin guards as `updateUser`. */
  deleteUser(id: string): Promise<boolean>;
  countUsers(): Promise<number>;
  deleteSessionsForUser(userId: string): Promise<number>;
}

/** Subset of audit-store methods needed by the auth routes. */
export interface AuthRouteAuditStore {
  appendAuditEntry(input: {
    actorUserId?: string | null;
    actorName: string;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    details?: Record<string, unknown>;
  }): Promise<unknown>;
}

/** Directory-link surface; absent when the store predates `user_identities`. */
export type AuthRouteIdentityStore = Pick<
  UserIdentityStoreApi,
  | "getUserIdentityByUserId"
  | "listUserIdentities"
  | "createExternalUser"
  | "linkUserIdentity"
  | "unlinkUserIdentity"
> & Pick<DirectoryGroupStoreApi, "replaceIdentityGroups"> & {
  listAuthSources(): Promise<AuthSourceRecord[]>;
};

export interface AuthRouteDeps {
  userStore?: AuthRouteUserStore | undefined;
  auditStore?: AuthRouteAuditStore | undefined;
  authService?: AdminAuthService | undefined;
  identityStore?: AuthRouteIdentityStore | undefined;
  directoryAccounts?: DirectoryAccountResolver | undefined;
  credentialEncryptionConfigured: boolean;
  /** Invalidates the server-level users-exist cache after setup / user create / delete. */
  onUsersChanged?: (() => void) | undefined;
  /**
   * Called after a user is created via `POST /api/admin/users`, to bind the
   * role's default PBAC policy bundle. No-op when PBAC is unavailable.
   */
  onUserCreated?: ((userId: string, role: UserRole) => Promise<void>) | undefined;
  /**
   * When `true`, extract the client IP from `X-Forwarded-For` (first entry)
   * instead of the raw socket address. Safe only when a trusted reverse proxy
   * sits in front of the admin server; leave `false` (default) for the
   * standard loopback-bound deployment. Mirrors `ADMIN_TRUST_PROXY` in config.
   */
  trustProxy?: boolean | undefined;
}

function serializeUser(
  user: AdminUser,
  identity: UserIdentityRecord | null = null,
  sourceNames: ReadonlyMap<string, string> = new Map()
): Record<string, unknown> {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    enabled: user.enabled,
    authSource: identity
      ? {
          id: identity.authSourceId,
          name: sourceNames.get(identity.authSourceId) ?? identity.authSourceId,
          externalUsername: identity.externalUsername,
          lastLoginAt: identity.lastLoginAt ? toIsoTimestamp(identity.lastLoginAt) : null,
        }
      : null,
    createdAt: toIsoTimestamp(user.createdAt),
    updatedAt: toIsoTimestamp(user.updatedAt),
  };
}

function hasErrorCode(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && (err as { code?: unknown }).code === code;
}

/** Map the store's last-admin guards to 409; returns true when one was written. */
function writeLastAdminConflict(res: ServerResponse, err: unknown, action: string): boolean {
  if (hasErrorCode(err, "LAST_ADMIN")) {
    writeJson(res, 409, { error: `Cannot ${action} the last enabled admin` });
    return true;
  }
  if (hasErrorCode(err, "LAST_LOCAL_ADMIN")) {
    writeJson(res, 409, { error: `Cannot ${action} the last enabled local admin; keep one password account for directory outages` });
    return true;
  }
  return false;
}

/** Map a failed directory lookup to its HTTP response; returns true when one was written. */
function writeDirectoryLookupFailure(res: ServerResponse, lookup: DirectoryAccountResolution, externalUsername: string): boolean {
  switch (lookup.status) {
    case "found":
      return false;
    case "source_not_found":
      writeJson(res, 400, { error: "Authentication source not found" });
      return true;
    case "not_found":
      writeJson(res, 400, { error: `No directory account matches "${externalUsername}"` });
      return true;
    case "ambiguous":
      writeJson(res, 400, { error: `More than one directory account matches "${externalUsername}"; tighten the user filter` });
      return true;
    case "unavailable":
      writeJson(res, 502, { error: `Directory lookup failed: ${lookup.error}` });
      return true;
  }
}

function extractBearerToken(req: IncomingMessage): string | null {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function isDuplicateError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code?: unknown }).code === "DUPLICATE";
}

function isSetupAlreadyCompletedError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code?: unknown }).code === "SETUP_ALREADY_COMPLETED";
}

function validateCredentials(body: Record<string, unknown> | null): { username: string; password: string } | { error: string } {
  const rawUsername = typeof body?.["username"] === "string" ? body["username"] : "";
  const username = normalizeUsername(rawUsername);
  const password = typeof body?.["password"] === "string" ? body["password"] : "";
  if (username.length === 0) return { error: "username must be a non-empty string" };
  const passwordError = validatePasswordStrength(password);
  if (passwordError) return { error: passwordError };
  return { username, password };
}

/** Register auth + user-management routes on the given router. */
export function registerAuthRoutes(router: Router, deps: AuthRouteDeps): void {
  // Scoped to this registration (one per running admin server) rather than module-level,
  // so distinct server instances (e.g. one per test) don't share brute-force lockout state.
  const loginRateLimiter = new LoginRateLimiter();
  const trustProxy = deps.trustProxy ?? false;

  /**
   * Check the per-IP and per-username rate limits for an auth attempt. Returns
   * the blocking decision (with the longer `retryAfterMs` of the two) or
   * `null` when the attempt may proceed. When blocked, `firstBlocked` is true
   * only when this is the first blocked attempt of the current lockout
   * episode on either axis — callers audit the episode exactly once.
   */
  function checkRateLimit(req: IncomingMessage, username: string): { retryAfterMs: number; firstBlocked: boolean } | null {
    const now = Date.now();
    const ipDecision = loginRateLimiter.check(clientIpKey(requestIp(req, trustProxy)), now);
    const userDecision = loginRateLimiter.check(usernameKey(username), now);
    const blocked = [ipDecision, userDecision].filter((d) => !d.allowed);
    if (blocked.length === 0) return null;
    const retryAfterMs = Math.max(...blocked.map((d) => d.retryAfterMs ?? 0));
    const firstBlocked = blocked.some((d) => d.firstBlocked === true);
    return { retryAfterMs, firstBlocked };
  }

  function recordAuthFailure(req: IncomingMessage, username: string): void {
    const now = Date.now();
    loginRateLimiter.recordFailure(clientIpKey(requestIp(req, trustProxy)), now);
    loginRateLimiter.recordFailure(usernameKey(username), now);
  }

  function recordAuthSuccess(req: IncomingMessage, username: string): void {
    loginRateLimiter.recordSuccess(clientIpKey(requestIp(req, trustProxy)));
    loginRateLimiter.recordSuccess(usernameKey(username));
  }

  // Public — used by the SPA to decide between the setup screen and the login form.
  router.add("GET", "/api/admin/auth/setup-status", async (_req, res, _params) => {
    const needsSetup = deps.userStore ? (await deps.userStore.countUsers()) === 0 : false;
    writeJson(res, 200, {
      needsSetup,
      credentialEncryptionConfigured: needsSetup && deps.credentialEncryptionConfigured,
    });
  });

  // Bootstrap — unauthenticated while zero users exist; the route handler enforces that invariant.
  router.add("POST", "/api/admin/auth/setup", async (req, res, _params) => {
    if (!requireStore(deps.userStore, res, "User store not available")) return;
    if (!requireStore(deps.authService, res, "Auth service not available")) return;
    if ((await deps.userStore.countUsers()) > 0) {
      writeJson(res, 403, { error: "Setup already completed" });
      return;
    }
    const body = await readBody(req);
    const credentials = validateCredentials(body);
    if ("error" in credentials) {
      writeJson(res, 400, { error: credentials.error });
      return;
    }
    const limited = checkRateLimit(req, credentials.username);
    if (limited) {
      if (limited.firstBlocked) {
        recordAudit(deps.auditStore, req, {
          action: "auth.setup_rate_limited",
          targetType: "user",
          // No identity was verified on a blocked attempt; the bootstrap
          // pre-stamp would misattribute it.
          actor: { userId: null, username: UNAUTHENTICATED_ACTOR_NAME },
          details: {
            username: credentials.username,
            sourceIp: requestIp(req, trustProxy),
            retryAfterMs: limited.retryAfterMs,
          },
        });
      }
      writeRateLimited(res, limited.retryAfterMs);
      return;
    }
    const passwordHash = await hashPassword(credentials.password);
    let user: AdminUser;
    try {
      user = deps.userStore.createInitialAdmin
        ? await deps.userStore.createInitialAdmin({
            id: randomUUID(),
            username: credentials.username,
            passwordHash,
          })
        // Compatibility for structural test doubles predating createInitialAdmin.
        // SqliteStateStore always uses the atomic operation above.
        : await deps.userStore.createUser({
            id: randomUUID(),
            username: credentials.username,
            passwordHash,
            role: "admin",
          });
    } catch (err: unknown) {
      if (isSetupAlreadyCompletedError(err)) {
        writeJson(res, 403, { error: "Setup already completed" });
        return;
      }
      if (isDuplicateError(err)) {
        recordAuthFailure(req, credentials.username);
        writeJson(res, 409, { error: `Username "${credentials.username}" is already taken` });
        return;
      }
      throw err;
    }
    deps.onUsersChanged?.();
    const login = await deps.authService.login(credentials.username, credentials.password);
    if (login.status !== "ok") {
      writeJson(res, 500, { error: "Failed to establish session after setup" });
      return;
    }
    recordAuthSuccess(req, credentials.username);
    recordAudit(deps.auditStore, req, {
      action: "auth.setup",
      targetType: "user",
      targetId: user.id,
      actor: { userId: user.id, username: user.username },
      details: { username: user.username, role: user.role, sourceIp: requestIp(req, trustProxy) },
    });
    log.info({ username: user.username }, "first admin user created via setup");
    writeJson(res, 201, login.session);
  });

  // Public — username + password login.
  router.add("POST", "/api/admin/auth/login", async (req, res, _params) => {
    if (!requireStore(deps.authService, res, "Auth service not available")) return;
    const body = await readBody(req);
    const rawUsername = typeof body?.["username"] === "string" ? body["username"] : "";
    const username = normalizeUsername(rawUsername);
    const password = typeof body?.["password"] === "string" ? body["password"] : "";
    if (!username || !password) {
      writeJson(res, 400, { error: "username and password are required" });
      return;
    }
    const limited = checkRateLimit(req, username);
    if (limited) {
      if (limited.firstBlocked) {
        recordAudit(deps.auditStore, req, {
          action: "auth.login_rate_limited",
          targetType: "user",
          details: {
            username,
            sourceIp: requestIp(req, trustProxy),
            retryAfterMs: limited.retryAfterMs,
          },
        });
      }
      writeRateLimited(res, limited.retryAfterMs);
      return;
    }
    const login = await deps.authService.login(username, password);
    if (login.status === "unavailable") {
      // Not a credential failure: no directory answered, so the rate limiter is untouched.
      recordAudit(deps.auditStore, req, {
        action: "auth.login_unavailable",
        targetType: "user",
        details: { username, sourceIp: requestIp(req, trustProxy) },
      });
      writeJson(res, 503, { error: "Sign-in is temporarily unavailable because the directory could not be reached. Try again later." });
      return;
    }
    if (login.status === "rejected") {
      recordAuthFailure(req, username);
      recordAudit(deps.auditStore, req, {
        action: "auth.login_failed",
        targetType: "user",
        details: { username, sourceIp: requestIp(req, trustProxy) },
      });
      writeJson(res, 401, { error: "Invalid username or password" });
      return;
    }
    const { session } = login;
    recordAuthSuccess(req, username);
    if (login.provisioned) {
      deps.onUsersChanged?.();
      recordAudit(deps.auditStore, req, {
        action: "user.provision",
        targetType: "user",
        targetId: session.user.id,
        actor: { userId: session.user.id, username: session.user.username },
        details: { username: session.user.username, role: session.user.role, authSourceId: login.authSourceId },
      });
    }
    recordAudit(deps.auditStore, req, {
      action: "auth.login",
      targetType: "user",
      targetId: session.user.id,
      actor: { userId: session.user.id, username: session.user.username },
      details: {
        username: session.user.username,
        sourceIp: requestIp(req, trustProxy),
        ...(login.authSourceId !== null ? { authSourceId: login.authSourceId } : {}),
      },
    });
    writeJson(res, 200, session);
  });

  router.add("POST", "/api/admin/auth/logout", async (req, res, _params) => {
    const token = extractBearerToken(req);
    const revoked = token && deps.authService ? await deps.authService.logout(token) : false;
    if (revoked) {
      recordAudit(deps.auditStore, req, { action: "auth.logout", targetType: "user" });
    }
    res.statusCode = 204;
    res.end();
  }, { authenticated: true });

  router.add("GET", "/api/admin/auth/me", async (req, res, _params) => {
    const context = getAuthContext(req);
    if (!context) {
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }
    const perms = getEffectivePermissions(req);
    const identity = context.userId !== null && deps.identityStore
      ? await deps.identityStore.getUserIdentityByUserId(context.userId)
      : null;
    const source = identity
      ? (await deps.identityStore?.listAuthSources())?.find((candidate) => candidate.id === identity.authSourceId)
      : undefined;
    writeJson(res, 200, {
      id: context.userId,
      username: context.username,
      role: context.role,
      authSource: identity ? { id: identity.authSourceId, name: source?.name ?? identity.authSourceId } : null,
      ...(perms ? { capabilities: serializeEffectivePermissions(perms) } : {}),
    });
  }, { authenticated: true });

  async function loadIdentityContext(): Promise<{ identities: Map<string, UserIdentityRecord>; sourceNames: Map<string, string> }> {
    if (!deps.identityStore) return { identities: new Map(), sourceNames: new Map() };
    const [identities, sources] = await Promise.all([
      deps.identityStore.listUserIdentities(),
      deps.identityStore.listAuthSources(),
    ]);
    return {
      identities: new Map(identities.map((identity) => [identity.userId, identity])),
      sourceNames: new Map(sources.map((source) => [source.id, source.name])),
    };
  }

  // ─── User management (admin only) ─────────────────────────────────────────

  router.add("GET", "/api/admin/users", async (req, res, _params) => {
    if (!requireStore(deps.userStore, res, "User store not available")) return;
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const limit = Math.min(
      Math.max(parseNonNegativeInt(requestUrl.searchParams.get("limit")) ?? DEFAULT_USERS_LIMIT, 1),
      MAX_USERS_LIMIT
    );
    const offset = Math.max(parseNonNegativeInt(requestUrl.searchParams.get("offset")) ?? 0, 0);
    const users = await deps.userStore.listUsers();
    const page = users.slice(offset, offset + limit);
    const { identities, sourceNames } = await loadIdentityContext();
    writeJson(res, 200, {
      users: page.map((user) => serializeUser(user, identities.get(user.id) ?? null, sourceNames)),
      total: users.length,
      limit,
      offset,
    });
  }, { permission: "user.manage" });

  async function createDirectoryUser(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown> | null, role: UserRole): Promise<void> {
    const authSourceId = typeof body?.["authSourceId"] === "string" ? body["authSourceId"] : "";
    const externalUsername = typeof body?.["externalUsername"] === "string" ? body["externalUsername"].trim() : "";
    if (!deps.identityStore || !deps.directoryAccounts) {
      writeJson(res, 503, { error: "Directory accounts are not available" });
      return;
    }
    if (externalUsername === "") {
      writeJson(res, 400, { error: "externalUsername must be a non-empty string" });
      return;
    }
    const requested = typeof body?.["username"] === "string" ? normalizeUsername(body["username"]) : "";
    const lookup = await deps.directoryAccounts.resolve(authSourceId, externalUsername);
    if (writeDirectoryLookupFailure(res, lookup, externalUsername) || lookup.status !== "found") return;
    const username = requested !== "" ? requested : normalizeUsername(lookup.account.username);
    try {
      const { user, identity: created } = await deps.identityStore.createExternalUser({
        username,
        role,
        authSourceId: lookup.source.id,
        externalSubject: lookup.account.subject,
        externalUsername: lookup.account.username,
      });
      await deps.identityStore.replaceIdentityGroups(created.id, lookup.account.groups);
      deps.onUsersChanged?.();
      try {
        await deps.onUserCreated?.(user.id, user.role);
      } catch {
        // Default-policy binding is best-effort; user creation still succeeds.
      }
      recordAudit(deps.auditStore, req, {
        action: "user.create",
        targetType: "user",
        targetId: user.id,
        details: { username: user.username, role: user.role, authSourceId: lookup.source.id, externalUsername: lookup.account.username },
      });
      const identity = await deps.identityStore.getUserIdentityByUserId(user.id);
      writeJson(res, 201, { user: serializeUser(user, identity, new Map([[lookup.source.id, lookup.source.name]])) });
    } catch (err: unknown) {
      if (isDuplicateError(err)) {
        writeJson(res, 409, { error: `Username "${username}" or directory account "${lookup.account.username}" is already in use` });
        return;
      }
      throw err;
    }
  }

  router.add("POST", "/api/admin/users", async (req, res, _params) => {
    if (!requireStore(deps.userStore, res, "User store not available")) return;
    const body = await readBody(req);
    const role = body?.["role"];
    if (typeof role !== "string" || !VALID_ROLES.includes(role as UserRole)) {
      writeJson(res, 400, { error: `role must be one of: ${VALID_ROLES.join(", ")}` });
      return;
    }
    if (body?.["authSourceId"] !== undefined && body["authSourceId"] !== null) {
      await createDirectoryUser(req, res, body, role as UserRole);
      return;
    }
    const credentials = validateCredentials(body);
    if ("error" in credentials) {
      writeJson(res, 400, { error: credentials.error });
      return;
    }
    const passwordHash = await hashPassword(credentials.password);
    try {
      const user = await deps.userStore.createUser({
        id: randomUUID(),
        username: credentials.username,
        passwordHash,
        role: role as UserRole,
      });
      deps.onUsersChanged?.();
      try {
        await deps.onUserCreated?.(user.id, user.role);
      } catch {
        // Default-policy binding is best-effort; user creation still succeeds.
      }
      recordAudit(deps.auditStore, req, { action: "user.create", targetType: "user", targetId: user.id, details: { username: user.username, role: user.role } });
      writeJson(res, 201, { user: serializeUser(user) });
    } catch (err: unknown) {
      if (isDuplicateError(err)) {
        writeJson(res, 409, { error: `Username "${credentials.username}" is already taken` });
        return;
      }
      throw err;
    }
  }, { permission: "user.manage" });

  router.add("PUT", "/api/admin/users/:id", async (req, res, params) => {
    if (!requireStore(deps.userStore, res, "User store not available")) return;
    const id = params["id"] ?? "";
    const target = await deps.userStore.getUserById(id);
    if (!target) { writeJson(res, 404, { error: "User not found" }); return; }
    const body = await readBody(req);
    const role = body?.["role"];
    const enabled = body?.["enabled"];
    if (role !== undefined && (typeof role !== "string" || !VALID_ROLES.includes(role as UserRole))) {
      writeJson(res, 400, { error: `role must be one of: ${VALID_ROLES.join(", ")}` });
      return;
    }
    if (enabled !== undefined && typeof enabled !== "boolean") {
      writeJson(res, 400, { error: "enabled must be a boolean" });
      return;
    }
    if (role === undefined && enabled === undefined) {
      writeJson(res, 400, { error: "Nothing to update: provide role and/or enabled" });
      return;
    }
    let updated: AdminUser | null;
    try {
      updated = await deps.userStore.updateUser(id, {
        ...(role !== undefined ? { role: role as UserRole } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
      });
    } catch (err) {
      if (writeLastAdminConflict(res, err, "demote or disable")) return;
      throw err;
    }
    if (!updated) { writeJson(res, 404, { error: "User not found" }); return; }
    if (enabled === false) {
      await deps.userStore.deleteSessionsForUser(id);
    }
    recordAudit(deps.auditStore, req, {
      action: "user.update",
      targetType: "user",
      targetId: id,
      details: {
        username: updated.username,
        ...(role !== undefined ? { role } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
      },
    });
    const { identities, sourceNames } = await loadIdentityContext();
    writeJson(res, 200, { user: serializeUser(updated, identities.get(updated.id) ?? null, sourceNames) });
  }, { permission: "user.manage" });

  // Admin resets anyone; a non-admin may change their OWN password with currentPassword.
  router.add("PUT", "/api/admin/users/:id/password", async (req, res, params) => {
    if (!requireStore(deps.userStore, res, "User store not available")) return;
    const id = params["id"] ?? "";
    const context = getAuthContext(req);
    if (!context) { writeJson(res, 401, { error: "Unauthorized" }); return; }
    const target = await deps.userStore.getUserById(id);
    if (!target) { writeJson(res, 404, { error: "User not found" }); return; }
    if (deps.identityStore && (await deps.identityStore.getUserIdentityByUserId(id))) {
      writeJson(res, 409, { error: "This account signs in through a directory; its password is managed there" });
      return;
    }
    const body = await readBody(req);
    const password = typeof body?.["password"] === "string" ? body["password"] : "";
    const passwordError = validatePasswordStrength(password);
    if (passwordError) {
      writeJson(res, 400, { error: passwordError });
      return;
    }
    if (context.role !== "admin") {
      if (context.userId !== id) {
        writeJson(res, 403, { error: "forbidden", requiredRole: "admin" });
        return;
      }
      const currentPassword = typeof body?.["currentPassword"] === "string" ? body["currentPassword"] : "";
      if (!currentPassword || !(await verifyPassword(currentPassword, target.passwordHash))) {
        writeJson(res, 403, { error: "currentPassword is missing or incorrect" });
        return;
      }
    }
    const passwordHash = await hashPassword(password);
    await deps.userStore.updateUserPassword(id, passwordHash);
    // Revoke every session of the user — they must log in again with the new password.
    await deps.userStore.deleteSessionsForUser(id);
    recordAudit(deps.auditStore, req, { action: "user.password_change", targetType: "user", targetId: id, details: { username: target.username } });
    writeJson(res, 200, { ok: true });
  }, { authenticated: true });

  router.add("DELETE", "/api/admin/users/:id", async (req, res, params) => {
    if (!requireStore(deps.userStore, res, "User store not available")) return;
    const id = params["id"] ?? "";
    const target = await deps.userStore.getUserById(id);
    if (!target) { writeJson(res, 404, { error: "User not found" }); return; }
    try {
      await deps.userStore.deleteUser(id);
    } catch (err) {
      if (writeLastAdminConflict(res, err, "delete")) return;
      if (
        err instanceof Error &&
        "code" in err &&
        (err as { code?: unknown }).code === "RESOURCE_OWNERSHIP_CONFLICT"
      ) {
        writeJson(res, 409, { error: "User still owns resources; delete or reassign them first" });
        return;
      }
      throw err;
    }
    deps.onUsersChanged?.();
    recordAudit(deps.auditStore, req, { action: "user.delete", targetType: "user", targetId: id, details: { username: target.username } });
    writeJson(res, 200, { ok: true });
  }, { permission: "user.manage" });

  // Link replaces the local password with directory sign-in and revokes sessions.
  router.add("PUT", "/api/admin/users/:id/identity", async (req, res, params) => {
    if (!requireStore(deps.userStore, res, "User store not available")) return;
    if (!deps.identityStore || !deps.directoryAccounts) {
      writeJson(res, 503, { error: "Directory accounts are not available" });
      return;
    }
    const id = params["id"] ?? "";
    const target = await deps.userStore.getUserById(id);
    if (!target) { writeJson(res, 404, { error: "User not found" }); return; }
    const body = await readBody(req);
    const authSourceId = typeof body?.["authSourceId"] === "string" ? body["authSourceId"] : "";
    const externalUsername = typeof body?.["externalUsername"] === "string" ? body["externalUsername"].trim() : "";
    if (externalUsername === "") {
      writeJson(res, 400, { error: "externalUsername must be a non-empty string" });
      return;
    }
    const lookup = await deps.directoryAccounts.resolve(authSourceId, externalUsername);
    if (writeDirectoryLookupFailure(res, lookup, externalUsername) || lookup.status !== "found") return;
    let identity: UserIdentityRecord;
    try {
      identity = await deps.identityStore.linkUserIdentity({
        userId: id,
        authSourceId: lookup.source.id,
        externalSubject: lookup.account.subject,
        externalUsername: lookup.account.username,
      });
    } catch (err) {
      if (hasErrorCode(err, "NOT_FOUND")) { writeJson(res, 404, { error: "User not found" }); return; }
      if (hasErrorCode(err, "ALREADY_LINKED")) { writeJson(res, 409, { error: "User is already linked to a directory account" }); return; }
      if (hasErrorCode(err, "DUPLICATE")) {
        writeJson(res, 409, { error: `Directory account "${lookup.account.username}" is already linked to another user` });
        return;
      }
      if (hasErrorCode(err, "LAST_LOCAL_ADMIN")) {
        writeJson(res, 409, { error: "Cannot link the last enabled local admin; keep one password account for directory outages" });
        return;
      }
      throw err;
    }
    await deps.identityStore.replaceIdentityGroups(identity.id, lookup.account.groups);
    recordAudit(deps.auditStore, req, {
      action: "user.identity_link",
      targetType: "user",
      targetId: id,
      details: { username: target.username, authSourceId: lookup.source.id, externalUsername: lookup.account.username },
    });
    writeJson(res, 200, { user: serializeUser(target, identity, new Map([[lookup.source.id, lookup.source.name]])) });
  }, { permission: "user.manage" });

  // Unlink converts the account back to a local password and revokes sessions.
  router.add("DELETE", "/api/admin/users/:id/identity", async (req, res, params) => {
    if (!requireStore(deps.userStore, res, "User store not available")) return;
    if (!deps.identityStore) {
      writeJson(res, 503, { error: "Directory accounts are not available" });
      return;
    }
    const id = params["id"] ?? "";
    const target = await deps.userStore.getUserById(id);
    if (!target) { writeJson(res, 404, { error: "User not found" }); return; }
    const identity = await deps.identityStore.getUserIdentityByUserId(id);
    if (!identity) { writeJson(res, 404, { error: "User is not linked to a directory account" }); return; }
    const body = await readBody(req);
    const password = typeof body?.["password"] === "string" ? body["password"] : "";
    const passwordError = validatePasswordStrength(password);
    if (passwordError) {
      writeJson(res, 400, { error: passwordError });
      return;
    }
    if (!(await deps.identityStore.unlinkUserIdentity(id, await hashPassword(password)))) {
      writeJson(res, 404, { error: "User is not linked to a directory account" });
      return;
    }
    recordAudit(deps.auditStore, req, {
      action: "user.identity_unlink",
      targetType: "user",
      targetId: id,
      details: { username: target.username, authSourceId: identity.authSourceId, externalUsername: identity.externalUsername },
    });
    writeJson(res, 200, { user: serializeUser(target) });
  }, { permission: "user.manage" });
}
