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
  /** Review-only execution strategy selected by the agent configuration. */
  reviewStrategy?: 've_direct' | 'copilot_native' | 'goose_native' | 'codex_native';
  /** Review-only integration-owned JSON Schema for native structured output. */
  reviewOutputSchema?: Record<string, unknown>;
  /**
   * Per-agent blocked tool list (Claude/Copilot). Everything is allowed by
   * default; a tool here is rejected. Patterns follow the provider's native
   * syntax (bare names, `Bash(prefix:*)`, `mcp__server__tool`). Merges with
   * VE's built-in network restrictions — the floor cannot be relaxed.
   */
  blockedTools?: string[];
  /**
   * Provider-specific tooling toggles for providers without native per-tool
   * lists (Aider capability flags, Goose extension/mode). Opaque to the
   * shared runner; each provider interprets its own shape.
   */
  toolAuthorization?: Record<string, unknown>;
}

export interface ObservedToolCall {
  callId?: string;
  name: string;
  input: Record<string, unknown>;
  success?: boolean;
  error?: string;
}

/** Result of running one agent session, independent of the provider. */
export interface AgentRun {
  content: string;
  toolCallCount: number;
  toolsByKind: Record<string, number>;
  toolCalls?: ObservedToolCall[];
  cleanup: () => Promise<void>;
}

/** A provider runner: executes one session and returns its result. */
export type AgentRunner = (prompt: string, options: AgentRunOptions) => Promise<AgentRun>;

export interface AgentProviderDefinition {
  id: string;
  adapterLabel: string;
  resolveModel: () => string;
  defaultModelLabel: string;
  /** Native MCP submission or validated text fallback used by this provider. */
  submissionTransport: 'mcp' | 'text';
  validateEnvironment?: () => void;
  runner: AgentRunner;
}
