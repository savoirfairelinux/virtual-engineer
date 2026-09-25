import { getLogger } from "../../logger.js";
import type { AdminUser, UserRole } from "../../interfaces.js";
import type { AuthSourceRecord } from "../../state/stores/authSourceStore.js";
import type { UserIdentityRecord } from "../../state/stores/userIdentityStore.js";
import { readStoredLdapConfig, type LdapConfig } from "./ldapConfig.js";
import { authenticateLdapAccount, authenticateLdapSubject, lookupLdapAccount, type LdapAccount } from "./ldapDirectory.js";
import { createLocalPasswordAuthenticator, type LocalPasswordUserStore } from "./localPasswordAuthenticator.js";
import type { PasswordAuthentication, PasswordAuthenticator } from "./passwordAuthenticator.js";
import { normalizeUsername } from "./username.js";

const log = getLogger("admin-auth");

export interface DirectoryAuthenticatorStore extends LocalPasswordUserStore {
  getUserById(id: string): Promise<AdminUser | null>;
  getAuthSourceById(id: string): Promise<AuthSourceRecord | null>;
  listAuthSources(): Promise<AuthSourceRecord[]>;
  getUserIdentityByUserId(userId: string): Promise<UserIdentityRecord | null>;
  getUserIdentityBySubject(authSourceId: string, externalSubject: string): Promise<UserIdentityRecord | null>;
  recordIdentityLogin(identityId: string, update: { externalUsername: string; at: Date }): Promise<void>;
  createExternalUser(input: {
    username: string;
    role: UserRole;
    authSourceId: string;
    externalSubject: string;
    externalUsername: string;
  }): Promise<{ user: AdminUser; identity: UserIdentityRecord }>;
  replaceIdentityGroups(identityId: string, externalGroups: readonly string[]): Promise<void>;
}

export interface DirectoryAuthenticatorDeps {
  store: DirectoryAuthenticatorStore;
  adminAuthSecret: string | undefined;
  /** Binds the role-default policy after a first-sign-in provisioning. */
  onUserProvisioned?: ((user: AdminUser) => Promise<void>) | undefined;
}

/** Decrypt and validate a source's config; null (logged) when it cannot be used. */
export function loadLdapSourceConfig(source: AuthSourceRecord, adminAuthSecret: string | undefined): LdapConfig | null {
  try {
    return readStoredLdapConfig(source.configJson, adminAuthSecret);
  } catch (err) {
    log.error({ err, authSourceId: source.id }, "LDAP authentication source configuration is unusable");
    return null;
  }
}

export type DirectoryAccountResolution =
  | { status: "found"; source: AuthSourceRecord; account: LdapAccount }
  | { status: "source_not_found" }
  | { status: "not_found" }
  | { status: "ambiguous" }
  | { status: "unavailable"; error: string };

/** Looks up directory accounts for admin linking; never checks a user password. */
export interface DirectoryAccountResolver {
  resolve(authSourceId: string, username: string): Promise<DirectoryAccountResolution>;
}

export function createDirectoryAccountResolver(deps: {
  store: Pick<DirectoryAuthenticatorStore, "getAuthSourceById">;
  adminAuthSecret: string | undefined;
}): DirectoryAccountResolver {
  return {
    async resolve(authSourceId, username): Promise<DirectoryAccountResolution> {
      const source = await deps.store.getAuthSourceById(authSourceId);
      if (!source) return { status: "source_not_found" };
      const config = loadLdapSourceConfig(source, deps.adminAuthSecret);
      if (!config) return { status: "unavailable", error: "The authentication source configuration is unusable" };
      const lookup = await lookupLdapAccount(config, username);
      return lookup.status === "found" ? { status: "found", source, account: lookup.account } : lookup;
    },
  };
}

const REJECTED: PasswordAuthentication = { status: "rejected" };
const UNAVAILABLE: PasswordAuthentication = { status: "unavailable" };

/**
 * Local accounts keep their scrypt password and always take precedence over a
 * directory account with the same name. Directory-linked accounts sign in only
 * through their source. Unknown names are tried against enabled sources in
 * priority order and succeed for an existing link, or create one when the
 * source allows auto-provisioning. Every directory sign-in refreshes the
 * identity's directory groups.
 */
