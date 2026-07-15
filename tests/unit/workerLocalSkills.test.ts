import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DEFAULT_LOCAL_SKILLS_PATH,
  emitLocalSkillsLoaded,
  localSkillsDir,
  localSkillsPath,
} from "../../agent-worker/src/skills.js";

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
});
