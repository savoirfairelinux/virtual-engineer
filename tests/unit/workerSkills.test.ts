import { afterEach, describe, expect, it } from "vitest";
import {
  buildSkillsCliArgs,
  parseRemoteSkillSources,
  resolveSkillSourceUrl,
  skillsAgentId,
} from "../../src/workspace/skillSources.js";

describe("agent-worker remote skills", () => {
  afterEach(() => {
    delete process.env["SKILLS_CLI_PACKAGE"];
  });

  it("parses explicit and install-all skill sources", () => {
    const parsed = parseRemoteSkillSources(JSON.stringify([
      { source: "ssh://skills.example.com/org/agent-skills", skills: ["skill-a", "skill-b", "skill-a"] },
      { source: "example-org/agent-skills", installAll: true },
    ]));

    expect(parsed).toEqual([
      { source: "ssh://skills.example.com/org/agent-skills", skills: ["skill-a", "skill-b"] },
      { source: "example-org/agent-skills", skills: [], installAll: true },
    ]);
  });

  it("builds non-interactive npx skills commands for Copilot", () => {
    const args = buildSkillsCliArgs(
      { source: "ssh://skills.example.com/org/agent-skills", skills: ["skill-a", "skill-b"] },
      "copilot",
    );

    expect(args).toEqual([
      "--yes",
      "skills@1.5.16",
      "add",
      "ssh://skills.example.com/org/agent-skills",
      "--skill",
      "skill-a",
      "--skill",
      "skill-b",
      "-g",
      "-a",
      "github-copilot",
      "--copy",
      "-y",
    ]);
  });

  it("omits --skill when installing all skills", () => {
    const args = buildSkillsCliArgs({ source: "example-org/agent-skills", skills: [], installAll: true }, "claude");

    expect(args).toEqual([
      "--yes",
      "skills@1.5.16",
      "add",
      "example-org/agent-skills",
      "-g",
      "-a",
      "claude-code",
      "--copy",
      "-y",
    ]);
  });

  it("maps provider IDs to npx skills agent IDs", () => {
    expect(skillsAgentId("copilot")).toBe("github-copilot");
    expect(skillsAgentId("claude")).toBe("claude-code");
  });

  it("allows overriding the pinned skills CLI package", () => {
    process.env["SKILLS_CLI_PACKAGE"] = "skills@1.5.17";

    const args = buildSkillsCliArgs({ source: "example-org/agent-skills", skills: ["skill-a"] }, "copilot");

    expect(args[1]).toBe("skills@1.5.17");
  });

  it("applies configured SSH user and port to ssh source URLs", () => {
    const source = {
      source: "ssh://skills.example.com/org/agent-skills",
      skills: ["skill-a"],
      sshUser: "git-user",
      sshPort: 29418,
    };

    expect(resolveSkillSourceUrl(source)).toBe("ssh://git-user@skills.example.com:29418/org/agent-skills");
    expect(buildSkillsCliArgs(source, "copilot")[3]).toBe("ssh://git-user@skills.example.com:29418/org/agent-skills");
  });

  it("keeps explicit SSH source user and port", () => {
    expect(resolveSkillSourceUrl({
      source: "ssh://git@skills.example.com:2222/org/agent-skills",
      skills: ["skill-a"],
      sshUser: "git-user",
      sshPort: 29418,
    })).toBe("ssh://git@skills.example.com:2222/org/agent-skills");
  });

  it("rejects malformed SSH source URLs with context", () => {
    expect(() => resolveSkillSourceUrl({
      source: "ssh://",
      skills: ["skill-a"],
      sshUser: "git-user",
    })).toThrow('Invalid SSH skill source URL "ssh://"');
  });

  it("rejects invalid configured skill source entries", () => {
    expect(() => parseRemoteSkillSources(JSON.stringify([
      { source: "ssh://skills.example.com/org/agent-skills", skills: [] },
    ]))).toThrow("select at least one skill");
    expect(() => parseRemoteSkillSources(JSON.stringify([
      { source: "ssh://skills.example.com/org/agent-skills", skills: ["skill-a", ""] },
    ]))).toThrow("non-empty strings");
    expect(() => parseRemoteSkillSources(JSON.stringify([
      { source: "ssh://skills.example.com/org/agent-skills", skills: ["skill-a"], sshPort: 0 },
    ]))).toThrow("sshPort");
    expect(() => parseRemoteSkillSources(JSON.stringify([
      { source: "ssh://skills.example.com/org/agent-skills", skills: ["skill-a"], sshKeyPath: "" },
    ]))).toThrow("sshKeyPath");
    expect(() => parseRemoteSkillSources(JSON.stringify([
      { source: "ssh://skills.example.com/org/agent-skills", skills: ["skill-a"], sshKnownHostsPath: "" },
    ]))).toThrow("sshKnownHostsPath");
  });

  it("wraps invalid JSON with skill source context", () => {
    expect(() => parseRemoteSkillSources("not-json")).toThrow("skillSourcesJson must be valid JSON");
  });

});
