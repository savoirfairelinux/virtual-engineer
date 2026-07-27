/**
 * Virtual Engineer — Agent Worker network egress guard.
 *
 * The agent must not reach arbitrary hosts on the internet — only its own LLM
 * API, which is handled by the SDK transport itself and never by an agent tool.
 * These helpers block the built-in web/URL fetch tools and any shell command
 * that reaches the network or pushes to a remote. File edits, local
 * `git commit`, builds and tests remain allowed.
 */
import { approveAll } from '@github/copilot-sdk';
import type { PermissionHandler, PermissionRequest } from '@github/copilot-sdk';

/**
 * Shell commands that reach the network. Covers standalone network clients and
 * every git subcommand that talks to a remote — the workspace is pre-cloned, so
 * the agent never needs any of these. Global git options (`-c key=val`, `-C dir`,
 * `--no-pager`, …) are tolerated between `git` and the remote subcommand so they
 * cannot be used to slip a `git -c … fetch` past the guard.
 */
export const NETWORK_TOOL_RE =
  /\b(?:curl|wget|nc|ncat|netcat|telnet|ssh|scp|sftp|ftp|lynx|links|aria2c)\b|\bgit(?:\s+(?:-[cC]\s+\S+|-{1,2}[\w][\w-]*(?:=\S+)?))*\s+(?:push|fetch|pull|clone|ls-remote|remote-update)\b/i;

/**
 * Claude tool-deny list. Bare names remove the tool from the model's context;
 * scoped `Bash(...)` rules block matching commands in every permission mode
 * (including `bypassPermissions`).
 *
 * NOTE: Claude's `Bash(...)` rules are prefix-glob, not regex, so — unlike the
 * Copilot {@link NETWORK_TOOL_RE} guard — they cannot match a remote git
 * subcommand hidden behind global options (`git -c … fetch`). Adding
 * `Bash(git -c:*)` / `Bash(git --no-pager:*)` would over-block legitimate git
 * usage (`git -c commit.gpgsign=false commit`, `git --no-pager log`), so the
 * list stays on the common direct forms; the container's network isolation is
 * the backstop for reordered-global bypasses.
 */
export const NETWORK_DISALLOWED_TOOLS = [
  'WebFetch',
  'WebSearch',
  'Bash(curl:*)',
  'Bash(wget:*)',
  'Bash(nc:*)',
  'Bash(ncat:*)',
  'Bash(netcat:*)',
  'Bash(telnet:*)',
  'Bash(ssh:*)',
  'Bash(scp:*)',
  'Bash(sftp:*)',
  'Bash(ftp:*)',
  'Bash(lynx:*)',
  'Bash(links:*)',
  'Bash(aria2c:*)',
  'Bash(git push:*)',
  'Bash(git fetch:*)',
  'Bash(git pull:*)',
  'Bash(git clone:*)',
  'Bash(git ls-remote:*)',
  'Bash(git remote-update:*)',
];

/** True when a shell command reaches the network or pushes to a remote. */
export function isBlockedNetworkCommand(command: string): boolean {
  return NETWORK_TOOL_RE.test(command);
}

/** Read the shell command text off a permission request (best-effort).
 *
 * The Copilot SDK is not strict about the field name, so pull the command from
 * every plausible field (and any `args` array) rather than trusting a single
 * key — a network command must never slip through because it landed in `command`
 * instead of `fullCommandText`.
 */
function readShellCommand(request: PermissionRequest): string {
  const candidate = request as unknown as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['fullCommandText', 'command', 'commandLine', 'cmd', 'script']) {
    const value = candidate[key];
    if (typeof value === 'string') parts.push(value);
  }
  const args = candidate['args'];
  if (Array.isArray(args)) {
    parts.push(args.filter((a): a is string => typeof a === 'string').join(' '));
  }
  return parts.join(' ');
}

function rejectPermission(feedback: string): ReturnType<PermissionHandler> {
  return { kind: 'reject', feedback };
}

/**
 * Copilot permission handler that denies internet access while approving
 * everything else. Denies the `url` (web fetch) tool outright and denies shell
 * commands that invoke network clients or remote git subcommands.
 */
export const restrictNetworkPermissionHandler: PermissionHandler = (request, invocation) => {
  if (request.kind === 'url') {
    return rejectPermission('Network access is disabled for this agent.');
  }
  if (request.kind === 'shell' && isBlockedNetworkCommand(readShellCommand(request))) {
    return rejectPermission('Network and remote commands are disabled for this agent.');
  }
  return approveAll(request, invocation);
};
