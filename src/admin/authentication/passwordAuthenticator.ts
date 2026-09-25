import type { AdminUser } from "../../interfaces.js";

/**
 * Outcome of checking a username/password pair. `authSourceId` is null for
 * local passwords. `identityId` is the directory link that vouched for the user
 * (null for local passwords); a session is issued only while it is still the
 * user's link. `provisioned` marks a user created by this sign-in.
 * `unavailable` means no authority could verify the credentials (for example
 * an unreachable directory), not that they are wrong.
 */
export type PasswordAuthentication =
  | { status: "authenticated"; user: AdminUser; authSourceId: string | null; identityId: string | null; provisioned?: boolean }
  | { status: "rejected" }
  | { status: "unavailable" };

/**
 * Resolves a username/password pair to an enabled local user. Session issuance,
 * rate limiting, and auditing stay with the caller so every authority shares them.
 */
export interface PasswordAuthenticator {
  authenticate(username: string, password: string): Promise<PasswordAuthentication>;
}
