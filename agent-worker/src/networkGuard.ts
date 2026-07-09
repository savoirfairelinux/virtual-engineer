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
 * the agent never needs any of these.
 */
export const NETWORK_TOOL_RE =
  /\b(?:curl|wget|nc|ncat|netcat|telnet|ssh|scp|sftp|ftp|lynx|links|aria2c)\b|\bgit\s+(?:push|fetch|pull|clone|ls-remote|remote-update)\b/i;

/**
 * Claude tool-deny list. Bare names remove the tool from the model's context;
 * scoped `Bash(...)` rules block matching commands in every permission mode
 * (including `bypassPermissions`).
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

/** Read the shell command text off a permission request (best-effort). */
function readShellCommand(request: PermissionRequest): string {
  const candidate = request as { fullCommandText?: unknown };
  return typeof candidate.fullCommandText === 'string' ? candidate.fullCommandText : '';
}

/**
 * Copilot permission handler that denies internet access while approving
 * everything else. Denies the `url` (web fetch) tool outright and denies shell
 * commands that invoke network clients or `git push`.
 */
export const restrictNetworkPermissionHandler: PermissionHandler = (request, invocation) => {
  if (request.kind === 'url') {
    return { kind: 'reject', feedback: 'Network access is disabled for this agent.' };
  }
  if (request.kind === 'shell' && isBlockedNetworkCommand(readShellCommand(request))) {
    return { kind: 'reject', feedback: 'Network and push commands are disabled for this agent.' };
  }
  return approveAll(request, invocation);
};
