import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { ldapConfigSchema } from "../../src/admin/authentication/ldapConfig.js";
import { escapeLdapFilterValue, testLdapConnection } from "../../src/admin/authentication/ldapDirectory.js";
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
