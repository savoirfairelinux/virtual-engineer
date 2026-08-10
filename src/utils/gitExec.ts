/**
 * Hardening helpers for host-side git commands that run against a working
 * directory the agent sandbox may have written to. They neutralise the
 * config-driven code-execution vectors git offers: repository hooks,
 * `include.path` indirection, and user/system configuration files.
 */

const TRUSTED_GIT_PREFIX = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "include.path=/dev/null",
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
