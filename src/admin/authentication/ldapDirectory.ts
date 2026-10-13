import { isIP } from "node:net";
import type { ConnectionOptions } from "node:tls";
import { Client, InvalidCredentialsError, NoSuchObjectError, ResultCodeError } from "ldapts";
import type { LdapConfig } from "./ldapConfig.js";

export type LdapFailureStage = "connect" | "bind" | "search";

/** Upper bound on round trips per exchange (StartTLS, service bind, searches, user bind). */
const LDAP_EXCHANGE_OPERATIONS = 4;

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
