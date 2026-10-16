import { describe, it, expect } from "vitest";
import { describeContextOverflow, isInfrastructureError } from "../../src/utils/errorClassifier.js";

describe("isInfrastructureError", () => {
  it("flags Gerrit SSH connection-establishment failures", () => {
    expect(isInfrastructureError(new Error("ssh: connect to host gerrit.example.com port 29418: Connection refused"))).toBe(true);
    expect(isInfrastructureError(new Error("Permission denied (publickey)."))).toBe(true);
    expect(isInfrastructureError(new Error("Host key verification failed."))).toBe(true);
    expect(isInfrastructureError(new Error("Could not resolve hostname gerrit.example.com"))).toBe(true);
    expect(isInfrastructureError(new Error("SSH review timed out after 30000ms: ssh -p 29418 ..."))).toBe(true);
  });

  it("flags Node socket / DNS error codes", () => {
    expect(isInfrastructureError(new Error("connect ECONNREFUSED 10.0.0.1:29418"))).toBe(true);
    expect(isInfrastructureError(new Error("getaddrinfo ENOTFOUND gerrit"))).toBe(true);
    expect(isInfrastructureError(new Error("read ECONNRESET"))).toBe(true);
  });

  it("does not flag genuine task failures", () => {
    expect(isInfrastructureError(new Error("Agent produced no changes after cycle 2"))).toBe(false);
    expect(isInfrastructureError(new Error("merge conflict in src/index.ts"))).toBe(false);
    expect(isInfrastructureError(new Error("Ticket close failed (change is merged): validation error"))).toBe(false);
  });

  it("handles non-Error inputs", () => {
    expect(isInfrastructureError("ECONNREFUSED")).toBe(true);
    expect(isInfrastructureError(undefined)).toBe(false);
    expect(isInfrastructureError(null)).toBe(false);
  });
});

describe("describeContextOverflow", () => {
  const reason = (size: string): string =>
    `Prompt exceeds the model context window (${size}). The input is too large for this model; retrying will not help.`;

  it("explains a Copilot prompt rejected for exceeding the model limit", () => {
    const copilotError = new Error(
      "Agent worker error: Execution failed: Error: Failed to get response from the AI model; retried 5 times " +
      "(total retry wait time: 6.00 seconds) (Request-ID D9A3:531C0) Last error: CAPIError: 400 prompt token count " +
      "of 1107212 exceeds the limit of 872000",
    );
    expect(describeContextOverflow(copilotError)).toBe(reason("1,107,212 > 872,000 tokens"));
  });

  it("recognizes Anthropic, OpenAI and Gemini context-window errors", () => {
    expect(describeContextOverflow("prompt is too long: 208310 tokens > 200000 maximum"))
      .toBe(reason("208,310 > 200,000 tokens"));
    expect(describeContextOverflow(
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
    )).toBe(reason("130,000 > 128,000 tokens"));
    expect(describeContextOverflow(
      "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).",
    )).toBe(reason("1,200,000 > 1,048,576 tokens"));
  });

  it("explains an overflow error code without token counts", () => {
    expect(describeContextOverflow("400 context_length_exceeded")).toBe(
      "Prompt exceeds the model context window. The input is too large for this model; retrying will not help.",
    );
  });

  it("ignores other failures", () => {
    expect(describeContextOverflow(new Error("Rate limit exceeded"))).toBeNull();
    expect(describeContextOverflow(undefined)).toBeNull();
  });
});
