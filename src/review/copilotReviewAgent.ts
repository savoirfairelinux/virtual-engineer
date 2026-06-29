import { createRequire } from "node:module";
import { getLogger } from "../logger.js";
import type { ReviewAgent } from "./reviewOrchestrator.js";
import type { ExternalChangeId } from "../interfaces.js";

const log = getLogger("copilot-review-agent");

/**
 * Minimal subset of the `@github/copilot-sdk` API we rely on. Declaring it
 * locally avoids a build-time hard dependency on the SDK's exact d.ts shape
 * and lets tests inject a fake `createClient`.
 */
export interface CopilotSdkSession {
  sendAndWait(input: { prompt: string }, timeoutMs?: number): Promise<unknown>;
  on(eventType: string, handler: (event: unknown) => void): (() => void) | void;
}
export interface CopilotSdkClient {
  createSession(opts: {
    model?: string | undefined;
    workingDirectory?: string | undefined;
    systemMessage?: { content: string } | undefined;
    onPermissionRequest?: ((req: unknown) => unknown) | undefined;
    infiniteSessions?: { enabled: boolean } | undefined;
  }): Promise<CopilotSdkSession>;
}
export type CopilotSdkClientFactory = (opts: { env: NodeJS.ProcessEnv; githubToken: string }) => CopilotSdkClient;

/**
 * Structured event emitted from the SDK session during a review.
 * Matches the shape the agent-worker emits on stderr so both execution
 * paths produce identical event streams.
 */
export interface ReviewStreamEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface CopilotReviewAgentConfig {
  /** GitHub token used to authenticate the review-side Copilot SDK client. */
  githubToken: string;
  /** Override the model (defaults to whatever the integration is configured with). */
  model?: string | undefined;
  /** System prompt for the review session. Loaded from DB (review-system-* prompt). */
  systemPrompt: string;
  /** SDK client factory. Defaults to `@github/copilot-sdk`'s CopilotClient. */
  createClient?: CopilotSdkClientFactory | undefined;
  /** Hard upper bound on a single review call (ms). */
  timeoutMs?: number | undefined;
}

// 9 minutes: slightly under the agent-worker sendAndWait timeout so the orchestrator can surface a clean error first.
const DEFAULT_TIMEOUT_MS = 9 * 60 * 1000; // 9 minutes

/** Copilot-backed `ReviewAgent`. Shares the same integration as the code-gen adapter. */
export class CopilotReviewAgent implements ReviewAgent {
  private readonly githubToken: string;
  private readonly model: string | undefined;
  private readonly systemPrompt: string;
  private readonly createClient: CopilotSdkClientFactory;
  private readonly timeoutMs: number;

  constructor(config: CopilotReviewAgentConfig) {
    const githubToken = config.githubToken.trim();
    if (githubToken.length === 0) {
      throw new Error("CopilotReviewAgent: githubToken is required");
    }
    this.githubToken = githubToken;
    this.model = config.model;
    this.systemPrompt = config.systemPrompt.trim();
    if (this.systemPrompt.length === 0) {
      throw new Error("CopilotReviewAgent: systemPrompt must not be empty");
    }
    this.createClient = config.createClient ?? defaultCreateClient;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Run a single code-review session and return the raw text output from the agent. */
  async runReview(
    input: {
      changeId: ExternalChangeId;
      patchset: number;
      project: string;
      prompt: string;
      workingDirectory?: string | undefined;
    },
    onEvent?: ((event: ReviewStreamEvent) => void) | undefined,
  ): Promise<{ rawOutput: string }> {
    log.info(
      { changeId: input.changeId, patchset: input.patchset, project: input.project },
      "running Copilot review session"
    );

    const client = this.createClient({ env: { ...process.env, GITHUB_TOKEN: this.githubToken }, githubToken: this.githubToken });
    const session = await client.createSession({
      ...(this.model !== undefined ? { model: this.model } : {}),
      ...(input.workingDirectory !== undefined ? { workingDirectory: input.workingDirectory } : {}),
      systemMessage: { content: this.systemPrompt },
      infiniteSessions: { enabled: false },
    });

    // Register SDK event handlers so callers get live streaming events.
    if (onEvent !== undefined && typeof session.on === "function") {
      registerReviewEventHandlers(session, onEvent);
    }

    const response = await session.sendAndWait({ prompt: input.prompt }, this.timeoutMs);
    const rawOutput = extractContent(response);
    if (!rawOutput || rawOutput.trim().length === 0) {
      throw new Error("Copilot review session returned empty / no content");
    }
    return { rawOutput };
  }
}

/**
 * Walk a few common SDK response shapes to pull out the assistant text.
 * The SDK has shifted between `{content}`, `{text}`, `{message:{content}}`,
 * and array-of-messages over its 0.x releases; we accept all of them.
 */
function extractContent(response: unknown): string | null {
  if (response == null) return null;
  if (typeof response === "string") return response;
  if (typeof response !== "object") return null;
  const r = response as Record<string, unknown>;

  // Primary SDK shape: assistant.message event { type, data: { content } }
  const data = r["data"];
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d["content"] === "string") return d["content"] as string;
  }

  if (typeof r["content"] === "string") return r["content"] as string;
  if (typeof r["text"] === "string") return r["text"] as string;
  if (typeof r["output"] === "string") return r["output"] as string;

  const message = r["message"];
  if (message && typeof message === "object") {
    const m = message as Record<string, unknown>;
    if (typeof m["content"] === "string") return m["content"] as string;
  }

  const messages = r["messages"];
  if (Array.isArray(messages)) {
    // Use the last assistant message with non-empty content.
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && typeof m === "object") {
        const c = (m as Record<string, unknown>)["content"];
        if (typeof c === "string" && c.trim().length > 0) return c;
      }
    }
  }

  return null;
}

