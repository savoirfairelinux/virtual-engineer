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

/** Env-var names whose values must never be logged. */
const SENSITIVE_KEY =
  /(?:^|[_-])(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|PRIVATE[_-]?KEY|API[_-]?KEY|KEY|AUTH|PAT)(?:$|[_-])/i;

function redactSensitiveAssignment(arg: string): string | undefined {
  const prefix = arg.startsWith("--env=") ? "--env=" : "";
  const assignment = prefix ? arg.slice(prefix.length) : arg;
  const separator = assignment.indexOf("=");
  if (separator <= 0 || !SENSITIVE_KEY.test(assignment.slice(0, separator))) {
    return undefined;
  }
  return `${prefix}${assignment.slice(0, separator)}=<redacted>`;
}

/**
 * Redact secrets from a Docker argv array before logging.
 *
 * Masks the value of any `NAME=VALUE` argument whose name looks sensitive
 * (e.g. `GITHUB_TOKEN=...`, `COPILOT_SDK_AUTH_TOKEN=...`), strips credentials
 * embedded in URLs, and masks any stray GitHub token-shaped values.
 */
export function redactDockerArgs(args: readonly string[]): string[] {
  return args.map((arg) => {
    const redactedAssignment = redactSensitiveAssignment(arg);
    if (redactedAssignment !== undefined) {
      return redactedAssignment;
    }
    return redactUrls(arg);
  });
}
