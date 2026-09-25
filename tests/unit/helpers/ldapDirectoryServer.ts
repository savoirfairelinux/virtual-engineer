import { execFile, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Attribute, Change, Client } from "ldapts";

const execFileAsync = promisify(execFile);

export const LDAP_SUFFIX = "dc=ve,dc=test";
export const LDAP_PEOPLE_DN = `ou=people,${LDAP_SUFFIX}`;
export const LDAP_GROUPS_DN = `ou=groups,${LDAP_SUFFIX}`;
export const LDAP_SERVICE_DN = `cn=ve-service,ou=services,${LDAP_SUFFIX}`;
export const LDAP_SERVICE_PASSWORD = "service-Pass-1";
const ROOT_DN = `cn=admin,${LDAP_SUFFIX}`;
const ROOT_PASSWORD = "admin-Pass-1";

const BASE_SEED = `dn: ${LDAP_SUFFIX}
objectClass: dcObject
objectClass: organization
o: Virtual Engineer tests
dc: ve

dn: ${LDAP_PEOPLE_DN}
objectClass: organizationalUnit
ou: people

dn: ${LDAP_GROUPS_DN}
objectClass: organizationalUnit
ou: groups

dn: ou=services,${LDAP_SUFFIX}
objectClass: organizationalUnit
ou: services

dn: ${LDAP_SERVICE_DN}
objectClass: organizationalRole
objectClass: simpleSecurityObject
cn: ve-service
userPassword: ${LDAP_SERVICE_PASSWORD}
`;

interface SlapdInstall {
  slapd: string;
  slapadd: string;
  moduleDir: string;
  schemaDir: string;
  env: NodeJS.ProcessEnv;
}

function findLibraryDir(dir: string, depth: number): string | undefined {
  if (depth < 0 || !existsSync(dir)) return undefined;
  const entries = readdirSync(dir, { withFileTypes: true });
  if (entries.some((entry) => entry.name.startsWith("libslapi"))) return dir;
  for (const entry of entries) {
    const found = entry.isDirectory() ? findLibraryDir(join(dir, entry.name), depth - 1) : undefined;
    if (found) return found;
  }
  return undefined;
}

/**
 * `VE_SLAPD_ROOT` points at an extracted slapd package (`apt-get download slapd`
 * + `dpkg -x`), which runs without root and outside the system AppArmor profile;
 * otherwise the system install under `/` is used.
 */
function resolveSlapd(): SlapdInstall | null {
  const root = process.env["VE_SLAPD_ROOT"] ?? "/";
  const slapd = join(root, "usr/sbin/slapd");
  if (!existsSync(slapd)) return null;
  const libDir = root === "/" ? undefined : findLibraryDir(join(root, "usr/lib"), 2);
  const env = libDir
    ? { ...process.env, LD_LIBRARY_PATH: [libDir, process.env["LD_LIBRARY_PATH"]].filter(Boolean).join(":") }
    : process.env;
  if (spawnSync(slapd, ["-VV"], { env, stdio: "ignore" }).status !== 0) return null;
  return {
    slapd,
    slapadd: join(root, "usr/sbin/slapadd"),
    moduleDir: join(root, "usr/lib/ldap"),
    schemaDir: join(root, "etc/ldap/schema"),
    env,
  };
}

const slapdInstall = resolveSlapd();
if (!slapdInstall && process.env["VE_REQUIRE_LDAP_TESTS"] === "1") {
  throw new Error("VE_REQUIRE_LDAP_TESTS=1 but slapd is unavailable; install slapd or set VE_SLAPD_ROOT");
}

/** Whether a slapd binary is available; directory suites use `describe.skipIf(!ldapAvailable)`. */
export const ldapAvailable = slapdInstall !== null;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export interface LdapDirectoryServer {
  ldapUrl: string;
  ldapsUrl: string;
  caCert: string;
  /** A valid admin-API LDAP config for this directory (LDAPS + test CA + service account). */
  config(overrides?: Record<string, unknown>): Record<string, unknown>;
  /** Add an inetOrgPerson under ou=people and return its DN. */
  addUser(uid: string, password: string, attributes?: Record<string, string | string[]>): Promise<string>;
  /** Add a groupOfNames under ou=groups whose members are the given uids; returns its DN. */
  addGroup(cn: string, memberUids: string[]): Promise<string>;
  replaceAttribute(dn: string, attribute: string, values: string[]): Promise<void>;
  deleteEntry(dn: string): Promise<void>;
  stop(): Promise<void>;
}

/** Self-signed CA plus a localhost/127.0.0.1 server certificate for LDAPS and StartTLS. */
async function generateTls(tlsDir: string): Promise<void> {
  await mkdir(tlsDir, { recursive: true });
  const ext = join(tlsDir, "server.ext");
  await writeFile(ext, [
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "basicConstraints=CA:FALSE",
    "keyUsage=digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
  ].join("\n"));
  const file = (name: string): string => join(tlsDir, name);
  await execFileAsync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30", "-subj", "/CN=Virtual Engineer LDAP Test CA",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    "-keyout", file("ca.key"), "-out", file("ca.pem"),
  ]);
  await execFileAsync("openssl", [
    "req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", file("server.key"), "-out", file("server.csr"),
  ]);
  await execFileAsync("openssl", [
    "x509", "-req", "-days", "30", "-in", file("server.csr"), "-CA", file("ca.pem"), "-CAkey", file("ca.key"),
    "-CAcreateserial", "-extfile", ext, "-out", file("server.pem"),
  ]);
}

