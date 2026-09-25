import type { AdminUser } from "../../interfaces.js";

/** Outcome of checking a username/password pair against a credential authority. */
export type PasswordAuthentication =
  | { status: "authenticated"; user: AdminUser }
  | { status: "rejected" };

/**
 * Resolves a username/password pair to an enabled local user. Session issuance,
 * rate limiting, and auditing stay with the caller so every authority shares them.
 */
export interface PasswordAuthenticator {
  authenticate(username: string, password: string): Promise<PasswordAuthentication>;
}
