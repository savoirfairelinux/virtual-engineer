import { getLogger } from "../../logger.js";
import type { AdminUser, UserSession } from "../../interfaces.js";
import type { AuthSourceRecord } from "../../state/stores/authSourceStore.js";
import type { UserIdentityRecord } from "../../state/stores/userIdentityStore.js";
import { loadLdapSourceConfig } from "./directoryAuthenticator.js";
import { lookupLdapAccount } from "./ldapDirectory.js";
import type { SessionGuard, SessionVerdict } from "./sessionGuard.js";

const log = getLogger("admin-auth");
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export interface DirectorySessionGuardStore {
  getUserIdentityByUserId(userId: string): Promise<UserIdentityRecord | null>;
  getAuthSourceById(id: string): Promise<AuthSourceRecord | null>;
  replaceIdentityGroups(identityId: string, externalGroups: readonly string[]): Promise<void>;
  markSessionValidated(tokenHash: string, at: Date): Promise<void>;
}

/**
 * Keeps directory sessions in step with the directory. Sessions of linked users
 * end at the source's absolute age limit or when the source is disabled; within
 * that window they re-check the account every `revalidateIntervalMinutes`,
 * refreshing its groups and revoking the session when the account no longer
 * matches the user filter or its subject changed. An unreachable directory
 * keeps the session until the age limit so an outage does not sign everyone out.
 * Local-password sessions are never affected.
 */
export function createDirectorySessionGuard(deps: {
  store: DirectorySessionGuardStore;
  adminAuthSecret: string | undefined;
}): SessionGuard {
  const { store, adminAuthSecret } = deps;
  const inFlight = new Map<string, Promise<SessionVerdict>>();

  async function revalidate(
    session: UserSession,
    identity: UserIdentityRecord,
    source: AuthSourceRecord,
    now: Date
  ): Promise<SessionVerdict> {
    const config = loadLdapSourceConfig(source, adminAuthSecret);
    if (!config) return "keep";
    const lookup = await lookupLdapAccount(config, identity.externalUsername);
    if (lookup.status === "unavailable") {
      log.warn({ authSourceId: source.id, error: lookup.error }, "directory unavailable during session revalidation; keeping session");
      return "keep";
    }
    if (lookup.status !== "found" || lookup.account.subject !== identity.externalSubject) {
      log.info({ authSourceId: source.id, userId: session.userId, outcome: lookup.status }, "directory account no longer valid; revoking session");
      return "revoke";
    }
    await store.replaceIdentityGroups(identity.id, lookup.account.groups);
    await store.markSessionValidated(session.tokenHash, now);
    return "keep";
  }

  return {
    async check(session: UserSession & { user: AdminUser }, now: Date): Promise<SessionVerdict> {
      const identity = await store.getUserIdentityByUserId(session.userId);
      if (!identity) return "keep";
      const source = await store.getAuthSourceById(identity.authSourceId);
      if (!source || !source.enabled) return "revoke";
      if (now.getTime() - session.createdAt.getTime() >= source.sessionMaxAgeHours * HOUR_MS) return "revoke";
      const validatedAt = session.validatedAt;
      if (validatedAt !== null && now.getTime() - validatedAt.getTime() < source.revalidateIntervalMinutes * MINUTE_MS) {
        return "keep";
      }
      // Concurrent requests on one session share a single directory round trip.
      const pending = inFlight.get(session.tokenHash);
      if (pending) return pending;
      const run = revalidate(session, identity, source, now).finally(() => inFlight.delete(session.tokenHash));
      inFlight.set(session.tokenHash, run);
      return run;
    },
  };
}
