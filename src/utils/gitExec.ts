/**
 * Hardening helpers for host-side git commands that run against a working
 * directory the agent sandbox may have written to. They neutralise the
 * repository hooks, ext transport, `include.path` indirection, and user/system
 * configuration files. Returned layouts and local configuration must still be
 * validated and rebuilt before use.
 */

const TRUSTED_GIT_PREFIX = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "include.path=/dev/null",
  "-c", "protocol.ext.allow=never",
] as const;

export function trustedGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

export function trustedGitArgs(args: readonly string[]): string[] {
  return [...TRUSTED_GIT_PREFIX, ...args];
}
