/**
 * Password-strength scorer.
 *
 * Returns one of four levels based on character-class diversity and length.
 * This replaces a static denylist: instead of blocking specific strings,
 * we reject passwords that rely on a single character class (e.g. all
 * lower-case letters), which are trivially brute-forced regardless of whether
 * they appear in a known wordlist.
 *
 * Four character classes: lowercase, uppercase, digit, symbol.
 * Levels:
 *   weak       — only one class present (e.g. all lower-case)
 *   fair       — two classes (e.g. lower + digit)
 *   strong     — three classes, or two classes with length ≥ 16
 *   very-strong — all four classes
 */
export type PasswordStrength = "weak" | "fair" | "strong" | "very-strong";

export function getPasswordStrength(password: string): PasswordStrength {
  if (password.length < 8) return "weak";
  let classes = 0;
  if (/[a-z]/.test(password)) classes++;
  if (/[A-Z]/.test(password)) classes++;
  if (/[0-9]/.test(password)) classes++;
  if (/[^a-zA-Z0-9]/.test(password)) classes++;
  if (classes <= 1) return "weak";
  if (classes === 4) return "very-strong";
  if (classes === 3 || (classes === 2 && password.length >= 16)) return "strong";
  return "fair";
}
