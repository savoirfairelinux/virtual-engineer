import { describe, it, expect, vi } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { HostGitExecutor, type GitRunner } from "../../src/workspace/hostGitExecutor.js";
import { managedKnownHostsPath } from "../../src/utils/sshHostKeys.js";

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

async function createReturnedRepository(workspace: string, subPath = "."): Promise<string> {
  const gitDir = join(workspace, subPath, ".git");
  await mkdir(join(gitDir, "objects", "info"), { recursive: true });
  await mkdir(join(gitDir, "refs", "heads"), { recursive: true });
  await mkdir(join(gitDir, "info"), { recursive: true });
  await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(gitDir, "config"), "[remote \"origin\"]\n\turl = https://untrusted.example/repo.git\n");
  return gitDir;
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
      "--depth",
      "1",
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

  it("retries transient clone failures after removing the partial destination", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ve-git-retry-"));
    let attempts = 0;
    const git: GitRunner = async (args, cwd) => {
      if (args[0] !== "clone") return "";
      attempts += 1;
      if (attempts > 1) {
        await expect(access(join(cwd, "partial.txt"))).rejects.toThrow();
      }
      await writeFile(join(cwd, "partial.txt"), "partial");
      if (attempts < 3) {
        throw new Error("git clone: RPC failed; curl 56 Recv failure: Connection timed out; early EOF; invalid index-pack output");
      }
      return "";
    };
    const exec = new HostGitExecutor({
      baseDir: tmpdir(),
      git,
      cloneMaxAttempts: 3,
      cloneRetryDelayMs: 0,
      cloneTimeoutMs: 1_000,
    });

    try {
      await exec.cloneRepo(workspace, "https://host/repo.git", "main");
      expect(attempts).toBe(3);
      await expect(access(join(workspace, "partial.txt"))).resolves.toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("times out a stuck clone attempt", async () => {
    vi.useFakeTimers();
    const workspace = await mkdtemp(join(tmpdir(), "ve-git-timeout-"));
    const git: GitRunner = async (_args, _cwd, _env, signal) => new Promise<string>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("clone aborted")), { once: true });
    });
    const exec = new HostGitExecutor({
      baseDir: tmpdir(),
      git,
      cloneMaxAttempts: 1,
      cloneTimeoutMs: 1_000,
    });

    try {
      const clone = exec.cloneRepo(workspace, "https://host/repo.git", "main");
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(clone).rejects.toThrow(/timed out/i);
    } finally {
      vi.useRealTimers();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("retries a clone after an attempt timeout", async () => {
    vi.useFakeTimers();
    const workspace = await mkdtemp(join(tmpdir(), "ve-git-timeout-retry-"));
    let attempts = 0;
    const git: GitRunner = vi.fn(async (_args, _cwd, _env, signal) => {
      attempts += 1;
      if (attempts === 1) {
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("clone aborted")), { once: true });
        });
      }
      return "";
    });
    const exec = new HostGitExecutor({
      baseDir: tmpdir(),
      git,
      cloneMaxAttempts: 2,
      cloneRetryDelayMs: 0,
      cloneTimeoutMs: 1_000,
    });

    try {
      const clone = exec.cloneRepo(workspace, "https://host/repo.git", "main");
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(clone).resolves.toBeUndefined();
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not retry non-transient clone failures", async () => {
    const git: GitRunner = vi.fn(async () => {
      throw new Error("git clone: remote: Repository not found");
    });
    const exec = new HostGitExecutor({
      baseDir: "/tmp",
      git,
      cloneMaxAttempts: 3,
      cloneRetryDelayMs: 0,
    });

    await expect(exec.cloneRepo("/tmp/ws", "https://host/repo.git", "main")).rejects.toThrow(/Repository not found/);
    expect(git).toHaveBeenCalledOnce();
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

  it("trusts the host key on first use for SSH operations without a known_hosts path", async () => {
    const { git, calls } = recordingRunner();
    const exec = new HostGitExecutor({ baseDir: "/tmp", git });

    await exec.cloneRepo("/tmp/ws", "ssh://git@example.com/repo", "main", ".", "/keys/id_ed25519", undefined);
    expect(calls[0]?.env?.["GIT_SSH_COMMAND"]).toContain("StrictHostKeyChecking=accept-new");
    expect(calls[0]?.env?.["GIT_SSH_COMMAND"]).toContain(`UserKnownHostsFile='${managedKnownHostsPath()}'`);
  });

  it("does not treat credentialed HTTPS URLs as SSH remotes", async () => {
    const { git, calls } = recordingRunner();
    const exec = new HostGitExecutor({ baseDir: "/tmp", git });
    await exec.cloneRepo("/tmp/ws", "https://user@host.example:8443/repo.git", "main");
    expect(calls[0]?.env?.["GIT_SSH_COMMAND"]).toBeUndefined();
  });

  it("applies host-key policy to userless SCP-style remotes", async () => {
    const { git, calls } = recordingRunner();
    const exec = new HostGitExecutor({ baseDir: "/tmp", git });
    await exec.cloneRepo("/tmp/ws", "host.example:team/repo.git", "main");
    expect(calls[0]?.env?.["GIT_SSH_COMMAND"]).toContain("StrictHostKeyChecking=accept-new");
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

  it("rebuilds sandbox-returned Git metadata from trusted values", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ve-git-trust-"));
    const gitDir = await createReturnedRepository(workspace);
    await mkdir(join(gitDir, "hooks"), { recursive: true });
    await writeFile(join(gitDir, "config"), [
      "[remote \"origin\"]",
      "  url = https://evil.example/fetch",
      "  pushurl = ext::sh -c 'touch /tmp/pwned' %S",
      "[url \"ext::sh -c 'touch /tmp/pwned' %S\"]",
      "  insteadOf = https://trusted.example/",
      "[filter \"evil\"]",
      "  clean = touch /tmp/pwned",
    ].join("\n"));
    await writeFile(join(gitDir, "hooks", "pre-push"), "#!/bin/sh\ntouch /tmp/pwned\n");
    await writeFile(join(gitDir, "objects", "info", "alternates"), "/etc\n");
    await writeFile(join(gitDir, "config.worktree"), "[remote \"origin\"]\n\tpushurl = https://evil.example/push\n");
    await writeFile(join(gitDir, "info", "attributes"), "* filter=evil\n");
    const exec = new HostGitExecutor({ baseDir: tmpdir(), git: vi.fn() });

    try {
      await exec.rebuildTrustedMetadata(workspace, new Map([[".", "https://trusted.example/repo.git"]]));

      const config = await readFile(join(gitDir, "config"), "utf8");
      expect(config).toContain("url = https://trusted.example/repo.git");
      expect(config).not.toMatch(/pushurl|insteadOf|filter|evil|ext::/i);
      await expect(access(join(gitDir, "hooks"))).rejects.toThrow();
      await expect(access(join(gitDir, "objects", "info", "alternates"))).rejects.toThrow();
      await expect(access(join(gitDir, "config.worktree"))).rejects.toThrow();
      await expect(access(join(gitDir, "info", "attributes"))).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([".", "libs/core"].flatMap((subPath) =>
    (["relative", "absolute", "empty", "missing", "directory", "symlink"] as const)
      .map((layout) => ({ subPath, layout })),
  ))("rejects $layout commondir in $subPath before invoking Git", async ({ subPath, layout }) => {
    const workspace = await mkdtemp(join(tmpdir(), "ve-git-commondir-"));
    const git = vi.fn<GitRunner>().mockResolvedValue("");
    const exec = new HostGitExecutor({ baseDir: tmpdir(), git });

    try {
      const rootGitDir = await createReturnedRepository(workspace);
      const secondaryGitDir = await createReturnedRepository(workspace, "libs/core");
      const commonGitDir = await createReturnedRepository(workspace, "untrusted-common");
      await writeFile(join(commonGitDir, "config"), [
        "[remote \"origin\"]",
        "\turl = https://untrusted.example/common.git",
        "[protocol \"ext\"]",
        "\tallow = always",
      ].join("\n"));
      const gitDir = subPath === "." ? rootGitDir : secondaryGitDir;
      const commondir = join(gitDir, "commondir");
      if (layout === "directory") {
        await mkdir(commondir);
      } else if (layout === "symlink") {
        await symlink("missing-common", commondir);
      } else {
        const targets = {
          relative: relative(gitDir, commonGitDir),
          absolute: commonGitDir,
          empty: "",
          missing: "missing-common",
        };
        await writeFile(commondir, targets[layout]);
      }
      const originalConfig = await readFile(join(rootGitDir, "config"), "utf8");

      await expect(exec.rebuildTrustedMetadata(workspace, new Map([
        [".", "https://trusted.example/root.git"],
        ["libs/core", "https://trusted.example/core.git"],
      ]))).rejects.toThrow(/commondir/i);

      expect(git).not.toHaveBeenCalled();
      expect(await readFile(join(rootGitDir, "config"), "utf8")).toBe(originalConfig);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each(["gitdir", "worktrees"])("rejects shared repository metadata %s without invoking Git", async (entry) => {
    const workspace = await mkdtemp(join(tmpdir(), "ve-git-shared-"));
    const git = vi.fn<GitRunner>().mockResolvedValue("");
    const exec = new HostGitExecutor({ baseDir: tmpdir(), git });

    try {
      const gitDir = await createReturnedRepository(workspace);
      if (entry === "worktrees") {
        await mkdir(join(gitDir, entry));
      } else {
        await writeFile(join(gitDir, entry), "/untrusted/worktree/.git\n");
      }

      await expect(exec.rebuildTrustedMetadata(workspace, new Map([
        [".", "https://trusted.example/repo.git"],
      ]))).rejects.toThrow(/shared repository layout/i);
      expect(git).not.toHaveBeenCalled();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each(["HEAD", "objects", "refs"].flatMap((entry) =>
    ["missing", "wrong type"].map((layout) => ({ entry, layout })),
  ))("rejects $layout $entry metadata without invoking Git", async ({ entry, layout }) => {
    const workspace = await mkdtemp(join(tmpdir(), "ve-git-layout-"));
    const git = vi.fn<GitRunner>().mockResolvedValue("");
    const exec = new HostGitExecutor({ baseDir: tmpdir(), git });

    try {
      const gitDir = await createReturnedRepository(workspace);
      const entryPath = join(gitDir, entry);
      await rm(entryPath, { recursive: true, force: true });
      if (layout === "wrong type") {
        if (entry === "HEAD") {
          await mkdir(entryPath);
        } else {
          await writeFile(entryPath, "not a directory\n");
        }
      }

      await expect(exec.rebuildTrustedMetadata(workspace, new Map([
        [".", "https://trusted.example/repo.git"],
      ]))).rejects.toThrow();
      expect(git).not.toHaveBeenCalled();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each(["gitfile", "symlink", "bare"])("rejects a returned %s layout without invoking Git", async (layout) => {
    const workspace = await mkdtemp(join(tmpdir(), "ve-git-redirect-"));
    const git = vi.fn<GitRunner>().mockResolvedValue("");
    const exec = new HostGitExecutor({ baseDir: tmpdir(), git });

    try {
      const commonGitDir = await createReturnedRepository(workspace, "common");
      if (layout === "gitfile") {
        await writeFile(join(workspace, ".git"), `gitdir: ${commonGitDir}\n`);
      } else if (layout === "symlink") {
        await symlink(commonGitDir, join(workspace, ".git"));
      } else {
        await mkdir(join(workspace, "objects"));
        await mkdir(join(workspace, "refs"));
        await writeFile(join(workspace, "HEAD"), "ref: refs/heads/main\n");
      }

      await expect(exec.rebuildTrustedMetadata(workspace, new Map([
        [".", "https://trusted.example/repo.git"],
      ]))).rejects.toThrow();
      expect(git).not.toHaveBeenCalled();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each(["", "invalid\n", "ref: HEAD\n", "1234\n"])(
    "rejects malformed HEAD %j before Git can discover an ancestor repository",
    async (head) => {
      const workspace = await mkdtemp(join(tmpdir(), "ve-git-invalid-head-"));
      const git = vi.fn<GitRunner>().mockResolvedValue("");
      const exec = new HostGitExecutor({ baseDir: tmpdir(), git });

      try {
        await createReturnedRepository(workspace);
        const gitDir = await createReturnedRepository(workspace, "libs/core");
        await writeFile(join(gitDir, "HEAD"), head);

        await expect(exec.rebuildTrustedMetadata(workspace, new Map([
          [".", "https://trusted.example/root.git"],
          ["libs/core", "https://trusted.example/core.git"],
        ]))).rejects.toThrow(/HEAD/i);
        expect(git).not.toHaveBeenCalled();
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { name: "root and nested repositories", paths: [".", "libs/core", "tools/plugin"] },
    { name: "multiple roots without a workspace repository", paths: ["apps/api", "libs/core"] },
  ])("restores effective fetch and push origins for $name", async ({ paths }) => {
    const workspace = await mkdtemp(join(tmpdir(), "ve-git-effective-origin-"));
    const exec = new HostGitExecutor({ baseDir: tmpdir() });
    const remotes = new Map<string, string>();

    try {
      for (const [index, subPath] of paths.entries()) {
        const gitDir = await createReturnedRepository(workspace, subPath);
        remotes.set(subPath, `https://trusted.example/repo-${index}.git`);
        await writeFile(join(gitDir, "config"), [
          "[remote \"origin\"]",
          "\turl = https://untrusted.example/fetch.git",
          "\tpushurl = https://untrusted.example/push.git",
          "[url \"https://untrusted.example/rewrite/\"]",
          "\tinsteadOf = https://trusted.example/",
          "[extensions]",
          "\tworktreeConfig = true",
        ].join("\n"));
        await writeFile(join(gitDir, "config.worktree"), "[remote \"origin\"]\n\tpushurl = https://untrusted.example/worktree.git\n");
      }

      await exec.rebuildTrustedMetadata(workspace, remotes);

      for (const [subPath, remoteUrl] of remotes) {
        expect((await exec.execGit(workspace, ["remote", "get-url", "--all", "origin"], subPath)).trim())
          .toBe(remoteUrl);
        expect((await exec.execGit(workspace, ["remote", "get-url", "--push", "--all", "origin"], subPath)).trim())
          .toBe(remoteUrl);
        expect((await exec.execGit(workspace, ["rev-parse", "--absolute-git-dir"], subPath)).trim())
          .toBe(join(workspace, subPath, ".git"));
        expect(await readFile(join(workspace, subPath, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves detached shallow history when rebuilding a standalone repository", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ve-git-detached-shallow-"));
    const exec = new HostGitExecutor({ baseDir: tmpdir() });

    try {
      await exec.execGit(workspace, ["init", "--initial-branch=main"]);
      await exec.execGit(workspace, [
        "-c", "user.name=Test",
        "-c", "user.email=test@example.com",
        "commit", "--allow-empty", "--no-gpg-sign", "-m", "test",
      ]);
      const commit = (await exec.execGit(workspace, ["rev-parse", "HEAD"])).trim();
      await exec.execGit(workspace, ["checkout", "--detach", "HEAD"]);
      await writeFile(join(workspace, ".git", "shallow"), `${commit}\n`);

      await exec.rebuildTrustedMetadata(workspace, new Map([[".", "https://trusted.example/repo.git"]]));

      expect((await exec.execGit(workspace, ["log", "-1", "--format=%H"])).trim()).toBe(commit);
      expect((await exec.execGit(workspace, ["remote", "get-url", "--push", "origin"])).trim())
        .toBe("https://trusted.example/repo.git");
      expect(await readFile(join(workspace, ".git", "HEAD"), "utf8")).toBe(`${commit}\n`);
      expect(await readFile(join(workspace, ".git", "shallow"), "utf8")).toBe(`${commit}\n`);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("overrides repository ext transport permission for read-only host Git commands", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ve-git-ext-policy-"));
    const exec = new HostGitExecutor({ baseDir: tmpdir() });

    try {
      const gitDir = await createReturnedRepository(workspace);
      await writeFile(join(gitDir, "config"), "[protocol \"ext\"]\n\tallow = always\n");

      expect((await exec.execGit(workspace, ["config", "--get", "protocol.ext.allow"])).trim()).toBe("never");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
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
