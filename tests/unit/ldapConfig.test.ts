import { describe, expect, it } from "vitest";
import {
  DEFAULT_LDAP_USER_FILTER,
  ldapConfigSchema,
  parseLdapConfigInput,
  publicLdapConfig,
  readStoredLdapConfig,
  serializeLdapConfig,
} from "../../src/admin/authentication/ldapConfig.js";
import { SECRET_MASK } from "../../src/admin/adminRouteUtils.js";

const SECRET = "test-admin-secret-with-32-characters!";
const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";

const base = {
  url: "ldaps://ldap.example.test:636",
  bindDn: "cn=svc,dc=example,dc=test",
  bindPassword: "svc-secret",
  userSearchBaseDn: "ou=people,dc=example,dc=test",
};

function issueMessages(input: unknown): string[] {
  const result = ldapConfigSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

describe("ldapConfigSchema", () => {
  it("applies OpenLDAP-oriented defaults", () => {
    expect(ldapConfigSchema.parse(base)).toEqual({
      ...base,
      startTls: false,
      userSearchFilter: DEFAULT_LDAP_USER_FILTER,
      usernameAttribute: "uid",
      uniqueIdAttribute: "entryUUID",
      displayNameAttribute: "cn",
      timeoutMs: 5000,
    });
  });

  it("requires TLS: plaintext ldap:// is rejected unless StartTLS is enabled", () => {
    expect(issueMessages({ ...base, url: "ldap://ldap.example.test" })).toEqual([
      "url: must use ldaps:// or enable StartTLS; plaintext LDAP is not allowed",
    ]);
    expect(issueMessages({ ...base, url: "ldap://ldap.example.test", startTls: true })).toEqual([]);
    expect(issueMessages({ ...base, startTls: true })).toEqual(["startTls: applies only to ldap:// URLs"]);
  });

  it("rejects non-LDAP schemes and URLs with a DN, query, or credentials", () => {
    expect(issueMessages({ ...base, url: "https://ldap.example.test" })).toEqual(["url: must be an ldap:// or ldaps:// URL"]);
    expect(issueMessages({ ...base, url: "not a url" })).toEqual(["url: must be an ldap:// or ldaps:// URL"]);
    expect(issueMessages({ ...base, url: "ldaps://ldap.example.test/dc=example" })).toEqual(["url: must contain only a scheme, host, and port"]);
    expect(issueMessages({ ...base, url: "ldaps://user:pw@ldap.example.test" })).toEqual(["url: must contain only a scheme, host, and port"]);
  });

  it("requires the {username} placeholder and a parenthesized filter", () => {
    expect(issueMessages({ ...base, userSearchFilter: "(uid=alice)" })).toEqual([
      "userSearchFilter: must contain the {username} placeholder",
    ]);
    expect(issueMessages({ ...base, userSearchFilter: "uid={username}" })).toEqual([
      "userSearchFilter: must be a parenthesized LDAP filter",
    ]);
    expect(issueMessages({ ...base, userSearchFilter: "(&(uid={username})" })).toEqual([
      "userSearchFilter: must be a parenthesized LDAP filter",
    ]);
  });

  it("validates attribute names, CA bundles, and required fields", () => {
    expect(issueMessages({ ...base, usernameAttribute: "uid)(x" })).toEqual(["usernameAttribute: must be an LDAP attribute name"]);
    expect(issueMessages({ ...base, tlsCaCert: "not a pem" })).toEqual(["tlsCaCert: must be a PEM certificate bundle"]);
    expect(ldapConfigSchema.parse({ ...base, tlsCaCert: "  " }).tlsCaCert).toBeUndefined();
    expect(ldapConfigSchema.parse({ ...base, tlsCaCert: PEM }).tlsCaCert).toBe(PEM);
    expect(issueMessages({ ...base, bindPassword: "" })).toEqual(["bindPassword: is required"]);
  });
});

describe("stored LDAP config", () => {
  it("encrypts the bind password at rest and restores it on read", () => {
    const stored = serializeLdapConfig(ldapConfigSchema.parse(base), SECRET);
    const raw = JSON.parse(stored) as Record<string, unknown>;

    expect(raw["bindPassword"]).toMatch(/^veenc:v1:/);
    expect(stored).not.toContain("svc-secret");
    expect(readStoredLdapConfig(stored, SECRET).bindPassword).toBe("svc-secret");
  });

  it("refuses to serialize without ADMIN_AUTH_SECRET", () => {
    expect(() => serializeLdapConfig(ldapConfigSchema.parse(base), undefined)).toThrow(/ADMIN_AUTH_SECRET/);
  });

  it("fails closed when the stored password cannot be decrypted", () => {
    const stored = serializeLdapConfig(ldapConfigSchema.parse(base), SECRET);
    expect(() => readStoredLdapConfig(stored, "another-secret-with-32-characters!!")).toThrow(/cannot be decrypted/);
  });

  it("masks the bind password in public output", () => {
    const stored = serializeLdapConfig(ldapConfigSchema.parse(base), SECRET);

    expect(publicLdapConfig(stored)).toMatchObject({ url: base.url, bindPassword: SECRET_MASK });
    expect(publicLdapConfig("{}")).toEqual({ bindPassword: "" });
  });

  it("restores a masked or omitted password from the stored config during edits", () => {
    const stored = serializeLdapConfig(ldapConfigSchema.parse(base), SECRET);

    for (const bindPassword of [SECRET_MASK, "", undefined]) {
      const parsed = parseLdapConfigInput({ ...base, bindPassword }, stored, SECRET);
      expect(parsed.success && parsed.data.bindPassword).toBe("svc-secret");
    }
    const replaced = parseLdapConfigInput({ ...base, bindPassword: "new-secret" }, stored, SECRET);
    expect(replaced.success && replaced.data.bindPassword).toBe("new-secret");
    expect(parseLdapConfigInput({ ...base, bindPassword: SECRET_MASK }, null, SECRET).success).toBe(false);
  });
});
