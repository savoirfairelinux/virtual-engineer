import type { IncomingMessage } from "node:http";
import type { AuthContext } from "./adminAuthService.js";
import type { EffectivePermissions } from "./authorization/policyEngine.js";

/**
 * Per-request auth identity, attached after successful authentication in
 * `handleRequest` and readable from any route handler without changing
 * handler signatures.
 */
const authContexts = new WeakMap<IncomingMessage, AuthContext>();

/** Per-request resolved PBAC permissions, cached for the gate and list filters. */
const effectivePermissions = new WeakMap<IncomingMessage, EffectivePermissions>();

/** Attach the authenticated identity to the request. */
export function setAuthContext(req: IncomingMessage, context: AuthContext): void {
  authContexts.set(req, context);
}

/** Read the authenticated identity of the request (undefined on public routes). */
export function getAuthContext(req: IncomingMessage): AuthContext | undefined {
  return authContexts.get(req);
}

/** Attach the request's resolved effective permissions. */
export function setEffectivePermissions(req: IncomingMessage, perms: EffectivePermissions): void {
  effectivePermissions.set(req, perms);
}

/**
 * Read the request's resolved effective permissions. Undefined when the state
 * store lacks PBAC methods (mocks/older embedders) — callers then fall back to
 * role-based checks.
 */
export function getEffectivePermissions(req: IncomingMessage): EffectivePermissions | undefined {
  return effectivePermissions.get(req);
}
