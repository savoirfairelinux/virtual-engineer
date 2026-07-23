/**
 * Provider registry — maps an `AgentProvider` id to its runner implementation.
 *
 * Adding a new agent backend is a matter of implementing an
 * `AgentProviderDefinition` and registering it here; the orchestrator in
 * `index.ts` dispatches through `resolveProvider` without provider-specific
 * branching. An unknown provider id is a hard error — there is no silent fallback.
 */
import { CLAUDE_PROVIDER } from './claude.js';
import { COPILOT_PROVIDER } from './copilot.js';
import { AIDER_PROVIDER } from './aider.js';
import type { AgentProviderDefinition } from './types.js';

const AGENT_PROVIDERS = new Map<string, AgentProviderDefinition>(
  [COPILOT_PROVIDER, CLAUDE_PROVIDER, AIDER_PROVIDER].map((provider) => [provider.id, provider])
);

/** The set of supported agent provider ids. */
export const AGENT_PROVIDER_IDS = [...AGENT_PROVIDERS.keys()];

/** Type guard: true when `provider` is a supported agent provider id. */
export function isAgentProvider(provider: string): boolean {
  return AGENT_PROVIDERS.has(provider);
}

/** Resolve the complete provider definition. Throws on an unknown provider. */
export function resolveProvider(provider: string): AgentProviderDefinition {
  const definition = AGENT_PROVIDERS.get(provider);
  if (!definition) {
    throw new Error(
      `Unknown AGENT_PROVIDER "${provider}". Supported providers: ${AGENT_PROVIDER_IDS.join(', ')}.`,
    );
  }
  return definition;
}
