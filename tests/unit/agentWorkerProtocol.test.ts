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

  it("surfaces a failed worker summary", () => {
    expect(() => decodeReviewWorkerOutput(JSON.stringify({
      status: "failed",
      modifiedFiles: [],
      summary: "Agent worker error: model unavailable",
      agentLogs: "",
    }))).toThrow("Agent worker error: model unavailable");
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