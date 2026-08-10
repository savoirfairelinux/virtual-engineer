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
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { emitEvent } from './providers/events.js';

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

function isWithinDirectory(directory: string, candidate: string): boolean {
  const relativePath = relative(directory, candidate);
  return relativePath === '' || (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function isRepositoryRead(request: PermissionRequest, workspaceRoot: string): boolean {
  const details = request as unknown as Record<string, unknown>;
  const requestedPath = details['path'];
  if (typeof requestedPath !== 'string' || requestedPath.trim() === '') return false;

  try {
    const resolvedRoot = resolve(workspaceRoot);
    const resolvedPath = resolve(resolvedRoot, requestedPath);
    if (!isWithinDirectory(resolvedRoot, resolvedPath)) return false;

    const realRoot = realpathSync(resolvedRoot);
    const realPath = realpathSync(resolvedPath);
    return isWithinDirectory(realRoot, realPath);
  } catch {
    return false;
  }
}

function isReviewSubmission(request: PermissionRequest): boolean {
  if (request.kind !== 'mcp') return false;
  const details = request as unknown as Record<string, unknown>;
  const serverName = details['serverName'];
  const toolName = details['toolName'];
  if (serverName === 've-submission') {
    return toolName === 've_submit_review' || toolName === 've-submission-ve_submit_review';
  }
  if (serverName === 'virtual-engineer-submission') {
    return toolName === 've_submit_review' ||
      toolName === 'virtual-engineer-submission-ve_submit_review';
  }
  return false;
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

/**
 * Copilot review sessions inspect untrusted changes and must not mutate the
 * workspace or execute commands. Allow repository reads and the single VE
 * review-submission tool; reject every other capability.
 */
export function createReviewPermissionHandler(workspaceRoot: string): PermissionHandler {
  return (request, invocation) => {
    if (request.kind === 'read' && isRepositoryRead(request, workspaceRoot)) {
      return approveAll(request, invocation);
    }
    if (isReviewSubmission(request)) {
      return approveAll(request, invocation);
    }
    return rejectPermission('Review sessions may only read repository files and submit the final review.');
  };
}

export function createNativeReviewPermissionHandler(workspaceRoot: string): PermissionHandler {
  const reviewHandler = createReviewPermissionHandler(workspaceRoot);
  return (request, invocation) => {
    if (request.kind === 'custom-tool') {
      const details = request as unknown as Record<string, unknown>;
      const args = details['args'];
      const toolArgs = typeof args === 'object' && args !== null
        ? args as Record<string, unknown>
        : {};
      if (
        details['toolName'] === 'task' &&
        toolArgs['agent_type'] === 'code-review' &&
        toolArgs['mode'] === 'sync'
      ) {
        return approveAll(request, invocation);
      }
      return rejectPermission('Native review may only delegate once to the synchronous code-review task.');
    }
    return reviewHandler(request, invocation);
  };
}


/**
 * Parse a newline-separated tool-list env var into a trimmed, de-duplicated,
 * empty-dropped string array. Returns `[]` for undefined / blank input so
 * callers can treat "unset" and "empty" identically.
 */
export function parseToolList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw.split('\n')) {
    const trimmed = entry.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Extract a tool identity from a Copilot `PermissionRequest` for matching. */
function requestToolIdentity(request: PermissionRequest): { toolName: string; rawCommand?: string } {
  const details = request as unknown as Record<string, unknown>;
  switch (request.kind) {
    case 'shell':
      return { toolName: 'Bash', rawCommand: readShellCommand(request) };
    case 'url':
      return { toolName: 'WebFetch' };
    case 'read':
      return { toolName: 'Read' };
    case 'write':
      return { toolName: 'Write' };
    case 'mcp': {
      const server = typeof details['serverName'] === 'string' ? details['serverName'] : '';
      const tool = typeof details['toolName'] === 'string' ? details['toolName'] : '';
      return { toolName: tool ? `mcp__${server}__${tool}` : `mcp__${server}` };
    }
    case 'custom-tool': {
      const tool = typeof details['toolName'] === 'string' ? details['toolName'] : '';
      return { toolName: tool };
    }
    default:
      return { toolName: request.kind };
  }
}

/** Match a tool identity against a list of patterns (bare names + scoped). */
function matchesToolPattern(identity: { toolName: string; rawCommand?: string }, patterns: string[]): boolean {
  const { toolName, rawCommand } = identity;
  for (const pattern of patterns) {
    const open = pattern.indexOf('(');
    if (open === -1) {
      // Bare name: exact match.
      if (pattern === toolName) return true;
      continue;
    }
    const patTool = pattern.slice(0, open);
    const specRaw = pattern.slice(open + 1, pattern.endsWith(')') ? -1 : undefined);
    if (patTool !== toolName) continue;
    // Scoped pattern `Tool(prefix:*)` — prefix-glob match on the shell command.
    if (patTool === 'Bash' && rawCommand !== undefined) {
      const prefix = specRaw.endsWith(':*') ? specRaw.slice(0, -2) : specRaw;
      if (prefix === '' || rawCommand.trimStart().startsWith(prefix)) return true;
      continue;
    }
    // Non-Bash scoped patterns: exact specifier match (best-effort).
    if (specRaw === '*' || specRaw === rawCommand) return true;
  }
  return false;
}

/**
 * Wrap a Copilot permission handler with a per-agent blocked-tool list.
 *
 * Everything is allowed by default. Decision order:
 * 1. If the tool matches `blockedTools`, reject and emit `permission.denied`.
 * 2. Delegate to `inner`; if it rejects, emit `permission.denied`; if it
 *    approves, emit `permission.approved`.
 *
 * The inner handler (e.g. {@link restrictNetworkPermissionHandler}) enforces
 * VE's network floor, so the user blocklist can only tighten it — never relax
 * it. A blocked network tool stays blocked even if the user never lists it.
 */
export function createToolAuthorizingPermissionHandler(
  inner: PermissionHandler,
  opts: { blockedTools?: string[] },
): PermissionHandler {
  const blocked = opts.blockedTools ?? [];
  return async (request, invocation) => {
    const identity = requestToolIdentity(request);
    if (matchesToolPattern(identity, blocked)) {
      emitEvent('permission.denied', {
        toolName: identity.toolName,
        reason: `Tool '${identity.toolName}' is blocked for this agent.`,
      });
      return { kind: 'reject', feedback: `Tool '${identity.toolName}' is blocked for this agent.` };
    }
    const result = await inner(request, invocation);
    if (result.kind === 'reject') {
      // The inner handler rejected (network floor, review floor, etc.). The
      // wrapper is the single emission point for permission events, so emit
      // the denial here with the tool identity extracted from the request.
      const feedback = typeof (result as { feedback?: unknown }).feedback === 'string'
        ? (result as { feedback: string }).feedback
        : 'rejected by provider permission policy';
      emitEvent('permission.denied', { toolName: identity.toolName, reason: feedback });
    } else {
      emitEvent('permission.approved', { toolName: identity.toolName });
    }
    return result;
  };
}
