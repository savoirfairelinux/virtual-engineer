import { describe, it, expect, vi, beforeEach } from "vitest";
import { CopilotReviewAgent } from "../../src/review/copilotReviewAgent.js";
import type { ReviewStreamEvent } from "../../src/review/copilotReviewAgent.js";
import { makeExternalChangeId } from "../../src/interfaces.js";

interface FakeSession {
  sendAndWait: any;
  on: any;
  _handlers: Map<string, Array<(e: unknown) => void>>;
  _emit: (type: string, payload: unknown) => void;
}
interface FakeClient {
  createSession: any;
}

function fakeSdk(rawOutput: string): { client: FakeClient; session: FakeSession } {
  const handlers = new Map<string, Array<(e: unknown) => void>>();
  const session: FakeSession = {
    sendAndWait: vi.fn(async () => ({ content: rawOutput })),
    on: vi.fn((eventType: string, handler: (e: unknown) => void) => {
      if (!handlers.has(eventType)) handlers.set(eventType, []);
      handlers.get(eventType)!.push(handler);
      return () => { /* unsubscribe stub */ };
    }),
    _handlers: handlers,
    _emit: (type: string, payload: unknown) => {
      for (const h of handlers.get(type) ?? []) h(payload);
    },
  };
  const client: FakeClient = {
    createSession: vi.fn(async () => session),
  };
  return { client, session };
}

const promptOk =
  "REVIEW_RESULT_START\n" +
  '{"comments":[],"summary":"ok","score":1}\n' +
  "REVIEW_RESULT_END";

