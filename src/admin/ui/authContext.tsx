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
}

const CurrentUserContext = createContext<CurrentUserValue>({
  user: null,
  isAdmin: false,
  canOperate: false,
});

export const CurrentUserProvider = CurrentUserContext.Provider;

export function useCurrentUser(): CurrentUserValue {
  return useContext(CurrentUserContext);
}
