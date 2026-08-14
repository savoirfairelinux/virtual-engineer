/** Token-shaped values that must be masked regardless of the surrounding key. */
const TOKEN_VALUE = /(gh[opusr]_[A-Za-z0-9]{16,})|(github_pat_[A-Za-z0-9_]{16,})/g;
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/\s?#@]+@/gi;
const SCHEMELESS_USERINFO = /(^|[\s("'`])[^/\s:@]+:[^@\s/]+@(?=[A-Za-z0-9.-]+(?::\d+)?(?:[/:?#]|$))/g;
const SENSITIVE_QUERY = /([?&](?:access[_-]?token|api[_-]?key|apikey|client[_-]?secret|client[_-]?id|credential|password|passwd|private[_-]?token|secret|token|auth(?:orization)?)(?:=))([^&#\s]*)/gi;
const SENSITIVE_AUTH_PAIR = /((?:^|[\s,{(])["']?authorization["']?\s*[:=]\s*["']?)([^"'&,}]+)/gi;
const SENSITIVE_PAIR = /((?:^|[\s,{(])["']?(?:access[_-]?token|api[_-]?key|apikey|client[_-]?secret|client[_-]?id|credential|password|passwd|private[_-]?token|secret|token)["']?\s*[:=]\s*["']?)([^"'&,\s}]+)/gi;
const AUTH_SCHEME_VALUE = /((?:Bearer|Basic)\s+)[^\s"'&,}]+/gi;

const DEFAULT_ERROR_DETAIL_LIMIT = 500;

/**
 * Redact credentials embedded in HTTP(S) URLs and GitHub token-shaped values.
 *
 * Replaces `https://user:secret@host/...` with `https://<redacted>@host/...`
 * so tokens never appear in logs, error messages, or external comments.
 */
export function redactUrls(text: string): string {
  return text
    .replace(URL_USERINFO, "$1<redacted>@")
    .replace(SCHEMELESS_USERINFO, "$1<redacted>@")
    .replace(SENSITIVE_QUERY, "$1<redacted>")
    .replace(SENSITIVE_AUTH_PAIR, "$1<redacted>")
    .replace(AUTH_SCHEME_VALUE, "$1<redacted>")
    .replace(SENSITIVE_PAIR, "$1<redacted>")
    .replace(TOKEN_VALUE, "<redacted>");
}

/** Redact secrets and bound an upstream detail before placing it in an error. */
export function sanitizeErrorDetail(
  value: unknown,
  maxChars = DEFAULT_ERROR_DETAIL_LIMIT,
  fallback = "upstream request failed"
): string {
  const limit = Math.max(0, Math.floor(maxChars));
  const text = typeof value === "string" ? value : String(value);
  const redacted = redactUrls(text);
  if (redacted.length === 0) return fallback;
  return redacted.slice(0, limit);
}
