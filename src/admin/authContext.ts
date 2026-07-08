import type { IncomingMessage } from "node:http";
import type { AuthContext } from "./adminAuthService.js";

/**
 * Per-request auth identity, attached after successful authentication in
 * `handleRequest` and readable from any route handler without changing
 * handler signatures.
 */
const authContexts = new WeakMap<IncomingMessage, AuthContext>();

/** Attach the authenticated identity to the request. */
export function setAuthContext(req: IncomingMessage, context: AuthContext): void {
  authContexts.set(req, context);
}

/** Read the authenticated identity of the request (undefined on public routes). */
export function getAuthContext(req: IncomingMessage): AuthContext | undefined {
  return authContexts.get(req);
}
