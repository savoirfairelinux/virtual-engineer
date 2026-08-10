/**
 * Test suite for VcsConnector interface.
 * Verifies that the interface signature is well-formed and testable.
 */

import { describe, it, expect } from "vitest";
import type { VcsConnector, VcsPushResult, VcsConnectorConfig } from "../../src/vcs/vcsConnector.js";

describe("VcsConnector Interface", () => {
  it("should define VcsConnector interface with required methods", () => {
    // This is a compile-time check; TypeScript will error if the interface is missing methods.
    // However, we can verify the interface exists and has the correct structure.
    const mockConnector: VcsConnector = {
      async clone(_repoUrl: string, _branch: string, _targetDir: string): Promise<void> {
        // Mock implementation
      },
      async getChangeStatus(_changeId: string): Promise<string> {
        return "OPEN";
      },
      buildPushSpec(_baseBranch: string, taskId: string) { return { ref: `refs/for/main`, topic: `VE-${taskId}` }; },
      useChangeIdContinuity: true,
      reviewSystemLabel: "gerrit",
    };

    expect(mockConnector).toBeDefined();
    expect(typeof mockConnector.clone).toBe("function");
    expect(typeof mockConnector.getChangeStatus).toBe("function");
  });

  it("should define VcsPushResult type correctly", () => {
    const result: VcsPushResult = {
      changeId: "I1234567890abcdef",
      url: "https://gerrit.example.com/c/12345",
      status: "OPEN",
    };

    expect(result.changeId).toBeDefined();
    expect(result.url).toBeDefined();
    expect(result.status).toBeDefined();
  });

  it("should define VcsConnectorConfig interface", () => {
    const config: VcsConnectorConfig = {
      baseUrl: "https://gerrit.example.com",
    };

    expect(config.baseUrl).toBe("https://gerrit.example.com");
  });

  describe("clone method", () => {
    it("should accept repoUrl, branch, and targetDir parameters", async () => {
      const mockConnector: VcsConnector = {
        async clone(repoUrl: string, branch: string, targetDir: string): Promise<void> {
          expect(repoUrl).toBeTruthy();
          expect(branch).toBeTruthy();
          expect(targetDir).toBeTruthy();
        },
        async getChangeStatus(): Promise<string> {
          throw new Error("Not implemented");
        },
        buildPushSpec(_baseBranch: string, taskId: string) { return { ref: `refs/for/main`, topic: `VE-${taskId}` }; },
        useChangeIdContinuity: true,
        reviewSystemLabel: "gerrit",
      };

      await mockConnector.clone(
        "ssh://git@gerrit.example.com:29418/my-repo.git",
        "main",
        "/tmp/workspace/repo"
      );
    });
  });

  describe("getChangeStatus method", () => {
    it("should accept changeId and return status string", async () => {
      const mockConnector: VcsConnector = {
        async clone(): Promise<void> {},
        async getChangeStatus(_changeId: string): Promise<string> {
          expect(_changeId).toBeTruthy();
          return "MERGED";
        },
        buildPushSpec(_baseBranch: string, taskId: string) { return { ref: `refs/for/main`, topic: `VE-${taskId}` }; },
        useChangeIdContinuity: true,
        reviewSystemLabel: "gerrit",
      };

      const status = await mockConnector.getChangeStatus("I1234567890");

      expect(status).toBe("MERGED");
    });
  });
});
