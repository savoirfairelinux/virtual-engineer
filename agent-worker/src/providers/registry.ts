/**
 * Provider registry — maps an `AgentProvider` id to its runner implementation.
 *
 * Adding a new agent backend is a matter of implementing an `AgentRunner` and
 * registering it here; the orchestrator in `index.ts` dispatches purely through
 * `resolveRunner` and needs no provider-specific branching. An unknown provider
 * id is a hard error — there is no silent fallback.
 */
import { runClaudeAgent } from './claude.js';
import { runCopilotAgent } from './copilot.js';
import { runAiderAgent } from './aider.js';
import type { AgentProvider, AgentRunner } from './types.js';

const AGENT_RUNNERS: Record<AgentProvider, AgentRunner> = {
  copilot: runCopilotAgent,
  claude: runClaudeAgent,
  aider: runAiderAgent,
};

/** The set of supported agent provider ids. */
export const AGENT_PROVIDER_IDS = Object.keys(AGENT_RUNNERS) as AgentProvider[];

/** Type guard: true when `provider` is a supported agent provider id. */
export function isAgentProvider(provider: string): provider is AgentProvider {
  return Object.prototype.hasOwnProperty.call(AGENT_RUNNERS, provider);
}

/** Resolve the runner for a provider id. Throws on an unknown provider. */
export function resolveRunner(provider: string): AgentRunner {
  const runner = AGENT_RUNNERS[provider as AgentProvider];
  if (!runner) {
    throw new Error(
      `Unknown AGENT_PROVIDER "${provider}". Supported providers: ${AGENT_PROVIDER_IDS.join(', ')}.`,
    );
  }
  return runner;
}
