/**
 * A small curated denylist of the most commonly-used weak passwords, plus a
 * helper to test candidates against it. This is deliberately compact (not a
 * full "rockyou" list) — its goal is to reject the obvious, high-frequency
 * guesses an online password-spraying attack would try first, complementing
 * the minimum-length check and the login rate limiter. Comparison is
 * case-insensitive and ignores surrounding whitespace.
 */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "password",
  "password1",
  "password12",
  "password123",
  "password1234",
  "passw0rd",
  "passw0rd123",
  "12345678",
  "123456789",
  "1234567890",
  "1234512345",
  "11111111",
  "00000000",
  "qwerty",
  "qwertyui",
  "qwerty123",
  "qwertyuiop",
  "1q2w3e4r",
  "1qaz2wsx",
  "qazwsxedc",
  "abc12345",
  "abcd1234",
  "iloveyou",
  "letmein",
  "welcome",
  "welcome1",
  "welcome123",
  "admin123",
  "administrator",
  "adminadmin",
  "changeme",
  "changeme123",
  "trustno1",
  "sunshine",
  "princess",
  "football",
  "baseball",
  "superman",
  "batman",
  "master",
  "monkey123",
  "dragon123",
  "whatever",
  "starwars",
  "computer",
]);

/** Returns true when `password` is a well-known weak/common password. */
export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORDS.has(password.trim().toLowerCase());
}
