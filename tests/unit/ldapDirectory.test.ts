import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { ldapConfigSchema } from "../../src/admin/authentication/ldapConfig.js";
import {
  authenticateLdapAccount,
  authenticateLdapSubject,
  escapeLdapFilterValue,
  lookupLdapAccount,
  testLdapConnection,
} from "../../src/admin/authentication/ldapDirectory.js";
import { ldapAvailable, startLdapDirectoryServer, type LdapDirectoryServer } from "./helpers/ldapDirectoryServer.js";

describe("escapeLdapFilterValue", () => {
  it("escapes RFC 4515 special characters", () => {
    expect(escapeLdapFilterValue("a*b(c)d\\e\0f")).toBe("a\\2ab\\28c\\29d\\5ce\\00f");
    expect(escapeLdapFilterValue("*)(uid=*")).toBe("\\2a\\29\\28uid=\\2a");
    expect(escapeLdapFilterValue("émile")).toBe("émile");
  });
});

describe.skipIf(!ldapAvailable)("testLdapConnection (live slapd)", () => {
  let directory: LdapDirectoryServer;

  beforeAll(async () => {
    directory = await startLdapDirectoryServer();
  });

  afterAll(async () => {
    await directory.stop();
  });

  it("succeeds over LDAPS with the directory CA", async () => {
    await expect(testLdapConnection(ldapConfigSchema.parse(directory.config()))).resolves.toEqual({ ok: true });
  });

  it("succeeds over StartTLS", async () => {
    const config = ldapConfigSchema.parse(directory.config({ url: directory.ldapUrl, startTls: true }));
    await expect(testLdapConnection(config)).resolves.toEqual({ ok: true });
  });

  it("fails at connect when the server certificate is not trusted", async () => {
    const result = await testLdapConnection(ldapConfigSchema.parse(directory.config({ tlsCaCert: undefined })));

    expect(result).toMatchObject({ ok: false, stage: "connect" });
    expect(result.ok ? "" : result.error).toMatch(/certificate/i);
  });

  it("reports rejected service credentials at the bind stage without echoing the password", async () => {
    const result = await testLdapConnection(ldapConfigSchema.parse(directory.config({ bindPassword: "wrong-Secret-9" })));

    expect(result).toEqual({ ok: false, stage: "bind", error: "The directory rejected the bind credentials" });
  });

  it("reports a missing user search base at the search stage", async () => {
    const result = await testLdapConnection(ldapConfigSchema.parse(directory.config({ userSearchBaseDn: "ou=missing,dc=ve,dc=test" })));

    expect(result).toEqual({ ok: false, stage: "search", error: "The user search base DN was not found" });
  });

  it("fails at connect when nothing listens", async () => {
    const closed = directory.ldapsUrl.replace(/:\d+$/, ":1");
    const result = await testLdapConnection(ldapConfigSchema.parse(directory.config({ url: closed })));

    expect(result).toMatchObject({ ok: false, stage: "connect" });
  });
});

