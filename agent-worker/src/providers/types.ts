/**
 * Shared, provider-agnostic contracts for the agent worker.
 *
 * Every execution backend (Copilot, Claude, …) implements `AgentRunner` and
 * returns an `AgentRun`, so the orchestrator in `index.ts` can dispatch to any
 * provider through the registry without knowing provider-specific details.
 */

/** Supported agent execution providers. */
export type AgentProvider = 'copilot' | 'claude';

/** Options passed to a provider runner for a single agent session. */
export interface AgentRunOptions {
  /** Model override; when empty the provider selects its own default. */
  model: string;
  /** System / instructions prompt injected into the session. */
  systemPrompt: string;
  /** Working directory — the pre-cloned repository root. */
  cwd: string;
  /** Hard timeout for the session, in milliseconds. */
  timeoutMs: number;
  /** Whether this is a code-generation or review session. */
  mode: 'codegen' | 'review';
  /** When true, surface repo-defined skills to the agent. */
  skillDiscovery?: boolean;
  /** Copilot only: reasoning effort forwarded to the SDK session. */
  reasoningEffort?: string;
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
