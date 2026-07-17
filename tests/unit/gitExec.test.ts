import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "child_process";
import { execGit } from "../../src/utils/gitExec.js";

vi.mock("child_process");

describe("execGit", () => {
  const mockExecFileSync = vi.mocked(execFileSync);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the output of execFileSync unchanged", () => {
    mockExecFileSync.mockReturnValue("abc\n");
    expect(execGit(["status"], "/repo")).toBe("abc\n");
    expect(mockExecFileSync).toHaveBeenCalledWith("git", [
      "-c", "core.hooksPath=/dev/null",
      "-c", "include.path=/dev/null",
      "status",
    ], {
      cwd: "/repo",
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: expect.objectContaining({
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      }),
    });
  });

  it("throws with subcommand prefix on failure", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("fatal: not a git repository");
    });
    expect(() => execGit(["clone", "https://example.com"], "/tmp")).toThrow(
      "git clone: fatal: not a git repository",
    );
  });

  it("uses fallback message when error.message is empty", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("");
    });
    expect(() => execGit(["fetch", "--all"], "/repo")).toThrow(
      "git fetch: git command failed",
    );
  });

  it("truncates long messages to 500 characters", () => {
    const longMessage = "x".repeat(600);
    mockExecFileSync.mockImplementation(() => {
      throw new Error(longMessage);
    });
    const error = (() => {
      try {
        execGit(["push", "origin", "main"], "/repo");
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).toBe(`git push: ${"x".repeat(500)}`);
  });

  it("wraps a non-Error thrown value with the subcommand prefix", () => {
    mockExecFileSync.mockImplementation(() => {
      throw "plain string error"; // non-Error throw to exercise the String(err) branch
    });
    expect(() => execGit(["commit", "-m", "msg"], "/repo")).toThrow(
      "git commit: plain string error",
    );
  });

  it("includes the subcommand in every thrown error", () => {
    for (const sub of ["clone", "fetch", "push", "commit", "log"]) {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("some error");
      });
      expect(() => execGit([sub], "/repo")).toThrow(`git ${sub}:`);
    }
  });
});