describe("CopilotReviewAgent", () => {
  let createClient: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createClient = vi.fn();
  });

  it("creates a session and forwards the prompt", async () => {
    const { client, session } = fakeSdk(promptOk);
    createClient.mockReturnValue(client);

    const agent = new CopilotReviewAgent({
      githubToken: "ghp_review_token",
      model: "gpt-4.1",
      systemPrompt: "You are a code reviewer.",
      createClient: createClient as any,
    });

    const result = await agent.runReview({
      changeId: makeExternalChangeId("I1234"),
      patchset: 2,
      project: "demo",
      prompt: "review this",
    });

    expect(result.rawOutput).toContain("REVIEW_RESULT_START");
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      githubToken: "ghp_review_token",
      env: expect.objectContaining({
        GITHUB_TOKEN: "ghp_review_token",
      }),
    }));
    expect(client.createSession).toHaveBeenCalledOnce();
    const sessionArgs = client.createSession.mock.calls[0]?.[0] as { model: string };
    expect(sessionArgs.model).toBe("gpt-4.1");
    expect(session.sendAndWait).toHaveBeenCalledOnce();
    const sent = session.sendAndWait.mock.calls[0]?.[0] as { prompt: string };
    expect(sent.prompt).toBe("review this");
  });

  it("extracts content from various SDK response shapes", async () => {
    const cases: Array<unknown> = [
      // SDK primary shape: assistant.message event { data: { content } }
      { type: "assistant.message", data: { content: promptOk } },
      { data: { content: promptOk } },
      { content: promptOk },
      { text: promptOk },
      { message: { content: promptOk } },
      { messages: [{ content: promptOk }] },
      promptOk,
    ];

    for (const response of cases) {
      const session = { sendAndWait: vi.fn(async () => response) } as unknown as FakeSession;
      const client: FakeClient = { createSession: vi.fn(async () => session) };
      createClient.mockReturnValue(client);

      const agent = new CopilotReviewAgent({
        githubToken: "ghp_review_token",
        systemPrompt: "You are a code reviewer.",
        createClient: createClient as any,
      });

      const result = await agent.runReview({
        changeId: makeExternalChangeId("I"),
        patchset: 1,
        project: "p",
        prompt: "x",
      });
      expect(result.rawOutput).toContain("REVIEW_RESULT_START");
    }
  });

  it("throws if the SDK returns no parsable content", async () => {
    const session = { sendAndWait: vi.fn(async () => ({})) } as unknown as FakeSession;
    const client: FakeClient = { createSession: vi.fn(async () => session) };
    createClient.mockReturnValue(client);

    const agent = new CopilotReviewAgent({
      githubToken: "ghp_review_token",
      systemPrompt: "You are a code reviewer.",
      createClient: createClient as any,
    });

    await expect(
      agent.runReview({
        changeId: makeExternalChangeId("I"),
        patchset: 1,
        project: "p",
        prompt: "x",
      })
    ).rejects.toThrow(/empty|no content/i);
  });

  it("passes workingDirectory to createSession when provided", async () => {
    const { client } = fakeSdk(promptOk);
    createClient.mockReturnValue(client);

    const agent = new CopilotReviewAgent({
      githubToken: "ghp_review_token",
      systemPrompt: "You are a code reviewer.",
      createClient: createClient as any,
    });

    await agent.runReview({
      changeId: makeExternalChangeId("I"),
      patchset: 1,
      project: "p",
      prompt: "x",
      workingDirectory: "/tmp/review-42-abc",
    });

    const sessionArgs = client.createSession.mock.calls[0]?.[0] as { workingDirectory?: string };
    expect(sessionArgs.workingDirectory).toBe("/tmp/review-42-abc");
  });

  it("omits workingDirectory from createSession when not provided", async () => {
    const { client } = fakeSdk(promptOk);
    createClient.mockReturnValue(client);

    const agent = new CopilotReviewAgent({
      githubToken: "ghp_review_token",
      systemPrompt: "You are a code reviewer.",
      createClient: createClient as any,
    });

    await agent.runReview({
      changeId: makeExternalChangeId("I"),
      patchset: 1,
      project: "p",
      prompt: "x",
    });

    const sessionArgs = client.createSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("workingDirectory" in sessionArgs).toBe(false);
  });

  it("requires a GitHub token", () => {
    expect(() => new CopilotReviewAgent({ githubToken: "", systemPrompt: "system" })).toThrow(
      /githubToken/i
    );
  });

  it("uses the provided system prompt when supplied", async () => {
    const { client } = fakeSdk(promptOk);
    createClient.mockReturnValue(client);

    const agent = new CopilotReviewAgent({
      githubToken: "ghp_review_token",
      systemPrompt: "You are a strict reviewer.",
      createClient: createClient as any,
    });

    await agent.runReview({
      changeId: makeExternalChangeId("I"),
      patchset: 1,
      project: "p",
      prompt: "review",
    });

    const args = client.createSession.mock.calls[0]?.[0] as {
      systemMessage?: { content?: string };
    };
    expect(args.systemMessage?.content).toBe("You are a strict reviewer.");
  });

  it("registers SDK event handlers and forwards events via onEvent callback", async () => {
    const { client, session } = fakeSdk(promptOk);
    createClient.mockReturnValue(client);

    // Make sendAndWait emit some SDK events before resolving.
    (session.sendAndWait as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      session._emit("tool.execution_start", { name: "read_file", input: { path: "foo.ts" } });
      session._emit("tool.execution_complete", { name: "read_file", result: "content" });
      session._emit("assistant.streaming_delta", { delta: "hello" });
      session._emit("assistant.message", { content: "review result" });
      session._emit("assistant.usage", { inputTokens: 100, outputTokens: 50 });
      session._emit("session.usage_info", { tokenLimit: 8000, currentTokens: 150 });
      session._emit("session.error", { message: "recoverable warning" });
      return { content: promptOk };
    });

    const agent = new CopilotReviewAgent({
      githubToken: "ghp_review_token",
      systemPrompt: "You are a code reviewer.",
      createClient: createClient as any,
    });

    const receivedEvents: ReviewStreamEvent[] = [];
    await agent.runReview(
      { changeId: makeExternalChangeId("I"), patchset: 1, project: "p", prompt: "review" },
      (event) => receivedEvents.push(event),
    );

    // All 7 event types we emitted should have been forwarded.
    const types = receivedEvents.map((e) => e.type);
    expect(types).toContain("tool.execution_start");
    expect(types).toContain("tool.execution_complete");
    expect(types).toContain("assistant.streaming_delta");
    expect(types).toContain("assistant.message");
    expect(types).toContain("assistant.usage");
    expect(types).toContain("session.usage_info");
    expect(types).toContain("session.error");

    // Verify data extraction works.
    const toolStart = receivedEvents.find((e) => e.type === "tool.execution_start");
    expect(toolStart?.data["name"]).toBe("read_file");

    const usage = receivedEvents.find((e) => e.type === "assistant.usage");
    expect(usage?.data["inputTokens"]).toBe(100);
    expect(usage?.data["outputTokens"]).toBe(50);
  });

  it("does not register event handlers when no onEvent callback is passed", async () => {
    const { client, session } = fakeSdk(promptOk);
    createClient.mockReturnValue(client);

    const agent = new CopilotReviewAgent({
      githubToken: "ghp_review_token",
      systemPrompt: "You are a code reviewer.",
      createClient: createClient as any,
    });

    await agent.runReview({
      changeId: makeExternalChangeId("I"),
      patchset: 1,
      project: "p",
      prompt: "review",
    });

    // session.on should not have been called when no callback is provided.
    expect(session.on).not.toHaveBeenCalled();
  });
});
