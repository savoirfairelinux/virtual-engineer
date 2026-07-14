import { describe, it, expect, vi } from "vitest";
import { access, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostGitExecutor, type GitRunner } from "../../src/workspace/hostGitExecutor.js";

function recordingRunner(responses: Record<string, string> = {}): {
  git: GitRunner;
  calls: Array<{ args: string[]; cwd: string; env?: NodeJS.ProcessEnv | undefined }>;
} {
  const calls: Array<{ args: string[]; cwd: string; env?: NodeJS.ProcessEnv | undefined }> = [];
  const git: GitRunner = async (args, cwd, env) => {
    calls.push({ args, cwd, env });
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

  it("removes HTTPS credentials from origin after cloning", async () => {
    const { git, calls } = recordingRunner();
    const exec = new HostGitExecutor({ baseDir: "/tmp", git });
    await exec.cloneRepo(
      "/tmp/ws",
      "https://oauth2:secret@gitlab.example.com/team/repo.git",
      "main",
    );

    expect(calls[1]).toMatchObject({
      args: ["remote", "set-url", "origin", "https://gitlab.example.com/team/repo.git"],
      cwd: "/tmp/ws",
    });
  });

  it("removes query credentials and fragments from origin after cloning", async () => {
    const { git, calls } = recordingRunner();
    const exec = new HostGitExecutor({ baseDir: "/tmp", git });
    await exec.cloneRepo(
      "/tmp/ws",
      "https://git.example.com/team/repo.git?access_token=secret#fragment",
      "main",
    );

    expect(calls[1]?.args).toEqual([
      "remote", "set-url", "origin", "https://git.example.com/team/repo.git",
    ]);
  });

  it("removes a cloned repository when credential scrubbing fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ve-git-scrub-"));
    const git: GitRunner = async (args, cwd) => {
      if (args[0] === "clone") {
        await mkdir(join(cwd, args.at(-1) ?? "."), { recursive: true });
        return "";
      }
      throw new Error("set-url failed");
    };
    const exec = new HostGitExecutor({ baseDir: tmpdir(), git });
    try {
      await expect(exec.cloneRepo(
        workspace,
        "https://oauth2:secret@git.example.com/team/repo.git",
        "main",
        "secondary",
      )).rejects.toThrow(/set-url failed/);
      await expect(access(join(workspace, "secondary"))).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("shell-quotes SSH paths before passing GIT_SSH_COMMAND", async () => {
    const { git, calls } = recordingRunner();
    const exec = new HostGitExecutor({ baseDir: "/tmp", git });
    await exec.cloneRepo(
      "/tmp/ws",
      "ssh://git@example.com/repo",
      "main",
      ".",
      "/keys/$(touch /tmp/pwned)",
      "/known hosts/it's-safe",
    );

    expect(calls[0]?.env?.["GIT_SSH_COMMAND"]).toBe(
      "ssh -i '/keys/$(touch /tmp/pwned)' -o IdentitiesOnly=yes "
      + "-o StrictHostKeyChecking=yes -o UserKnownHostsFile='/known hosts/it'\"'\"'s-safe'",
    );
  });

  it.each(["../outside", "/absolute/path", "libs/../../outside"])(
    "rejects clone destinations outside the workspace: %s",
    async (subPath) => {
      const { git, calls } = recordingRunner();
      const exec = new HostGitExecutor({ baseDir: "/tmp", git });
      await expect(exec.cloneRepo("/tmp/ws", "https://host/repo.git", "main", subPath))
        .rejects.toThrow(/workspace/i);
      expect(calls).toHaveLength(0);
    },
  );

  it("rejects workspace paths that traverse a symlink", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ve-git-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "ve-git-outside-"));
    await symlink(outside, join(workspace, "linked"));
    const { git, calls } = recordingRunner();
    const exec = new HostGitExecutor({ baseDir: tmpdir(), git });
    try {
      await expect(exec.cloneRepo(
        workspace,
        "https://host/repo.git",
        "main",
        "linked/repo",
      )).rejects.toThrow(/symbolic link/i);
      expect(calls).toHaveLength(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
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
