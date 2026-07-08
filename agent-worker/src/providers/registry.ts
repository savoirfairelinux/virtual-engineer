/**
 * Provider registry — maps an `AgentProvider` id to its runner implementation.
 *
 * Adding a new agent backend is a matter of implementing an `AgentRunner` and
 * registering it here; the orchestrator in `index.ts` dispatches purely through
 * `resolveRunner` and needs no provider-specific branching.
 */
import { runClaudeAgent } from './claude.js';
import { runCopilotAgent } from './copilot.js';
import type { AgentProvider, AgentRunner } from './types.js';

const AGENT_RUNNERS: Record<AgentProvider, AgentRunner> = {
  copilot: runCopilotAgent,
  claude: runClaudeAgent,
};

/** Resolve the runner for a provider id, falling back to Copilot for unknown ids. */
export function resolveRunner(provider: string): AgentRunner {
  return AGENT_RUNNERS[provider as AgentProvider] ?? AGENT_RUNNERS.copilot;
}
