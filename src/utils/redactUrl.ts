/** Token-shaped values that must be masked regardless of the surrounding key. */
const TOKEN_VALUE = /(gh[opusr]_[A-Za-z0-9]{16,})|(github_pat_[A-Za-z0-9_]{16,})/g;

/**
 * Redact credentials embedded in HTTP(S) URLs and GitHub token-shaped values.
 *
 * Replaces `https://user:secret@host/...` with `https://<redacted>@host/...`
 * so tokens never appear in logs, error messages, or external comments.
 */
export function redactUrls(text: string): string {
  return text
    .replace(/(https?:\/\/)[^/\s?#@]+@/gi, "$1<redacted>@")
    .replace(TOKEN_VALUE, "<redacted>");
}
