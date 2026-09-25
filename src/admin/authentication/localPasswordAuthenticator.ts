import type { AdminUser } from "../../interfaces.js";
import type { PasswordAuthentication, PasswordAuthenticator } from "./passwordAuthenticator.js";
import { verifyPassword } from "./passwordHash.js";

export interface LocalPasswordUserStore {
  getUserByUsername(username: string): Promise<AdminUser | null>;
}

/** Verifies passwords against the scrypt hash stored on the local user row. */
export function createLocalPasswordAuthenticator(store: LocalPasswordUserStore): PasswordAuthenticator {
  return {
    async authenticate(username, password): Promise<PasswordAuthentication> {
      const user = await store.getUserByUsername(username);
      if (!user || !user.enabled) return { status: "rejected" };
      if (!(await verifyPassword(password, user.passwordHash))) return { status: "rejected" };
      return { status: "authenticated", user };
    },
  };
}
