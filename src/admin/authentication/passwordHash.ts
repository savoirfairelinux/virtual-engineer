import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_SALT_LENGTH = 32;
// 128 * N * r = 16 MiB for the default params; give scrypt ample headroom.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/**
 * `crypto.scrypt()` has accepted `{ N, r, p }` cost-parameter options since
 * Node.js 10.5.0 (in addition to the `cost`/`blockSize`/`parallelization`
 * aliases) — this codebase targets Node 22+ (see `Dockerfile.orchestrator`),
 * so the options are always supported. Still, verify against the RFC 7914
 * §12 test vector (`scrypt("", "", N=16, r=1, p=1, dkLen=64)`) once at module
 * load: this proves N/r/p are actually wired into the KDF rather than
 * silently ignored (which would quietly weaken every password hash).
 */
const RFC7914_TEST_VECTOR =
  "77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede2144" +
  "2fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906";

function assertScryptSupportsNrp(): void {
  const derived = scryptSync("", "", 64, { N: 16, r: 1, p: 1, maxmem: SCRYPT_MAXMEM });
  if (derived.toString("hex") !== RFC7914_TEST_VECTOR) {
    throw new Error(
      "crypto.scrypt() did not honor the N/r/p cost parameters as expected on this Node.js " +
      "runtime (RFC 7914 test vector mismatch). Password hashing requires a Node.js version " +
      "with full scrypt N/r/p option support (Node.js >= 10.5)."
    );
  }
}
assertScryptSupportsNrp();

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  params: { N: number; r: number; p: number }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM }, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(derivedKey);
    });
  });
}

/** Hash a password with scrypt into the `scrypt:N:r:p:saltB64:hashB64` format. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_LENGTH);
  const key = await scryptAsync(password, salt, SCRYPT_KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("base64")}:${key.toString("base64")}`;
}

/** Verify a password against a stored `scrypt:N:r:p:saltB64:hashB64` hash. */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (
    !Number.isInteger(n) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    n <= 1 ||
    r <= 0 ||
    p <= 0 ||
    n > SCRYPT_N ||
    r > SCRYPT_R ||
    p > SCRYPT_P
  ) {
    return false;
  }
  const salt = Buffer.from(parts[4] ?? "", "base64");
  const expected = Buffer.from(parts[5] ?? "", "base64");
  if (salt.length !== SCRYPT_SALT_LENGTH || expected.length !== SCRYPT_KEY_LENGTH) return false;
  try {
    const actual = await scryptAsync(password, salt, expected.length, { N: n, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
