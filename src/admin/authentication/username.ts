/** Normalize a username for storage/lookup: Unicode NFC + trim + lower-case. */
export function normalizeUsername(username: string): string {
  return username.normalize("NFC").trim().toLowerCase();
}