export function createDirectoryAuthenticator(deps: DirectoryAuthenticatorDeps): PasswordAuthenticator {
  const { store, adminAuthSecret } = deps;
  const local = createLocalPasswordAuthenticator(store);

  async function signIn(user: AdminUser, identity: UserIdentityRecord, account: LdapAccount, provisioned = false): Promise<PasswordAuthentication> {
    if (!user.enabled) return REJECTED;
    try {
      await store.recordIdentityLogin(identity.id, { externalUsername: account.username, at: new Date() });
    } catch (err) {
      log.warn({ err, identityId: identity.id }, "Could not record directory sign-in metadata");
    }
    // Mapped groups grant permissions, so a failed refresh must not sign in with stale ones.
    try {
      await store.replaceIdentityGroups(identity.id, account.groups);
    } catch (err) {
      // An admin unlinked the account while the directory was answering: a refusal, not an outage.
      if ((await store.getUserIdentityByUserId(user.id))?.id !== identity.id) return REJECTED;
      throw err;
    }
    return { status: "authenticated", user, authSourceId: identity.authSourceId, identityId: identity.id, provisioned };
  }

  async function provision(source: AuthSourceRecord, account: LdapAccount): Promise<PasswordAuthentication> {
    let created: { user: AdminUser; identity: UserIdentityRecord };
    try {
      created = await store.createExternalUser({
        username: normalizeUsername(account.username),
        role: source.defaultRole,
        authSourceId: source.id,
        externalSubject: account.subject,
        externalUsername: account.username,
      });
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as { code?: unknown }).code === "DUPLICATE") {
        // Never merge into an existing account by name; an admin must link it explicitly.
        log.warn({ authSourceId: source.id, username: account.username }, "auto-provisioning skipped: username already in use");
        return REJECTED;
      }
      throw err;
    }
    try {
      await deps.onUserProvisioned?.(created.user);
    } catch (err) {
      log.warn({ err, userId: created.user.id }, "default policy binding failed for a provisioned user");
    }
    log.info({ authSourceId: source.id, username: created.user.username }, "provisioned directory user on first sign-in");
    return signIn(created.user, created.identity, account, true);
  }

  async function authenticateLinked(user: AdminUser, identity: UserIdentityRecord, password: string): Promise<PasswordAuthentication> {
    if (!user.enabled) return REJECTED;
    const source = await store.getAuthSourceById(identity.authSourceId);
    if (!source || !source.enabled) return REJECTED;
    const config = loadLdapSourceConfig(source, adminAuthSecret);
    if (!config) return UNAVAILABLE;
    const outcome = await authenticateLdapSubject(config, identity.externalSubject, identity.externalUsername, password);
    if (outcome.status === "unavailable") {
      log.warn({ authSourceId: source.id, error: outcome.error }, "LDAP directory unavailable during sign-in");
      return UNAVAILABLE;
    }
    if (outcome.status !== "authenticated") return REJECTED;
    // The hex/text subject filter matches loosely; only the exact linked entry may sign in.
    if (outcome.account.subject !== identity.externalSubject) return REJECTED;
    return signIn(user, identity, outcome.account);
  }

  async function authenticateUnknown(username: string, password: string): Promise<PasswordAuthentication> {
    let unavailable = false;
    // Once any directory has judged this password, the answer must be a counted rejection;
    // reporting `unavailable` would bypass rate limiting and act as a password oracle.
    let passwordJudged = false;
    for (const source of await store.listAuthSources()) {
      if (!source.enabled) continue;
      const config = loadLdapSourceConfig(source, adminAuthSecret);
      if (!config) {
        unavailable = true;
        continue;
      }
      const outcome = await authenticateLdapAccount(config, username, password);
      if (outcome.status === "unavailable") {
        log.warn({ authSourceId: source.id, error: outcome.error }, "LDAP directory unavailable during sign-in");
        unavailable = true;
        continue;
      }
      if (outcome.status === "invalid_password") passwordJudged = true;
      if (outcome.status !== "authenticated") continue;
      passwordJudged = true;
      const identity = await store.getUserIdentityBySubject(source.id, outcome.account.subject);
      if (!identity) {
        if (source.autoProvision) return provision(source, outcome.account);
        continue;
      }
      const user = await store.getUserById(identity.userId);
      return user ? signIn(user, identity, outcome.account) : REJECTED;
    }
    return unavailable && !passwordJudged ? UNAVAILABLE : REJECTED;
  }

  return {
    async authenticate(username, password): Promise<PasswordAuthentication> {
      const user = await store.getUserByUsername(username);
      if (!user) return authenticateUnknown(username, password);
      const identity = await store.getUserIdentityByUserId(user.id);
      return identity ? authenticateLinked(user, identity, password) : local.authenticate(username, password);
    },
  };
}
