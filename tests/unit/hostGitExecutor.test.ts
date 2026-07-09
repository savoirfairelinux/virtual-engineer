import { describe, it, expect, vi } from "vitest";
import { HostGitExecutor, type GitRunner } from "../../src/workspace/hostGitExecutor.js";

function recordingRunner(responses: Record<string, string> = {}): {
  git: GitRunner;
  calls: Array<{ args: string[]; cwd: string }>;
} {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const git: GitRunner = async (args, cwd) => {
    calls.push({ args, cwd });
    return responses[args[0] ?? ""] ?? "";
  };
  return { git, calls };
}

describe("HostGitExecutor", () => {
  it("clones a single branch into a sub-path", async () => {
    const { git, calls } = recordingRunner();
    const exec = new HostGitExecutor({ baseDir: "/tmp", git });
    await exec.cloneRepo("/tmp/ws", "https://host/repo.git", "main", "libs/core");
    expect(calls[0]?.args).toEqual([
      "clone",
      "--branch",
      "main",
      "--single-branch",
      "https://host/repo.git",
      "libs/core",
    ]);
    expect(calls[0]?.cwd).toBe("/tmp/ws");
  });

  it("runs git in a sub-path when provided", async () => {
    const { git, calls } = recordingRunner();
    const exec = new HostGitExecutor({ baseDir: "/tmp", git });
    await exec.execGit("/tmp/ws", ["status"], "sub");
    expect(calls[0]?.cwd).toBe("/tmp/ws/sub");
  });

  it("fetches then checks out FETCH_HEAD", async () => {
    const { git, calls } = recordingRunner();
    const exec = new HostGitExecutor({ baseDir: "/tmp", git });
    await exec.fetchAndCheckout("/tmp/ws", "https://host/repo", "refs/changes/1/2/3");
    expect(calls.map((c) => c.args[0])).toEqual(["fetch", "checkout"]);
    expect(calls[1]?.args).toEqual(["checkout", "FETCH_HEAD"]);
  });

  it("fetches then cherry-picks FETCH_HEAD", async () => {
    const { git, calls } = recordingRunner();
    const exec = new HostGitExecutor({ baseDir: "/tmp", git });
    await exec.fetchAndCherryPick("/tmp/ws", "https://host/repo", "refs/changes/1/2/3");
    expect(calls.map((c) => c.args[0])).toEqual(["fetch", "cherry-pick"]);
  });

  it("lists modified files, trimming blanks", async () => {
    const { git } = recordingRunner({ diff: "a.ts\n\nb/c.ts\n" });
    const exec = new HostGitExecutor({ baseDir: "/tmp", git });
    expect(await exec.listModifiedFiles("/tmp/ws")).toEqual(["a.ts", "b/c.ts"]);
  });

  it("destroyWorkspace never throws", async () => {
    const exec = new HostGitExecutor({ baseDir: "/tmp", git: vi.fn() });
    await expect(exec.destroyWorkspace("/tmp/does-not-exist-xyz")).resolves.toBeUndefined();
  });

  it("propagates git failures from the runner", async () => {
    const git: GitRunner = async () => {
      throw new Error("git clone: fatal");
    };
    const exec = new HostGitExecutor({ baseDir: "/tmp", git });
    await expect(exec.cloneRepo("/tmp/ws", "u", "main")).rejects.toThrow(/fatal/);
  });
});