/**
 * Deep-find a string value for any of the given keys within a nested object.
 */
function deepFindStr(obj: unknown, keys: string[]): string | null {
  const seen = new Set<unknown>();
  function visit(value: unknown): string | null {
    if (!value || typeof value !== "object") return null;
    if (seen.has(value)) return null;
    seen.add(value);
    const rec = value as Record<string, unknown>;
    for (const k of keys) {
      if (typeof rec[k] === "string" && (rec[k] as string).trim()) return rec[k] as string;
    }
    for (const nested of Object.values(rec)) {
      const found = visit(nested);
      if (found !== null) return found;
    }
    return null;
  }
  return visit(obj);
}

/**
 * Deep-find a numeric value for any of the given keys within a nested object.
 */
function deepFindNum(obj: unknown, keys: string[]): number | null {
  const seen = new Set<unknown>();
  function visit(value: unknown): number | null {
    if (!value || typeof value !== "object") return null;
    if (seen.has(value)) return null;
    seen.add(value);
    const rec = value as Record<string, unknown>;
    for (const k of keys) {
      if (typeof rec[k] === "number" && Number.isFinite(rec[k])) return rec[k] as number;
    }
    for (const nested of Object.values(rec)) {
      const found = visit(nested);
      if (found !== null) return found;
    }
    return null;
  }
  return visit(obj);
}

/**
 * Register SDK event handlers on a session so callers receive structured
 * events identical to those the agent-worker emits on stderr.
 */
function registerReviewEventHandlers(
  session: CopilotSdkSession,
  onEvent: (event: ReviewStreamEvent) => void,
): void {
  session.on("tool.execution_start", (e: unknown) => {
    const name = deepFindStr(e, ["name", "toolName", "tool_name"]) ?? "unknown_tool";
    onEvent({ type: "tool.execution_start", data: { name } });
  });
  session.on("tool.execution_complete", (e: unknown) => {
    const name = deepFindStr(e, ["name", "toolName", "tool_name"]) ?? "unknown_tool";
    const output = deepFindStr(e, ["output", "result", "content"]);
    onEvent({ type: "tool.execution_complete", data: { name, output: output ? output.slice(0, 800) : null } });
  });
  session.on("tool.execution_progress", (e: unknown) => {
    const name = deepFindStr(e, ["name", "toolName", "tool_name"]) ?? "unknown_tool";
    onEvent({ type: "tool.execution_progress", data: { name, message: deepFindStr(e, ["message", "progress", "text"]) } });
  });
  session.on("assistant.streaming_delta", (e: unknown) => {
    const delta = deepFindStr(e, ["delta", "content", "text"]);
    if (delta) onEvent({ type: "assistant.streaming_delta", data: { delta } });
  });
  session.on("assistant.message", (e: unknown) => {
    const content = deepFindStr(e, ["content", "text", "message"]);
    onEvent({ type: "assistant.message", data: { content: content ? content.slice(0, 3000) : null } });
  });
  session.on("assistant.usage", (e: unknown) => {
    onEvent({
      type: "assistant.usage",
      data: {
        inputTokens: deepFindNum(e, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]),
        outputTokens: deepFindNum(e, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]),
        cacheReadTokens: deepFindNum(e, ["cacheReadTokens", "cache_read_tokens", "cacheReadInputTokens"]),
        cacheWriteTokens: deepFindNum(e, ["cacheWriteTokens", "cache_write_tokens", "cacheCreationInputTokens"]),
        cost: deepFindNum(e, ["cost"]),
        totalNanoAiu: deepFindNum(e, ["totalNanoAiu", "total_nano_aiu"]),
        apiCallId: deepFindStr(e, ["apiCallId", "api_call_id"]),
        providerCallId: deepFindStr(e, ["providerCallId", "provider_call_id"]),
        model: deepFindStr(e, ["model"]),
      },
    });
  });
  session.on("session.usage_info", (e: unknown) => {
    onEvent({
      type: "session.usage_info",
      data: {
        tokenLimit: deepFindNum(e, ["tokenLimit"]),
        currentTokens: deepFindNum(e, ["currentTokens"]),
      },
    });
  });
  session.on("session.error", (e: unknown) => {
    const msg = deepFindStr(e, ["message", "error", "reason"]) ?? String(e);
    onEvent({ type: "session.error", data: { message: msg } });
  });
}

/**
 * Lazy default factory: only requires the SDK when actually invoked, so tests
 * that inject `createClient` never touch the real package.
 */
const defaultCreateClient: CopilotSdkClientFactory = ({ env, githubToken }) => {
  // `@github/copilot-sdk` is a CJS module; use createRequire to load it from
  // an ESM source file. We isolate the require here so test mocks via
  // `createClient` short-circuit it entirely.
  const req = createRequire(import.meta.url);
  const sdk = req("@github/copilot-sdk") as {
    CopilotClient: new (opts: { env: NodeJS.ProcessEnv; githubToken: string }) => CopilotSdkClient;
    approveAll: (req: unknown) => unknown;
  };
  const client = new sdk.CopilotClient({ env, githubToken });
  // Wrap createSession so callers always get onPermissionRequest: approveAll
  // injected, satisfying the SDK requirement without callers needing to know.
  const origCreateSession = client.createSession.bind(client);
  client.createSession = (opts): Promise<CopilotSdkSession> =>
    origCreateSession({ onPermissionRequest: sdk.approveAll, ...opts });
  return client;
};
