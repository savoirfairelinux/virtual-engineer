import { z } from "zod";
import { SECRET_MASK, asRecord } from "../adminRouteUtils.js";
import { decryptRequiredManagedCredential, encryptToken } from "../../utils/encryption.js";

const ATTRIBUTE_NAME = /^(?:[A-Za-z][A-Za-z0-9-]*|\d+(?:\.\d+)+)$/;
const attributeName = z.string().trim().regex(ATTRIBUTE_NAME, "must be an LDAP attribute name");
const distinguishedName = z.string().trim().min(1, "is required").max(1024);

export const DEFAULT_LDAP_USER_FILTER = "(&(objectClass=inetOrgPerson)(uid={username}))";

function isBalancedFilter(filter: string): boolean {
  if (!filter.startsWith("(") || !filter.endsWith(")")) return false;
  let depth = 0;
  for (let index = 0; index < filter.length; index++) {
    const char = filter[index];
    if (char === "\\") { index++; continue; }
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

const ldapConfigObject = z.object({
  url: z.string().trim().min(1, "is required").max(2048),
  startTls: z.boolean().default(false),
  /** PEM bundle trusted instead of the system CAs; required for private CAs. */
  tlsCaCert: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(65_536).optional()
  ),
  bindDn: distinguishedName,
  bindPassword: z.string().min(1, "is required").max(1024),
  userSearchBaseDn: distinguishedName,
  userSearchFilter: z.string().trim().max(2048).default(DEFAULT_LDAP_USER_FILTER)
    .refine((value) => value.includes("{username}"), "must contain the {username} placeholder")
    .refine(isBalancedFilter, "must be a parenthesized LDAP filter"),
  usernameAttribute: attributeName.default("uid"),
  uniqueIdAttribute: attributeName.default("entryUUID"),
  displayNameAttribute: attributeName.default("cn"),
  timeoutMs: z.number().int().min(1000).max(60_000).default(5000),
});

export const ldapConfigSchema = ldapConfigObject.superRefine((config, ctx) => {
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "must be an ldap:// or ldaps:// URL" });
    return;
  }
  if (url.protocol !== "ldap:" && url.protocol !== "ldaps:") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "must be an ldap:// or ldaps:// URL" });
    return;
  }
  if ((url.pathname !== "" && url.pathname !== "/") || url.search || url.hash || url.username || url.password) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "must contain only a scheme, host, and port" });
  }
  if (url.protocol === "ldap:" && !config.startTls) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "must use ldaps:// or enable StartTLS; plaintext LDAP is not allowed" });
  }
  if (url.protocol === "ldaps:" && config.startTls) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["startTls"], message: "applies only to ldap:// URLs" });
  }
  if (config.tlsCaCert !== undefined && !config.tlsCaCert.includes("-----BEGIN CERTIFICATE-----")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tlsCaCert"], message: "must be a PEM certificate bundle" });
  }
});

export type LdapConfig = z.output<typeof ldapConfigSchema>;

function isUnsetSecret(value: unknown): boolean {
  return value === undefined || value === null || value === "" || value === SECRET_MASK;
}

/** Decrypt and validate a stored `config_json`; throws when it cannot be used. */
export function readStoredLdapConfig(configJson: string, adminAuthSecret: string | undefined): LdapConfig {
  const stored = asRecord(JSON.parse(configJson));
  const bindPassword = stored["bindPassword"];
  return ldapConfigSchema.parse({
    ...stored,
    bindPassword: typeof bindPassword === "string" && bindPassword !== ""
      ? decryptRequiredManagedCredential(bindPassword, adminAuthSecret)
      : bindPassword,
  });
}

/** Serialize a validated config for storage with its bind password encrypted. */
export function serializeLdapConfig(config: LdapConfig, adminAuthSecret: string | undefined): string {
  return JSON.stringify({ ...config, bindPassword: encryptToken(config.bindPassword, adminAuthSecret) });
}

/** Stored config as returned by the admin API: the bind password is always masked. */
export function publicLdapConfig(configJson: string): Record<string, unknown> {
  let stored: Record<string, unknown>;
  try {
    stored = asRecord(JSON.parse(configJson));
  } catch {
    stored = {};
  }
  return { ...stored, bindPassword: isUnsetSecret(stored["bindPassword"]) ? "" : SECRET_MASK };
}

/**
 * Validate an admin API config payload. An omitted, empty, or masked bind
 * password is restored from `storedConfigJson` so edits never require re-entry.
 */
export function parseLdapConfigInput(
  input: unknown,
  storedConfigJson: string | null,
  adminAuthSecret: string | undefined
): z.SafeParseReturnType<unknown, LdapConfig> {
  const candidate = asRecord(input);
  if (isUnsetSecret(candidate["bindPassword"])) {
    const stored = storedConfigJson !== null ? asRecord(JSON.parse(storedConfigJson)) : {};
    const storedPassword = stored["bindPassword"];
    candidate["bindPassword"] = typeof storedPassword === "string" && storedPassword !== ""
      ? decryptRequiredManagedCredential(storedPassword, adminAuthSecret)
      : undefined;
  }
  return ldapConfigSchema.safeParse(candidate);
}
