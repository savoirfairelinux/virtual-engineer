/**
 * Redact credentials embedded in HTTP(S) URLs.
 *
 * Replaces `https://user:secret@host/...` with `https://<redacted>@host/...`
 * so tokens never appear in logs, error messages, or external comments.
 */
export function redactUrls(text: string): string {
  return text.replace(/(https?:\/\/)[^@\s/][^@\s]*@/g, "$1<redacted>@");
}
