import { isIP } from "node:net";
import type { ConnectionOptions } from "node:tls";
import { Client, InvalidCredentialsError, NoSuchObjectError, ResultCodeError, SizeLimitExceededError, type Entry } from "ldapts";
import type { LdapConfig } from "./ldapConfig.js";

export type LdapFailureStage = "connect" | "bind" | "search";

/** Upper bound on round trips per exchange (StartTLS, service bind, searches, user bind). */
const LDAP_EXCHANGE_OPERATIONS = 4;

/** A directory entry resolved by the configured user filter. */
export interface LdapAccount {
  dn: string;
  /** Value of `uniqueIdAttribute`; binary values (e.g. objectGUID) are hex-encoded. */
  subject: string;
  /** Value of `usernameAttribute`, falling back to the searched name. */
  username: string;
  displayName: string | null;
}

export type LdapAccountLookup =
  | { status: "found"; account: LdapAccount }
  | { status: "not_found" }
  | { status: "ambiguous" }
  | { status: "unavailable"; error: string };

/** `invalid_password`: the account exists and the directory refused the password. */
export type LdapAuthentication =
  | { status: "authenticated"; account: LdapAccount }
  | { status: "rejected" }
  | { status: "invalid_password" }
  | { status: "unavailable"; error: string };

export type LdapConnectionTest =
  | { ok: true }
  | { ok: false; stage: LdapFailureStage; error: string };

