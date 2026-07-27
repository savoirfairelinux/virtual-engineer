import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  copilotGlobalSkillsDir,
  DEFAULT_LOCAL_SKILLS_PATH,
  emitLocalSkillsLoaded,
  localSkillsDir,
  localSkillsPath,
} from "../../agent-worker/src/skills.js";
import { copilotSkillDirectories } from "../../agent-worker/src/providers/copilot.js";

describe("agent-worker local skills", () => {
  afterEach(() => {
    delete process.env["LOCAL_SKILLS_PATH"];
    vi.restoreAllMocks();
  });

  it("defaults local skills to .github/skills", () => {
    expect(localSkillsPath()).toBe(DEFAULT_LOCAL_SKILLS_PATH);
    expect(localSkillsDir("/workspace")).toBe("/workspace/.github/skills");
  });

  it("uses a configured workspace-relative local skills path", () => {
    process.env["LOCAL_SKILLS_PATH"] = "custom/skills";

    expect(localSkillsPath()).toBe("custom/skills");
    expect(localSkillsDir("/workspace")).toBe("/workspace/custom/skills");
  });

  it("keeps local skill directories inside the workspace", () => {
    process.env["LOCAL_SKILLS_PATH"] = "../outside";
    expect(localSkillsDir("/workspace")).toBe("/workspace/.github/skills");

    process.env["LOCAL_SKILLS_PATH"] = "/absolute/skills";
    expect(localSkillsDir("/workspace")).toBe("/workspace/.github/skills");

    process.env["LOCAL_SKILLS_PATH"] = ".";
    expect(localSkillsDir("/workspace")).toBe("/workspace/.github/skills");
  });

  it("logs the effective fallback path when the configured path is invalid", () => {
    process.env["LOCAL_SKILLS_PATH"] = "../outside";
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    emitLocalSkillsLoaded("/workspace");

    const payload = JSON.parse(String(stderrWrite.mock.calls[0]?.[0]));
    expect(payload.data).toMatchObject({ path: ".github/skills", skills: [] });
  });

  it("emits one timeline event with the configured path and sorted skill list", () => {
    const workspace = mkdtempSync(join(tmpdir(), "ve-local-skills-"));
    process.env["LOCAL_SKILLS_PATH"] = "team-skills";
    const skillsDir = join(workspace, "team-skills");
    mkdirSync(join(skillsDir, "zeta"), { recursive: true });
    mkdirSync(join(skillsDir, "alpha"), { recursive: true });
    writeFileSync(join(skillsDir, "README.md"), "not a skill directory");
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      emitLocalSkillsLoaded(workspace);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }

    expect(stderrWrite).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(stderrWrite.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      __ve_event: true,
      type: "skills.local_loaded",
      data: { path: "team-skills", skills: ["alpha", "zeta"] },
    });
  });

  it("loads fetched Copilot skills even when local skill discovery is disabled", () => {
    const home = mkdtempSync(join(tmpdir(), "ve-copilot-home-"));
    const workspace = mkdtempSync(join(tmpdir(), "ve-copilot-workspace-"));
    const oldHome = process.env["HOME"];
    process.env["HOME"] = home;
    mkdirSync(copilotGlobalSkillsDir(), { recursive: true });

    try {
      expect(copilotSkillDirectories(workspace, false)).toEqual([copilotGlobalSkillsDir()]);
    } finally {
      if (oldHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = oldHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("loads local and fetched Copilot skills when local skill discovery is enabled", () => {
    const home = mkdtempSync(join(tmpdir(), "ve-copilot-home-"));
    const workspace = mkdtempSync(join(tmpdir(), "ve-copilot-workspace-"));
    const oldHome = process.env["HOME"];
    process.env["HOME"] = home;
    mkdirSync(copilotGlobalSkillsDir(), { recursive: true });
    mkdirSync(localSkillsDir(workspace), { recursive: true });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      expect(copilotSkillDirectories(workspace, true)).toEqual([
        localSkillsDir(workspace),
        copilotGlobalSkillsDir(),
      ]);
      expect(stderrWrite).toHaveBeenCalledTimes(1);
    } finally {
      if (oldHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = oldHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
