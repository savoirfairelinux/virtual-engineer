/**
 * Shared, provider-agnostic contracts for the agent worker.
 *
 * Every execution backend (Copilot, Claude, …) implements `AgentRunner` and
 * returns an `AgentRun`, so the orchestrator in `index.ts` can dispatch to any
 * provider through the registry without knowing provider-specific details.
 */

/** Options passed to a provider runner for a single agent session. */
export interface AgentRunOptions {
  /** Model override; when empty the provider selects its own default. */
  model: string;
  /** Permanent agent instructions appended to the provider's native foundation. */
  agentInstructions: string;
  /** Working directory — the pre-cloned repository root. */
  cwd: string;
  /** Hard timeout for the session, in milliseconds. */
  timeoutMs: number;
  /** Whether this is a code-generation or review session. */
  mode: 'codegen' | 'review';
  /** When true, surface repo-defined skills to the agent. */
  skillDiscovery?: boolean;
  /** Review-only integration-owned JSON Schema for native structured output. */
  reviewOutputSchema?: Record<string, unknown>;
}

/** Result of running one agent session, independent of the provider. */
export interface AgentRun {
  content: string;
  toolCallCount: number;
  toolsByKind: Record<string, number>;
  cleanup: () => Promise<void>;
}

/** A provider runner: executes one session and returns its result. */
export type AgentRunner = (prompt: string, options: AgentRunOptions) => Promise<AgentRun>;

export interface AgentProviderDefinition {
  id: string;
  adapterLabel: string;
  resolveModel: () => string;
  defaultModelLabel: string;
  validateEnvironment?: () => void;
  runner: AgentRunner;
}