/** RFC 4515 escaping for a value substituted into a search filter. */
export function escapeLdapFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (char) => `\\${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function buildTlsOptions(config: LdapConfig): ConnectionOptions {
  const host = new URL(config.url).hostname.replace(/^\[|\]$/g, "");
  return {
    host,
    minVersion: "TLSv1.2",
    rejectUnauthorized: true,
    ...(isIP(host) === 0 ? { servername: host } : {}),
    ...(config.tlsCaCert !== undefined ? { ca: [config.tlsCaCert] } : {}),
  };
}

/** Run `operation` on a fresh TLS-protected connection that is always closed afterwards. */
export async function withLdapConnection<T>(config: LdapConfig, operation: (client: Client) => Promise<T>): Promise<T> {
  // ldapts opens implicit TLS whenever constructor tlsOptions are set, so StartTLS
  // clients must connect in plaintext and receive their options on upgrade only.
  const client = new Client({
    url: config.url,
    timeout: config.timeoutMs,
    connectTimeout: config.timeoutMs,
    ...(config.startTls ? {} : { tlsOptions: buildTlsOptions(config) }),
    strictDN: true,
  });
  let deadline: NodeJS.Timeout | undefined;
  // ldapts has no timeout on the StartTLS handshake; bound the whole exchange.
  const expired = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => reject(new Error("LDAP server did not respond in time")), config.timeoutMs * LDAP_EXCHANGE_OPERATIONS);
  });
  try {
    return await Promise.race([
      (async (): Promise<T> => {
        if (config.startTls) await client.startTLS(buildTlsOptions(config));
        return operation(client);
      })(),
      expired,
    ]);
  } finally {
    clearTimeout(deadline);
    await client.unbind().catch(() => undefined);
  }
}

/** Human-readable LDAP failure without credentials. */
export function describeLdapError(err: unknown, config: LdapConfig): string {
  let message: string;
  if (err instanceof InvalidCredentialsError) message = "The directory rejected the bind credentials";
  else if (err instanceof NoSuchObjectError) message = "The requested DN does not exist in the directory";
  else if (err instanceof ResultCodeError) message = `LDAP error ${err.code}: ${err.message}`;
  else if (err instanceof Error) message = err.message;
  else message = String(err);
  return message.split(config.bindPassword).join("********");
}

function firstValue(entry: Entry, attribute: string): Buffer | string | undefined {
  const key = Object.keys(entry).find((candidate) => candidate.toLowerCase() === attribute.toLowerCase());
  const value = key === undefined ? undefined : entry[key];
  return Array.isArray(value) ? value[0] : value;
}

function textValue(entry: Entry, attribute: string): string | null {
  const value = firstValue(entry, attribute);
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  return text !== undefined && text.trim() !== "" ? text.trim() : null;
}

/** Printable UTF-8 IDs (entryUUID) are kept as text; binary IDs (objectGUID) become hex. */
function subjectValue(entry: Entry, attribute: string): string | null {
  const value = firstValue(entry, attribute);
  if (value === undefined) return null;
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (bytes.length === 0) return null;
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) && /^[\x20-\x7e]+$/.test(text) ? text : bytes.toString("hex");
}

async function findAccount(client: Client, config: LdapConfig, filter: string, fallbackUsername: string): Promise<LdapAccountLookup> {
  await client.bind(config.bindDn, config.bindPassword);
  let entries: Entry[];
  try {
    ({ searchEntries: entries } = await client.search(config.userSearchBaseDn, {
      scope: "sub",
      filter,
      attributes: [config.uniqueIdAttribute, config.usernameAttribute, config.displayNameAttribute],
      explicitBufferAttributes: [config.uniqueIdAttribute],
      sizeLimit: 2,
    }));
  } catch (err) {
    if (err instanceof SizeLimitExceededError) return { status: "ambiguous" };
    throw err;
  }
  if (entries.length === 0) return { status: "not_found" };
  const [entry] = entries;
  if (entries.length > 1 || entry === undefined) return { status: "ambiguous" };
  const subject = subjectValue(entry, config.uniqueIdAttribute);
  if (subject === null) {
    return { status: "unavailable", error: `Directory entry has no ${config.uniqueIdAttribute} value` };
  }
  return {
    status: "found",
    account: {
      dn: entry.dn,
      subject,
      username: textValue(entry, config.usernameAttribute) ?? fallbackUsername,
      displayName: textValue(entry, config.displayNameAttribute),
    },
  };
}

function usernameFilter(config: LdapConfig, username: string): string {
  return config.userSearchFilter.split("{username}").join(escapeLdapFilterValue(username));
}

/** The configured user filter with any name, narrowed to the entry holding `subject`. */
function subjectFilter(config: LdapConfig, subject: string): string {
  const attribute = config.uniqueIdAttribute;
  const asText = `(${attribute}=${escapeLdapFilterValue(subject)})`;
  // Binary IDs such as objectGUID are stored hex-encoded; also match the bytes they encode.
  const match = /^(?:[0-9a-f]{2})+$/i.test(subject) ? `(|${asText}(${attribute}=${subject.replace(/../g, "\\$&")}))` : asText;
  return `(&${config.userSearchFilter.split("{username}").join("*")}${match})`;
}

/** Resolve one account through the service account without checking a password. */
export async function lookupLdapAccount(config: LdapConfig, username: string): Promise<LdapAccountLookup> {
  if (username.trim() === "") return { status: "not_found" };
  try {
    return await withLdapConnection(config, (client) => findAccount(client, config, usernameFilter(config, username), username));
  } catch (err) {
    return { status: "unavailable", error: describeLdapError(err, config) };
  }
}

async function authenticateMatch(config: LdapConfig, filter: string, fallbackUsername: string, password: string): Promise<LdapAuthentication> {
  // An empty password is an unauthenticated bind (RFC 4513 §5.1.2), which many servers accept.
  if (password === "") return { status: "rejected" };
  try {
    return await withLdapConnection(config, async (client): Promise<LdapAuthentication> => {
      const lookup = await findAccount(client, config, filter, fallbackUsername);
      if (lookup.status === "unavailable") return lookup;
      if (lookup.status !== "found") return { status: "rejected" };
      try {
        await client.bind(lookup.account.dn, password);
      } catch (err) {
        if (err instanceof InvalidCredentialsError) return { status: "invalid_password" };
        throw err;
      }
      return { status: "authenticated", account: lookup.account };
    });
  } catch (err) {
    return { status: "unavailable", error: describeLdapError(err, config) };
  }
}

/**
 * Find the account with the service account, then bind as it. Missing and
 * ambiguous accounts are `rejected` without any password check; a refused bind
 * is `invalid_password`; a service-bind, network, or TLS failure is `unavailable`.
 */
export async function authenticateLdapAccount(config: LdapConfig, username: string, password: string): Promise<LdapAuthentication> {
  if (username.trim() === "") return { status: "rejected" };
  return authenticateMatch(config, usernameFilter(config, username), username, password);
}

/**
 * Same outcomes as `authenticateLdapAccount`, but finds a linked account by its
 * stable `uniqueIdAttribute` subject so a renamed directory entry still signs in.
 */
export async function authenticateLdapSubject(config: LdapConfig, subject: string, knownUsername: string, password: string): Promise<LdapAuthentication> {
  if (subject === "") return { status: "rejected" };
  return authenticateMatch(config, subjectFilter(config, subject), knownUsername, password);
}

/** Bind with the service account and read the user search base. */
export async function testLdapConnection(config: LdapConfig): Promise<LdapConnectionTest> {
  const progress: { stage: LdapFailureStage } = { stage: "connect" };
  try {
    return await withLdapConnection(config, async (client): Promise<LdapConnectionTest> => {
      progress.stage = "bind";
      await client.bind(config.bindDn, config.bindPassword);
      progress.stage = "search";
      const result = await client.search(config.userSearchBaseDn, {
        scope: "base",
        filter: "(objectClass=*)",
        attributes: ["1.1"],
        sizeLimit: 1,
      });
      if (result.searchEntries.length === 0) {
        return { ok: false, stage: "search", error: "The user search base DN was not found" };
      }
      return { ok: true };
    });
  } catch (err) {
    const stage = err instanceof ResultCodeError ? progress.stage : "connect";
    return {
      ok: false,
      stage,
      error: err instanceof NoSuchObjectError && stage === "search"
        ? "The user search base DN was not found"
        : describeLdapError(err, config),
    };
  }
}