describe.skipIf(!ldapAvailable)("directory accounts (live slapd)", () => {
  let directory: LdapDirectoryServer;

  beforeAll(async () => {
    directory = await startLdapDirectoryServer();
    await directory.addUser("alice", "alice-Pass-1", { cn: "Alice Liddell" });
    await directory.addUser("twin-a", "twin-Pass-1", { sn: "twin" });
    await directory.addUser("twin-b", "twin-Pass-1", { sn: "twin" });
  });

  afterAll(async () => {
    await directory.stop();
  });

  function config(overrides: Record<string, unknown> = {}): ReturnType<typeof ldapConfigSchema.parse> {
    return ldapConfigSchema.parse(directory.config(overrides));
  }

  it("resolves an account's DN, entryUUID subject, username, and display name", async () => {
    const lookup = await lookupLdapAccount(config(), "alice");

    expect(lookup).toMatchObject({
      status: "found",
      account: { dn: "uid=alice,ou=people,dc=ve,dc=test", username: "alice", displayName: "Alice Liddell" },
    });
    const subject = lookup.status === "found" ? lookup.account.subject : "";
    expect(subject).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await expect(lookupLdapAccount(config(), "ALICE")).resolves.toMatchObject({ account: { subject, username: "alice" } });
  });

  it("reports missing, ambiguous, and injected names without matching them", async () => {
    await expect(lookupLdapAccount(config(), "nobody")).resolves.toEqual({ status: "not_found" });
    await expect(lookupLdapAccount(config(), "*")).resolves.toEqual({ status: "not_found" });
    await expect(lookupLdapAccount(config(), "alice)(uid=*")).resolves.toEqual({ status: "not_found" });
    await expect(lookupLdapAccount(config({ userSearchFilter: "(sn={username})" }), "twin")).resolves.toEqual({ status: "ambiguous" });
  });

  it("is unavailable when the subject attribute is missing or the service bind fails", async () => {
    await expect(lookupLdapAccount(config({ uniqueIdAttribute: "employeeNumber" }), "alice"))
      .resolves.toEqual({ status: "unavailable", error: "Directory entry has no employeeNumber value" });
    await expect(lookupLdapAccount(config({ bindPassword: "wrong-Secret-9" }), "alice"))
      .resolves.toEqual({ status: "unavailable", error: "The directory rejected the bind credentials" });
  });

  it("authenticates with the account password and rejects everything else", async () => {
    await expect(authenticateLdapAccount(config(), "alice", "alice-Pass-1"))
      .resolves.toMatchObject({ status: "authenticated", account: { username: "alice" } });
    await expect(authenticateLdapAccount(config(), "alice", "wrong-Pass-1")).resolves.toEqual({ status: "invalid_password" });
    await expect(authenticateLdapAccount(config(), "alice", "")).resolves.toEqual({ status: "rejected" });
    await expect(authenticateLdapAccount(config(), "nobody", "alice-Pass-1")).resolves.toEqual({ status: "rejected" });
    await expect(authenticateLdapAccount(config({ userSearchFilter: "(sn={username})" }), "twin", "twin-Pass-1"))
      .resolves.toEqual({ status: "rejected" });
  });

  it("authenticates over StartTLS and is unavailable when the directory is unreachable", async () => {
    await expect(authenticateLdapAccount(config({ url: directory.ldapUrl, startTls: true }), "alice", "alice-Pass-1"))
      .resolves.toMatchObject({ status: "authenticated" });
    const closed = directory.ldapsUrl.replace(/:\d+$/, ":1");
    await expect(authenticateLdapAccount(config({ url: closed }), "alice", "alice-Pass-1"))
      .resolves.toMatchObject({ status: "unavailable" });
  });

  it("authenticates a linked account by its subject after the directory renames it", async () => {
    await directory.addUser("carol", "carol-Pass-1");
    const before = await lookupLdapAccount(config(), "carol");
    const subject = before.status === "found" ? before.account.subject : "";
    const renamed = await directory.renameEntry("uid=carol,ou=people,dc=ve,dc=test", "uid=caroline");

    await expect(authenticateLdapSubject(config(), subject, "carol", "carol-Pass-1"))
      .resolves.toMatchObject({ status: "authenticated", account: { dn: renamed, subject, username: "caroline" } });
    await expect(authenticateLdapSubject(config(), subject, "carol", "wrong-Pass-1")).resolves.toEqual({ status: "invalid_password" });
    await expect(authenticateLdapSubject(config(), subject, "carol", "")).resolves.toEqual({ status: "rejected" });
    await expect(authenticateLdapSubject(config(), "00000000-0000-4000-8000-000000000000", "carol", "carol-Pass-1"))
      .resolves.toEqual({ status: "rejected" });
    // The configured user filter still restricts which entries can sign in.
    await expect(authenticateLdapSubject(config({ userSearchFilter: "(&(sn=twin)(uid={username}))" }), subject, "carol", "carol-Pass-1"))
      .resolves.toEqual({ status: "rejected" });
  });

  it("matches hex-looking subjects as text or as the bytes they encode", async () => {
    await directory.addUser("dave", "dave-Pass-1", { employeeNumber: "c0ffee" });

    await expect(authenticateLdapSubject(config({ uniqueIdAttribute: "employeeNumber" }), "c0ffee", "dave", "dave-Pass-1"))
      .resolves.toMatchObject({ status: "authenticated", account: { subject: "c0ffee", username: "dave" } });
  });
});

describe("testLdapConnection timeouts", () => {
  let silent: Server;
  let port: number;
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    silent = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", () => resolve()));
    const address = silent.address();
    port = typeof address === "object" && address ? address.port : 0;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  });

  it("gives up on an LDAPS server that accepts but never answers", async () => {
    const config = ldapConfigSchema.parse({
      url: `ldaps://127.0.0.1:${port}`,
      bindDn: "cn=svc,dc=ve,dc=test",
      bindPassword: "irrelevant",
      userSearchBaseDn: "dc=ve,dc=test",
      timeoutMs: 1000,
    });
    const started = Date.now();
    const result = await testLdapConnection(config);

    expect(result).toMatchObject({ ok: false, stage: "connect" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("gives up on a StartTLS server that never answers the upgrade", async () => {
    const config = ldapConfigSchema.parse({
      url: `ldap://127.0.0.1:${port}`,
      startTls: true,
      bindDn: "cn=svc,dc=ve,dc=test",
      bindPassword: "irrelevant",
      userSearchBaseDn: "dc=ve,dc=test",
      timeoutMs: 1000,
    });
    const started = Date.now();
    const result = await testLdapConnection(config);

    expect(result).toMatchObject({ ok: false, stage: "connect" });
    expect(Date.now() - started).toBeLessThan(6000);
  });
});
