import { afterEach, describe, expect, it, vi } from "vitest";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ExecFileImpl = () => Promise<{ stdout: string; stderr: string }>;

function mockExecFile(impl: ExecFileImpl): ReturnType<typeof vi.fn> {
  vi.resetModules();
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, { value: vi.fn(impl) });
  vi.doMock("node:child_process", () => ({ execFile }));
  return execFile;
}

function execFileAsyncOf(execFile: ReturnType<typeof vi.fn>): ReturnType<typeof vi.fn> {
  const impl = (execFile as unknown as Record<symbol, ReturnType<typeof vi.fn> | undefined>)[promisify.custom];
  if (!impl) throw new Error("execFile mock is missing its promisify.custom implementation");
  return impl;
}

async function withWorkspace(withGit: boolean, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ve-skill-installer-"));
  try {
    if (withGit) await mkdir(join(dir, ".git"), { recursive: true });
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("skill source installer", () => {
  afterEach(() => {
    delete process.env["SKILLS_CLI_PACKAGE"];
  });

  it("does nothing when no skill sources are configured", async () => {
    const execFile = mockExecFile(async () => ({ stdout: "", stderr: "" }));
    const { installSkillSources } = await import("../../src/workspace/skillSourceInstaller.js");

    await withWorkspace(true, async (dir) => {
      await installSkillSources(dir, "[]", "claude");
      await installSkillSources(dir, undefined, "claude");
    });

    expect(execFileAsyncOf(execFile)).not.toHaveBeenCalled();
  });

  it("skips installation when the agent provider has no skill-directory support", async () => {
    const execFile = mockExecFile(async () => ({ stdout: "", stderr: "" }));
    const { installSkillSources } = await import("../../src/workspace/skillSourceInstaller.js");
    const sources = JSON.stringify([{ source: "example-org/agent-skills", installAll: true }]);

    await withWorkspace(true, async (dir) => {
      await installSkillSources(dir, sources, undefined);
    });

    expect(execFileAsyncOf(execFile)).not.toHaveBeenCalled();
  });

  it("installs each configured source with project scope, workspace cwd, and a bounded timeout", async () => {
    const execFile = mockExecFile(async () => ({ stdout: "", stderr: "" }));
    const { installSkillSources, SKILL_INSTALL_TIMEOUT_MS } = await import("../../src/workspace/skillSourceInstaller.js");
    const sources = JSON.stringify([{ source: "example-org/agent-skills", skills: ["skill-a"] }]);

    await withWorkspace(true, async (dir) => {
      await installSkillSources(dir, sources, "claude");

      expect(execFileAsyncOf(execFile)).toHaveBeenCalledWith(
        "npx",
        ["--yes", "skills@1.5.16", "add", "example-org/agent-skills", "--skill", "skill-a", "-a", "claude-code", "--copy", "-y"],
        expect.objectContaining({ cwd: dir, timeout: SKILL_INSTALL_TIMEOUT_MS })
      );
    });
  });

  it("continues past a failing source and still installs the rest", async () => {
    let call = 0;
    const execFile = mockExecFile(async () => {
      call += 1;
      if (call === 1) throw new Error("network unreachable");
      return { stdout: "", stderr: "" };
    });
    const { installSkillSources } = await import("../../src/workspace/skillSourceInstaller.js");
    const sources = JSON.stringify([
      { source: "bad-org/agent-skills", installAll: true },
      { source: "good-org/agent-skills", installAll: true },
    ]);

    await withWorkspace(true, async (dir) => {
      await expect(installSkillSources(dir, sources, "copilot")).resolves.toBeUndefined();
    });

    expect(execFileAsyncOf(execFile)).toHaveBeenCalledTimes(2);
  });

  it("skips a source whose SSH key path is outside the approved secrets directory, without throwing", async () => {
    const execFile = mockExecFile(async () => ({ stdout: "", stderr: "" }));
    const { installSkillSources } = await import("../../src/workspace/skillSourceInstaller.js");
    const sources = JSON.stringify([
      { source: "ssh://skills.example.com/org/agent-skills", installAll: true, sshKeyPath: "/etc/passwd" },
    ]);

    await withWorkspace(true, async (dir) => {
      await expect(installSkillSources(dir, sources, "claude")).resolves.toBeUndefined();
    });

    expect(execFileAsyncOf(execFile)).not.toHaveBeenCalled();
  });

  it("adds the target agent's project skill directory to .git/info/exclude, idempotently", async () => {
    mockExecFile(async () => ({ stdout: "", stderr: "" }));
    const { installSkillSources } = await import("../../src/workspace/skillSourceInstaller.js");
    const sources = JSON.stringify([{ source: "example-org/agent-skills", installAll: true }]);

    await withWorkspace(true, async (dir) => {
      await installSkillSources(dir, sources, "claude");
      const exclude = await readFile(join(dir, ".git", "info", "exclude"), "utf8");
      expect(exclude).toContain(".claude/skills/\n");

      await installSkillSources(dir, sources, "claude");
      const excludeAgain = await readFile(join(dir, ".git", "info", "exclude"), "utf8");
      expect(excludeAgain.split("\n").filter((line) => line.trim() === ".claude/skills/")).toHaveLength(1);
    });
  });

  it("maps each supported provider to its own project skill directory", async () => {
    mockExecFile(async () => ({ stdout: "", stderr: "" }));
    const { installSkillSources } = await import("../../src/workspace/skillSourceInstaller.js");
    const sources = JSON.stringify([{ source: "example-org/agent-skills", installAll: true }]);

    await withWorkspace(true, async (dir) => {
      await installSkillSources(dir, sources, "copilot");
      await installSkillSources(dir, sources, "goose");
      const exclude = await readFile(join(dir, ".git", "info", "exclude"), "utf8");
      expect(exclude).toContain(".agents/skills/\n");
      expect(exclude).toContain(".goose/skills/\n");
    });
  });

  it("does not create .git/info/exclude for multi-repo layouts with no root .git", async () => {
    mockExecFile(async () => ({ stdout: "", stderr: "" }));
    const { installSkillSources } = await import("../../src/workspace/skillSourceInstaller.js");
    const sources = JSON.stringify([{ source: "example-org/agent-skills", installAll: true }]);

    await withWorkspace(false, async (dir) => {
      await installSkillSources(dir, sources, "goose");
      await expect(readFile(join(dir, ".git", "info", "exclude"), "utf8")).rejects.toThrow();
    });
  });
});