function slapdConfig(install: SlapdInstall, dir: string): string {
  return `include ${install.schemaDir}/core.schema
include ${install.schemaDir}/cosine.schema
include ${install.schemaDir}/inetorgperson.schema
modulepath ${install.moduleDir}
moduleload back_mdb.so
moduleload memberof.so
pidfile ${join(dir, "slapd.pid")}
TLSCACertificateFile ${join(dir, "tls", "ca.pem")}
TLSCertificateFile ${join(dir, "tls", "server.pem")}
TLSCertificateKeyFile ${join(dir, "tls", "server.key")}

database mdb
maxsize 67108864
suffix "${LDAP_SUFFIX}"
rootdn "${ROOT_DN}"
rootpw ${ROOT_PASSWORD}
directory ${join(dir, "data")}
index objectClass,uid,member,memberOf eq

access to attrs=userPassword
  by anonymous auth
  by * none
access to *
  by dn.exact="${LDAP_SERVICE_DN}" read
  by self read
  by * none

overlay memberof
memberof-group-oc groupOfNames
memberof-member-ad member
memberof-memberof-ad memberOf
memberof-refint TRUE
`;
}

async function waitForPort(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`slapd did not open port ${port}`);
}

async function stopSlapd(pidFile: string): Promise<void> {
  const pid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
  if (!Number.isInteger(pid) || pid <= 0) return;
  const alive = (): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (!alive()) return;
  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 100 && alive(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (alive()) process.kill(pid, "SIGKILL");
}

/** Start a private, loopback-only slapd instance seeded with the base tree. */
export async function startLdapDirectoryServer(): Promise<LdapDirectoryServer> {
  const install = slapdInstall;
  if (!install) throw new Error("slapd is unavailable; install slapd or set VE_SLAPD_ROOT");
  const instanceDir = await mkdtemp(join(tmpdir(), "ve-ldap-test-"));
  const configPath = join(instanceDir, "slapd.conf");
  const seedPath = join(instanceDir, "base-seed.ldif");
  const pidFile = join(instanceDir, "slapd.pid");
  const [ldapPort, ldapsPort] = [await freePort(), await freePort()];
  try {
    await mkdir(join(instanceDir, "data"));
    await generateTls(join(instanceDir, "tls"));
    await writeFile(configPath, slapdConfig(install, instanceDir));
    await writeFile(seedPath, BASE_SEED);
    await execFileAsync(install.slapadd, ["-q", "-f", configPath, "-l", seedPath], { env: install.env });
    // slapd daemonizes once its listeners are bound; the pid file is used to stop it.
    await execFileAsync(install.slapd, [
      "-f", configPath, "-h", `ldap://127.0.0.1:${ldapPort}/ ldaps://127.0.0.1:${ldapsPort}/`,
    ], { env: install.env });
    await waitForPort(ldapPort);
    await waitForPort(ldapsPort);
  } catch (err) {
    await stopSlapd(pidFile);
    await rm(instanceDir, { recursive: true, force: true });
    throw err;
  }
  const caCert = await readFile(join(instanceDir, "tls", "ca.pem"), "utf8");
  const ldapUrl = `ldap://127.0.0.1:${ldapPort}`;
  const ldapsUrl = `ldaps://127.0.0.1:${ldapsPort}`;

  async function asDirectoryAdmin<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ url: ldapsUrl, tlsOptions: { ca: [caCert] } });
    try {
      await client.bind(ROOT_DN, ROOT_PASSWORD);
      return await operation(client);
    } finally {
      await client.unbind();
    }
  }

  return {
    ldapUrl,
    ldapsUrl,
    caCert,
    config(overrides = {}) {
      return {
        url: ldapsUrl,
        tlsCaCert: caCert,
        bindDn: LDAP_SERVICE_DN,
        bindPassword: LDAP_SERVICE_PASSWORD,
        userSearchBaseDn: LDAP_PEOPLE_DN,
        ...overrides,
      };
    },
    async addUser(uid, password, attributes = {}) {
      const dn = `uid=${uid},${LDAP_PEOPLE_DN}`;
      await asDirectoryAdmin((client) => client.add(dn, {
        objectClass: "inetOrgPerson",
        uid,
        cn: uid,
        sn: uid,
        userPassword: password,
        ...attributes,
      }));
      return dn;
    },
    async addGroup(cn, memberUids) {
      const dn = `cn=${cn},${LDAP_GROUPS_DN}`;
      await asDirectoryAdmin((client) => client.add(dn, {
        objectClass: "groupOfNames",
        cn,
        member: memberUids.map((uid) => `uid=${uid},${LDAP_PEOPLE_DN}`),
      }));
      return dn;
    },
    async replaceAttribute(dn, attribute, values) {
      await asDirectoryAdmin((client) => client.modify(dn, new Change({
        operation: "replace",
        modification: new Attribute({ type: attribute, values }),
      })));
    },
    async deleteEntry(dn) {
      await asDirectoryAdmin((client) => client.del(dn));
    },
    async stop() {
      await stopSlapd(pidFile);
      await rm(instanceDir, { recursive: true, force: true });
    },
  };
}
