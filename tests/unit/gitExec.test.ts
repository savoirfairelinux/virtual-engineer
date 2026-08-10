import { describe, it, expect } from "vitest";
import { trustedGitArgs, trustedGitEnv } from "../../src/utils/gitExec.js";

describe("trustedGitArgs", () => {
  it("neutralises repository hooks and config includes", () => {
    expect(trustedGitArgs(["status"])).toEqual([
      "-c", "core.hooksPath=/dev/null",
      "-c", "include.path=/dev/null",
      "status",
    ]);
  });

  it("does not mutate the caller's argument array", () => {
    const args = ["push", "origin", "HEAD"];
    trustedGitArgs(args);
    expect(args).toEqual(["push", "origin", "HEAD"]);
  });
});

describe("trustedGitEnv", () => {
  it("pins global and system config to /dev/null", () => {
    expect(trustedGitEnv()).toMatchObject({
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    });
  });

  it("merges extra variables without letting them relax the pinning", () => {
    const env = trustedGitEnv({ GIT_SSH_COMMAND: "ssh -o Foo=bar" });
    expect(env["GIT_SSH_COMMAND"]).toBe("ssh -o Foo=bar");
    expect(env["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
    expect(env["GIT_CONFIG_SYSTEM"]).toBe("/dev/null");
  });
});
