/**
 * Current-user context — exposes the authenticated identity and role flags to
 * any component via useCurrentUser(). Provided by App.tsx after login.
 */
import { createContext, useContext } from "react";
import type { ApiMe } from "./types.ts";

export interface CurrentUserValue {
  user: ApiMe | null;
  /** role === "admin" */
  isAdmin: boolean;
  /** role !== "viewer" — may perform non-admin mutations */
  canOperate: boolean;
  /**
   * PBAC capability check derived from the caller's effective permissions.
   * Superusers always pass. A scoped check (`resourceId` given) is satisfied by
   * a `*` grant or a matching id; an unscoped check requires a `*` grant.
   * Falls back to `true` when capabilities are unavailable (legacy servers).
   */
  can: (permission: string, resourceId?: string) => boolean;
}

const CurrentUserContext = createContext<CurrentUserValue>({
  user: null,
  isAdmin: false,
  canOperate: false,
  can: () => false,
});

export const CurrentUserProvider = CurrentUserContext.Provider;

export function useCurrentUser(): CurrentUserValue {
  return useContext(CurrentUserContext);
}

/** Build a capability checker from a serialized-permissions payload. */
export function makeCan(user: ApiMe | null): (permission: string, resourceId?: string) => boolean {
  const caps = user?.capabilities;
  // No capability payload (legacy server): fall back to role — admins pass, others
  // are gated by the server anyway.
  if (!caps) return () => user?.role === "admin";
  if (caps.superuser) return () => true;
  return (permission: string, resourceId?: string): boolean => {
    const scope = caps.grants[permission];
    if (scope === undefined) return false;
    if (scope === "*") return true;
    if (resourceId === undefined) return false;
    return scope.includes(resourceId);
  };
}
