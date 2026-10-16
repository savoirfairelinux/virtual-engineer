import { describe, expect, it } from "vitest";
import {
  AgentWorkerProtocolError,
  decodeReviewWorkerOutput,
} from "../../src/workspace/agentWorkerProtocol.js";

describe("decodeReviewWorkerOutput", () => {
  it("extracts multiline review output from a successful worker envelope", () => {
    const rawOutput = [
      "REVIEW_RESULT_START",
      JSON.stringify({ comments: [], summary: "Looks good", score: 1 }),
      "REVIEW_RESULT_END",
    ].join("\n");

    expect(decodeReviewWorkerOutput(JSON.stringify({
      status: "success",
      modifiedFiles: [],
      summary: "Looks good",
      agentLogs: rawOutput,
      rawOutput,
      metadata: { reviewMode: true },
    }))).toBe(rawOutput);
  });

  it("decodes the final envelope line when OpenShell logs precede it on stdout", () => {
    const envelope = JSON.stringify({ status: "success", rawOutput: '{"score":1}', modifiedFiles: [] });
    const stdout = [
      "2026-10-06T15:44:54.936784Z  WARN openshell: OIDC token refresh failed: no refresh token available",
      envelope,
      "",
    ].join("\n");

    expect(decodeReviewWorkerOutput(stdout)).toBe('{"score":1}');
  });

  it("surfaces a failed worker summary", () => {
    expect(() => decodeReviewWorkerOutput(JSON.stringify({
      status: "failed",
      modifiedFiles: [],
      summary: "Agent worker error: model unavailable",
      agentLogs: "",
    }))).toThrow("Agent worker error: model unavailable");
  });

  it("reports a context-window overflow as a non-retryable reason and keeps the original error", () => {
    const stdout = JSON.stringify({
      status: "failed",
      modifiedFiles: [],
      summary: "Agent worker error: Last error: CAPIError: 400 prompt token count of 1107212 exceeds the limit of 872000",
      agentLogs: "",
    });
    try {
      decodeReviewWorkerOutput(stdout);
      expect.fail("expected a protocol error");
    } catch (error) {
      const failure = error as AgentWorkerProtocolError;
      expect(failure.message).toBe(
        "Prompt exceeds the model context window (1,107,212 > 872,000 tokens). " +
        "The input is too large for this model; retrying will not help.",
      );
      expect(failure.diagnostics.stdout).toContain("prompt token count of 1107212");
    }
  });

  it.each([
    ["invalid JSON", "not-json"],
    ["missing rawOutput", JSON.stringify({ status: "success" })],
    ["non-string rawOutput", JSON.stringify({ status: "success", rawOutput: 42 })],
  ])("rejects %s", (_label, stdout) => {
    expect(() => decodeReviewWorkerOutput(stdout)).toThrow(AgentWorkerProtocolError);
  });

  it("retains masked stdout and stderr without exposing them to error serialization", () => {
    const stdout = 'banner session-secret\n{"password":"hidden-password","status":';
    try {
      decodeReviewWorkerOutput(stdout, { code: 0, stderr: "Bearer hidden-bearer", secrets: ["session-secret"] });
      expect.fail("expected a protocol error");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentWorkerProtocolError);
      const failure = error as AgentWorkerProtocolError;
      expect(failure.diagnostics).toMatchObject({
        exitCode: 0, stdoutBytes: Buffer.byteLength(stdout), stdoutTruncated: false,
        stdout: 'banner <redacted>\n{"password":"<redacted>","status":',
        stderr: "Bearer <redacted>",
      });
      expect(failure.diagnostics.parseError).toBeTruthy();
      expect(JSON.stringify(failure)).not.toContain("banner");
      expect(failure.message).toBe("Agent worker returned invalid JSON");
    }
  });

  it("bounds diagnostics while preserving both ends and the original byte count", () => {
    const stdout = `begin ${"é".repeat(100_000)} end`;
    try {
      decodeReviewWorkerOutput(stdout);
      expect.fail("expected a protocol error");
    } catch (error) {
      const diagnostic = (error as AgentWorkerProtocolError).diagnostics;
      expect(diagnostic.stdoutBytes).toBe(Buffer.byteLength(stdout));
      expect(diagnostic.stdoutTruncated).toBe(true);
      expect(Buffer.byteLength(diagnostic.stdout)).toBeLessThanOrEqual(65_536);
      expect(diagnostic.stdout).toMatch(/^begin /);
      expect(diagnostic.stdout).toMatch(/ end$/);
      expect(diagnostic.stdout).not.toContain("\uFFFD");
    }
  });
});