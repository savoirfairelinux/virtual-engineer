import { getLogger } from "../../logger.js";
import type { AdminUser, UserSession } from "../../interfaces.js";
import type { AuthSourceRecord } from "../../state/stores/authSourceStore.js";
import type { UserIdentityRecord } from "../../state/stores/userIdentityStore.js";
import { loadLdapSourceConfig } from "./directoryAuthenticator.js";
import { lookupLdapSubject } from "./ldapDirectory.js";
import type { SessionGuard, SessionVerdict } from "./sessionGuard.js";

const log = getLogger("admin-auth");
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** Wait after a revalidation that could not finish before trying that source or session again. */
export const REVALIDATION_RETRY_MS = MINUTE_MS;

export interface DirectorySessionGuardStore {
  getUserIdentityByUserId(userId: string): Promise<UserIdentityRecord | null>;
  getAuthSourceById(id: string): Promise<AuthSourceRecord | null>;
  replaceIdentityGroups(identityId: string, externalGroups: readonly string[]): Promise<void>;
  markSessionValidated(tokenHash: string, at: Date): Promise<void>;
}

/**
 * Keeps directory sessions in step with the directory. Sessions of linked users
 * end at the source's absolute age limit or when the source is disabled; within
 * that window they re-check the account by its stored subject every
 * `revalidateIntervalMinutes`, refreshing its groups and revoking the session
 * when the account no longer matches the user filter. An unreachable directory
 * keeps the session until the age limit so an outage does not sign everyone out,
 * and the source is not contacted again for `REVALIDATION_RETRY_MS`; a failure
 * specific to one account pauses only that session. A confirmed check that
 * cannot be recorded keeps the session and retries it after the same delay;
 * `validated_at` only moves on success. Local-password sessions are never
 * affected.
 */
export function createDirectorySessionGuard(deps: {
  store: DirectorySessionGuardStore;
  adminAuthSecret: string | undefined;
}): SessionGuard {
  const { store, adminAuthSecret } = deps;
  const inFlight = new Map<string, Promise<SessionVerdict>>();
  const retryAfter = new Map<string, number>();

  function coolingDown(key: string, now: Date): boolean {
    return (retryAfter.get(key) ?? 0) > now.getTime();
  }

  function backOff(key: string, failedAtMs: number): void {
    for (const [stale, until] of retryAfter) if (until <= failedAtMs) retryAfter.delete(stale);
    retryAfter.set(key, failedAtMs + REVALIDATION_RETRY_MS);
  }

  async function revalidate(
    session: UserSession,
    identity: UserIdentityRecord,
    source: AuthSourceRecord,
    now: Date
  ): Promise<SessionVerdict> {
    const started = performance.now();
    // Backoffs start when a failure is known, so a slow exchange cannot outlast its own backoff.
    const failedAt = (): number => now.getTime() + (performance.now() - started);
    const sessionKey = `session:${session.tokenHash}`;
    const sourceKey = `source:${source.id}`;
    const config = loadLdapSourceConfig(source, adminAuthSecret);
    if (!config) {
      backOff(sourceKey, failedAt());
      return "keep";
    }
    const lookup = await lookupLdapSubject(config, identity.externalSubject, identity.externalUsername);
    if (lookup.status === "unavailable") {
      if (lookup.accountSpecific) {
        log.warn({ authSourceId: source.id, userId: session.userId, error: lookup.error }, "directory account cannot be checked; keeping session");
        backOff(sessionKey, failedAt());
      } else {
        log.warn({ authSourceId: source.id, error: lookup.error }, "directory unavailable during session revalidation; keeping session");
        backOff(sourceKey, failedAt());
      }
      return "keep";
    }
    if (lookup.status !== "found" || lookup.account.subject !== identity.externalSubject) {
      log.info({ authSourceId: source.id, userId: session.userId, outcome: lookup.status }, "directory account no longer valid; revoking session");
      return "revoke";
    }
    try {
      await store.replaceIdentityGroups(identity.id, lookup.account.groups);
      await store.markSessionValidated(session.tokenHash, now);
    } catch (err) {
      log.warn({ err, userId: session.userId }, "could not record session revalidation; keeping session and retrying later");
      backOff(sessionKey, failedAt());
    }
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
      if (coolingDown(`source:${source.id}`, now) || coolingDown(`session:${session.tokenHash}`, now)) return "keep";
      // Concurrent requests on one session share a single directory round trip.
      const pending = inFlight.get(session.tokenHash);
      if (pending) return pending;
      const run = revalidate(session, identity, source, now).finally(() => inFlight.delete(session.tokenHash));
      inFlight.set(session.tokenHash, run);
      return run;
    },
  };
}
