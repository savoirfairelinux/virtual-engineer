import type { AdminUser, UserSession } from "../../interfaces.js";

export type SessionVerdict = "keep" | "revoke";

/** Decides whether a stored, unexpired session may keep authenticating requests. */
export interface SessionGuard {
  check(session: UserSession & { user: AdminUser }, now: Date): Promise<SessionVerdict>;
}
