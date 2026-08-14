/**
 * Test suite for GerritVcsConnector.
 * Tests clone and push operations to Gerrit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GerritVcsConnector } from "../../src/vcs/gerritVcsConnector.js";
import type { GerritVcsConnectorConfig } from "../../src/vcs/gerritVcsConnector.js";
import type { SshChangeInfo } from "../../src/connectors/gerritSshClient.js";
import { RecordingGitRunner } from "./helpers/recordingGitRunner.js";

// Mock GerritSshClient (used for SSH Gerrit operations)
const mockQueryChange = vi.fn(async (_changeId: string): Promise<SshChangeInfo> => ({
  number: 1,
  status: "NEW",
}));
const mockGetUnresolvedComments = vi.fn();
const mockResolveComments = vi.fn();
const mockQueryOwnAccountIdentity = vi.fn();

vi.mock("../../src/connectors/gerritSshClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/connectors/gerritSshClient.js")>();
  return {
    ...actual,
    GerritSshClient: vi.fn().mockImplementation(function () {
      return {
        queryChange: mockQueryChange,
        getUnresolvedComments: mockGetUnresolvedComments,
        resolveComments: mockResolveComments,
        queryOwnAccountIdentity: mockQueryOwnAccountIdentity,
      };
    }),
  };
});

const mockConfig: GerritVcsConnectorConfig = {
  baseUrl: "https://gerrit.example.com",
  sshHost: "gerrit.example.com",
  sshPort: 29418,
  sshUser: "virtual-engineer",
  sshKeyPath: "/home/user/.ssh/id_rsa",
  gitAuthorName: "Virtual Engineer",
  gitAuthorEmail: "ve@example.com",
};

describe("GerritVcsConnector", () => {
  let connector: GerritVcsConnector;
  let gitRunner: RecordingGitRunner;

  beforeEach(() => {
    gitRunner = new RecordingGitRunner();
    connector = new GerritVcsConnector(mockConfig, gitRunner);
    vi.clearAllMocks();
    mockQueryChange.mockReset();
    mockGetUnresolvedComments.mockReset();
    mockResolveComments.mockReset();
    mockQueryOwnAccountIdentity.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("clone", () => {
    it("should execute git clone with correct parameters", async () => {
      const repoUrl = "ssh://gerrit.example.com:29418/my-repo.git";
      const branch = "main";
      const targetDir = "/tmp/workspace/repo";

      await connector.clone(repoUrl, branch, targetDir);

      expect(gitRunner.run).toHaveBeenCalledWith(
        ["clone", "--branch", branch, "--depth", "1", "--", repoUrl, targetDir],
        expect.objectContaining({
          env: expect.objectContaining({
            GIT_SSH_COMMAND: expect.stringContaining(mockConfig.sshKeyPath!),
          }),
          timeoutMs: 300_000,
        })
      );
    });

    it("accepts a configured-host scp-style URL", async () => {
      await connector.clone("virtual-engineer@gerrit.example.com:my-repo.git", "main", "/tmp/repo");

      expect(gitRunner.run).toHaveBeenCalledWith(
        ["clone", "--branch", "main", "--depth", "1", "--", "virtual-engineer@gerrit.example.com:my-repo.git", "/tmp/repo"],
        expect.any(Object)
      );
    });

    it.each([
      ["/tmp/local-repo", "local path"],
      ["ext::sh -c whoami", "ext protocol"],
      ["-unsafe", "option-like value"],
      ["ssh://gerrit.evil.example:29418/my-repo.git", "unconfigured host"],
      ["https://gerrit.example.com/my-repo.git", "wrong scheme"],
    ])("rejects %s (%s) before invoking git", async (repoUrl) => {
      gitRunner.run.mockClear();

      await expect(connector.clone(repoUrl, "main", "/tmp/repo")).rejects.toThrow();
      expect(gitRunner.run).not.toHaveBeenCalled();
    });

    it("should throw on clone failure", async () => {
      gitRunner.run.mockRejectedValueOnce(new Error("SSH connection refused"));

      await expect(
        connector.clone("ssh://gerrit.example.com:29418/repo.git", "main", "/tmp/repo")
      ).rejects.toThrow("Failed to clone Gerrit repository");
    });

    it("should use override SSH key path when provided", async () => {
      const repoUrl = "ssh://gerrit.example.com:29418/my-repo.git";
      const branch = "main";
      const targetDir = "/tmp/workspace/repo";
      const overrideSshKeyPath = "/home/user/.ssh/custom-key";

      await connector.clone(repoUrl, branch, targetDir, overrideSshKeyPath);

      expect(gitRunner.run).toHaveBeenCalledWith(
        ["clone", "--branch", branch, "--depth", "1", "--", repoUrl, targetDir],
        expect.objectContaining({
          env: expect.objectContaining({
            GIT_SSH_COMMAND: expect.stringContaining(overrideSshKeyPath),
          }),
        })
      );

      const cloneCall = gitRunner.calls[0];
      expect(cloneCall?.options.env?.["GIT_SSH_COMMAND"]).not.toContain(
        mockConfig.sshKeyPath!
      );
    });
  });

  describe("GIT_SSH_COMMAND / known-hosts policy", () => {
    it("includes UserKnownHostsFile=/dev/null when sshKnownHostsPath is not set", async () => {
      await connector.clone("ssh://gerrit.example.com:29418/repo.git", "main", "/tmp/repo");

      const sshCommand = gitRunner.calls[0]?.options.env?.["GIT_SSH_COMMAND"];
      expect(sshCommand).toContain("StrictHostKeyChecking=no");
      expect(sshCommand).toContain("UserKnownHostsFile=/dev/null");
    });

    it("uses strict host-key checking when sshKnownHostsPath is set", async () => {
      const knownConnector = new GerritVcsConnector({
        ...mockConfig,
        sshKnownHostsPath: "/app/secrets/gerrit_known_hosts",
      }, gitRunner);
      await knownConnector.clone("ssh://gerrit.example.com:29418/repo.git", "main", "/tmp/repo");

      const sshCommand = gitRunner.calls[0]?.options.env?.["GIT_SSH_COMMAND"];
      expect(sshCommand).toContain("StrictHostKeyChecking=yes");
      expect(sshCommand).toContain("UserKnownHostsFile=/app/secrets/gerrit_known_hosts");
      expect(sshCommand).not.toContain("StrictHostKeyChecking=no");
    });
  });


  describe("pushDirect", () => {
    it("combines the topic and reviewer options in one Gerrit suffix", async () => {
      await connector.pushDirect(
        "/tmp/workspace/repo",
        "refs/for/main",
        "VE-task-1",
        ["alice@example.com", "bob@example.com"]
      );

      expect(gitRunner.run).toHaveBeenCalledWith(
        ["push", "origin", "HEAD:refs/for/main%topic=VE-task-1,r=alice@example.com,r=bob@example.com"],
        expect.any(Object)
      );
    });
  });

  describe("getChangeStatus", () => {
    it("returns OPEN when Gerrit reports NEW", async () => {
      mockQueryChange.mockResolvedValue({ number: 42, status: "NEW", currentPatchSet: { number: 1, revision: "abc" } });

      const status = await connector.getChangeStatus("I1234567890");

      expect(status).toBe("OPEN");
    });

    it("returns MERGED when Gerrit reports MERGED", async () => {
      mockQueryChange.mockResolvedValue({ number: 42, status: "MERGED" });

      const status = await connector.getChangeStatus("I1234567890");

      expect(status).toBe("MERGED");
    });

    it("defaults to OPEN when SSH query fails", async () => {
      mockQueryChange.mockRejectedValue(new Error("SSH connection refused"));

      const status = await connector.getChangeStatus("I1234567890");

      expect(status).toBe("OPEN");
    });
  });

  describe("push-spec protocol members", () => {
    it("useChangeIdContinuity is true", () => {
      expect(connector.useChangeIdContinuity).toBe(true);
    });

    it("reviewSystemLabel is \"gerrit\"", () => {
      expect(connector.reviewSystemLabel).toBe("gerrit");
    });

    it("buildPushSpec returns refs/for/<branch> and topic VE-<taskId> when ticketTitle is missing", () => {
      const spec = connector.buildPushSpec("main", "task-1");
      expect(spec.ref).toBe("refs/for/main");
      expect(spec.topic).toBe("VE-task-1");
    });

    it("buildPushSpec encodes the branch correctly for non-main branches", () => {
      const spec = connector.buildPushSpec("release/1.0", "abc");
      expect(spec.ref).toBe("refs/for/release/1.0");
      expect(spec.topic).toBe("VE-abc");
    });

    it("buildPushSpec uses a slug from ticketTitle when provided", () => {
      const spec = connector.buildPushSpec("main", "b7ddee79-cc3b-4208-815c-70fcf177a49e", "Add login button");
      expect(spec.ref).toBe("refs/for/main");
      expect(spec.topic).toBe("VE-b7ddee79-add-login-button");
    });

    it("buildPushSpec falls back to VE-<taskId> when ticketTitle is empty", () => {
      const spec = connector.buildPushSpec("main", "task-1", "");
      expect(spec.topic).toBe("VE-task-1");
    });
  });

  describe("queryAuthorIdentity", () => {
    it("delegates to the underlying SSH client", async () => {
      mockQueryOwnAccountIdentity.mockResolvedValue({ name: "Virtual Engineer", email: "virtual-engineer@jami.net" });

      const identity = await connector.queryAuthorIdentity();

      expect(identity).toEqual({ name: "Virtual Engineer", email: "virtual-engineer@jami.net" });
      expect(mockQueryOwnAccountIdentity).toHaveBeenCalledTimes(1);
    });

    it("returns undefined when the SSH client can't resolve an identity", async () => {
      mockQueryOwnAccountIdentity.mockResolvedValue(undefined);
      await expect(connector.queryAuthorIdentity()).resolves.toBeUndefined();
    });
  });
});
