import { afterEach, describe, expect, it, vi } from "vitest";
import { promisify } from "node:util";
import {
  buildSkillListArgs,
  buildSkillListEnv,
  SKILL_LIST_TIMEOUT_MS,
  parseSkillListOutput,
  resolveSkillSourceUrl,
  validateSkillSourceSshAuth,
} from "../../src/admin/skillSourceDiscovery.js";

describe("admin skill source discovery", () => {
  afterEach(() => {
    delete process.env["SKILLS_CLI_PACKAGE"];
    delete process.env["VE_TEST_SECRET"];
  });

  it("builds pinned npx skills list commands", () => {
    expect(buildSkillListArgs({ source: "ssh://skills.example.com/org/agent-skills" })).toEqual([
      "--yes",
      "skills@1.5.16",
      "add",
      "-l",
      "ssh://skills.example.com/org/agent-skills",
    ]);
  });

  it("uses a bounded timeout for skill list commands", () => {
    expect(SKILL_LIST_TIMEOUT_MS).toBe(30_000);
  });

  it("passes the bounded timeout to npx skills list", async () => {
    vi.resetModules();
    const execFile = vi.fn();
    Object.defineProperty(execFile, promisify.custom, {
      value: vi.fn(async () => ({ stdout: "- skill-a\n", stderr: "" })),
    });
    vi.doMock("node:child_process", () => ({ execFile }));

    const { listSkillSourceSkills } = await import("../../src/admin/skillSourceDiscovery.js");
    await listSkillSourceSkills({ source: "example-org/agent-skills" });

    const execFileAsync = (execFile as typeof execFile & { [promisify.custom]: ReturnType<typeof vi.fn> })[promisify.custom];
    expect(execFileAsync).toHaveBeenCalledWith(
      "npx",
      ["--yes", "skills@1.5.16", "add", "-l", "example-org/agent-skills"],
      expect.objectContaining({ timeout: 30_000 })
    );
  });

  it("allows overriding the skills CLI package", () => {
    process.env["SKILLS_CLI_PACKAGE"] = "skills@1.5.17";

    expect(buildSkillListArgs({ source: "vercel-labs/agent-skills" })[1]).toBe("skills@1.5.17");
  });

  it("applies SSH user and port to incomplete ssh URLs", () => {
    expect(resolveSkillSourceUrl({
      source: "ssh://skills.example.com/org/agent-skills",
      sshUser: "git-user",
      sshPort: 29418,
    })).toBe("ssh://git-user@skills.example.com:29418/org/agent-skills");
  });

  it("detects uppercase SSH URLs for URL resolution and SSH env", () => {
    const source = {
      source: "SSH://skills.example.com/org/agent-skills",
      sshUser: "git-user",
      sshPort: 29418,
      sshKeyPath: "/tmp/key",
    };

    expect(resolveSkillSourceUrl(source)).toBe("ssh://git-user@skills.example.com:29418/org/agent-skills");
    expect(buildSkillListEnv(source)["GIT_SSH_COMMAND"]).toBe("ssh -i '/tmp/key' -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 29418");
    expect(buildSshConnectionArgs(source)).toContain("git-user@skills.example.com");
  });

  it("rejects malformed SSH source URLs with context", () => {
    expect(() => resolveSkillSourceUrl({
      source: "ssh://",
      sshPort: 29418,
    })).toThrow('Invalid SSH skill source URL "ssh://"');
  });

  it("builds SSH env for configured private keys", () => {
    const env = buildSkillListEnv({
      source: "ssh://skills.example.com/org/agent-skills",
      sshPort: 29418,
      sshKeyPath: "/tmp/key with spaces",
    });

    expect(env["GIT_SSH_COMMAND"]).toBe("ssh -i '/tmp/key with spaces' -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 29418");
  });

  it("rejects conflicting explicit SSH URL and fallback ports", () => {
    expect(() => buildSkillListEnv({
      source: "ssh://skills.example.com:2222/org/agent-skills",
      sshPort: 29418,
      sshKeyPath: "/tmp/key",
    })).toThrow("URL uses port 2222 but sshPort is 29418");
  });

  it("allows matching explicit SSH URL and fallback ports", () => {
    const env = buildSkillListEnv({
      source: "ssh://skills.example.com:2222/org/agent-skills",
      sshPort: 2222,
      sshKeyPath: "/tmp/key",
    });

    expect(env["GIT_SSH_COMMAND"]).toBe("ssh -i '/tmp/key' -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null");
  });

  it("builds SSH env with strict known_hosts checking when configured", () => {
    const env = buildSkillListEnv({
      source: "ssh://skills.example.com/org/agent-skills",
      sshKeyPath: "/tmp/key with spaces",
      sshKnownHostsPath: "/tmp/known hosts",
    });

    expect(env["GIT_SSH_COMMAND"]).toBe("ssh -i '/tmp/key with spaces' -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile='/tmp/known hosts'");
  });

  it("builds SSH env for agent-backed SSH sources", () => {
    const env = buildSkillListEnv({
      source: "ssh://skills.example.com/org/agent-skills",
      sshPort: 29418,
    });

    expect(env["GIT_SSH_COMMAND"]).toBe("ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 29418");
  });

  it("does not forward arbitrary orchestrator env vars to npx skills", () => {
    process.env["VE_TEST_SECRET"] = "secret-value";

    const env = buildSkillListEnv({ source: "example-org/agent-skills" });

    expect(env["VE_TEST_SECRET"]).toBeUndefined();
  });

  it("disables npm update notifier for npx skills list", () => {
    const env = buildSkillListEnv({ source: "example-org/agent-skills" });

    expect(env["NPM_CONFIG_UPDATE_NOTIFIER"]).toBe("false");
  });

  it("only forwards SSH_AUTH_SOCK when SSH sources need agent auth", () => {
    const originalSshAuthSock = process.env["SSH_AUTH_SOCK"];
    process.env["SSH_AUTH_SOCK"] = "/tmp/ve-ssh.sock";
    try {
      expect(buildSkillListEnv({ source: "example-org/agent-skills" })["SSH_AUTH_SOCK"]).toBeUndefined();
      expect(buildSkillListEnv({
        source: "ssh://skills.example.com/org/agent-skills",
        sshKeyPath: "/tmp/key",
      })["SSH_AUTH_SOCK"]).toBeUndefined();
      expect(buildSkillListEnv({ source: "git@skills.example.com:org/agent-skills" })["SSH_AUTH_SOCK"]).toBe("/tmp/ve-ssh.sock");
    } finally {
      if (originalSshAuthSock === undefined) delete process.env["SSH_AUTH_SOCK"];
      else process.env["SSH_AUTH_SOCK"] = originalSshAuthSock;
    }
  });

  it("rejects SSH sources without agent or readable key", async () => {
    const originalSshAuthSock = process.env["SSH_AUTH_SOCK"];
    delete process.env["SSH_AUTH_SOCK"];
    try {
      await expect(validateSkillSourceSshAuth({
        source: "ssh://skills.example.com/org/agent-skills",
      })).rejects.toThrow("SSH_AUTH_SOCK");
      await expect(validateSkillSourceSshAuth({
        source: "ssh://skills.example.com/org/agent-skills",
        sshKeyPath: "/tmp/virtual-engineer-missing-key",
      })).rejects.toThrow("not readable");
    } finally {
      if (originalSshAuthSock === undefined) delete process.env["SSH_AUTH_SOCK"];
      else process.env["SSH_AUTH_SOCK"] = originalSshAuthSock;
    }
  });

  it("parses skill names from list output", () => {
    expect(parseSkillListOutput(`
      │ skill-a         First listed skill
      │ skill-b         Second listed skill
      - skill-c: Third listed skill
    `)).toEqual(["skill-a", "skill-b", "skill-c"]);
  });
});
