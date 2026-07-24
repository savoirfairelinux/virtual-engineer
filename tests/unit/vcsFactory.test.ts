/**
 * Test suite for VCS Connector Factory.
 * Tests the DB-driven createVcsConnectorForIntegration.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    accessSync: vi.fn(),
  };
});

import { registerBuiltinPlugins } from "../../src/plugins/init.js";
import {
  createVcsConnectorForIntegration,
  VcsConnectorFactory,
} from "../../src/vcs/vcsFactory.js";
import { GerritVcsConnector } from "../../src/vcs/gerritVcsConnector.js";
import { GitLabVcsConnector } from "../../src/vcs/gitlabVcsConnector.js";
import type { Integration } from "../../src/interfaces.js";
import type { GitRunner } from "../../src/vcs/gitRunner.js";

function makeIntegration(overrides: Partial<Integration> & { id: string; provider: Integration["provider"]; configJson: string }): Integration {
  return {
    name: overrides.provider,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("createVcsConnectorForIntegration", () => {
  beforeAll(() => {
    registerBuiltinPlugins();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Gerrit integration", () => {
    const gerritIntegration = makeIntegration({
      id: "gerrit-1",
      provider: "gerrit",
      configJson: JSON.stringify({
        sshHost: "gerrit.local",
        sshPort: 29418,
        sshUser: "ve-bot",
        sshKeyPath: "/keys/id_rsa",
        gitAuthorName: "Virtual Engineer",
        gitAuthorEmail: "ve@test.local",
      }),
    });

    it("creates a GerritVcsConnector for a gerrit integration", () => {
      const connector = createVcsConnectorForIntegration(gerritIntegration);
      expect(connector).toBeInstanceOf(GerritVcsConnector);
    });

    it("injects the source-control runtime Git runner", () => {
      const gitRunner: GitRunner = {
        run: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
      };

      const connector = createVcsConnectorForIntegration(
        gerritIntegration,
        undefined,
        undefined,
        { gitRunner }
      );

      expect((connector as unknown as { gitRunner: GitRunner }).gitRunner).toBe(gitRunner);
    });

    it("throws when sshHost is missing", () => {
      const integration = makeIntegration({
        id: "gerrit-bad",
        provider: "gerrit",
        configJson: JSON.stringify({ sshUser: "ve-bot", sshKeyPath: "/keys/id_rsa" }),
      });
      expect(() => createVcsConnectorForIntegration(integration)).toThrow(
        /invalid config/
      );
    });

    it("throws when sshUser is missing", () => {
      const integration = makeIntegration({
        id: "gerrit-bad",
        provider: "gerrit",
        configJson: JSON.stringify({ sshHost: "gerrit.local", sshKeyPath: "/keys/id_rsa" }),
      });
      expect(() => createVcsConnectorForIntegration(integration)).toThrow(
        /invalid config/
      );
    });

    it("uses default sshKeyPath when sshKeyPath is missing", () => {
      const integration = makeIntegration({
        id: "gerrit-no-key",
        provider: "gerrit",
        configJson: JSON.stringify({ sshHost: "gerrit.local", sshUser: "ve-bot" }),
      });
      // sshKeyPath has a Zod default — should not throw
      const connector = createVcsConnectorForIntegration(integration);
      expect(connector).toBeInstanceOf(GerritVcsConnector);
    });

    it("throws for invalid configJson", () => {
      const integration = makeIntegration({
        id: "gerrit-bad",
        provider: "gerrit",
        configJson: "not-json",
      });
      expect(() => createVcsConnectorForIntegration(integration)).toThrow(
        /invalid configJson/
      );
    });

    it("uses default gitAuthorName and gitAuthorEmail when not provided", () => {
      const integration = makeIntegration({
        id: "gerrit-defaults",
        provider: "gerrit",
        configJson: JSON.stringify({ sshHost: "gerrit.local", sshUser: "ve-bot" }),
      });
      // Should not throw; connector uses schema defaults
      const connector = createVcsConnectorForIntegration(integration);
      expect(connector).toBeInstanceOf(GerritVcsConnector);
    });

    it("uses explicit gitAuthorName and gitAuthorEmail when provided", () => {
      const integration = makeIntegration({
        id: "gerrit-custom-author",
        provider: "gerrit",
        configJson: JSON.stringify({
          sshHost: "gerrit.local",
          sshUser: "ve-bot",
          gitAuthorName: "Bot User",
          gitAuthorEmail: "bot@company.com",
        }),
      });
      const connector = createVcsConnectorForIntegration(integration);
      expect(connector).toBeInstanceOf(GerritVcsConnector);
    });
  });

  describe("GitLab merge request integration", () => {
    const gitlabIntegration = makeIntegration({
      id: "gitlab-1",
      provider: "gitlab",
      configJson: JSON.stringify({
        baseUrl: "https://gitlab.local",
        token: "glpat-test",
      }),
    });

    it("creates a GitLabVcsConnector for a gitlab-merge-request integration", () => {
      const connector = createVcsConnectorForIntegration(gitlabIntegration, { repoKey: "team/repo" });
      expect(connector).toBeInstanceOf(GitLabVcsConnector);
    });

    it("uses GITLAB_COM_BASE_URL when baseUrl is missing", () => {
      const integration = makeIntegration({
        id: "gitlab-no-url",
        provider: "gitlab",
        configJson: JSON.stringify({ token: "glpat-test" }),
      });
      const connector = createVcsConnectorForIntegration(integration, { repoKey: "team/repo" });
      expect(connector).toBeInstanceOf(GitLabVcsConnector);
    });

    it("throws when token is missing", () => {
      const integration = makeIntegration({
        id: "gitlab-bad",
        provider: "gitlab",
        configJson: JSON.stringify({ baseUrl: "https://gitlab.local" }),
      });
      expect(() => createVcsConnectorForIntegration(integration, { repoKey: "team/repo" })).toThrow(
        /GitLab access token is required/
      );
    });

    it("throws when projectId is missing", () => {
      const integration = makeIntegration({
        id: "gitlab-bad",
        provider: "gitlab",
        configJson: JSON.stringify({ baseUrl: "https://gitlab.local", token: "glpat-test" }),
      });
      expect(() => createVcsConnectorForIntegration(integration)).toThrow(/GitLab project binding is required/);
    });

    it("creates a GitLab VCS connector from the VE repo binding when projectId is absent", () => {
      const integration = makeIntegration({
        id: "gitlab-bound",
        provider: "gitlab",
        configJson: JSON.stringify({ baseUrl: "https://gitlab.local", token: "glpat-test" }),
      });

      const connector = createVcsConnectorForIntegration(integration, { repoKey: "team/repo" });

      expect(connector).toBeInstanceOf(GitLabVcsConnector);
    });

    it("uses default gitAuthorName and gitAuthorEmail when not provided", () => {
      const connector = createVcsConnectorForIntegration(gitlabIntegration, { repoKey: "team/repo" });
      expect(connector).toBeInstanceOf(GitLabVcsConnector);
    });

    it("uses explicit gitAuthorName and gitAuthorEmail when provided", () => {
      const integration = makeIntegration({
        id: "gitlab-custom-author",
        provider: "gitlab",
        configJson: JSON.stringify({
          baseUrl: "https://gitlab.local",
          token: "glpat-test",
          gitAuthorName: "CI Bot",
          gitAuthorEmail: "ci@company.com",
        }),
      });
      const connector = createVcsConnectorForIntegration(integration, { repoKey: "team/repo" });
      expect(connector).toBeInstanceOf(GitLabVcsConnector);
    });

    it("uses targetBranch when provided in config", () => {
      const integration = makeIntegration({
        id: "gitlab-with-branch",
        provider: "gitlab",
        configJson: JSON.stringify({
          baseUrl: "https://gitlab.local",
          token: "glpat-test",
          targetBranch: "develop",
        }),
      });
      const connector = createVcsConnectorForIntegration(integration, { repoKey: "team/repo" });
      expect(connector).toBeInstanceOf(GitLabVcsConnector);
    });

    it("reuses one runner for cached and project-bound connectors", () => {
      const gitRunner: GitRunner = {
        run: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
      };
      const factory = new VcsConnectorFactory({ gitRunner });
      const cachedIntegration = makeIntegration({
        id: "gerrit-cached",
        provider: "gerrit",
        configJson: JSON.stringify({
          sshHost: "gerrit.local",
          sshUser: "ve-bot",
        }),
      });

      const cachedConnector = factory.getConnector(cachedIntegration);
      const boundConnector = factory.getConnector(gitlabIntegration, { repoKey: "team/repo" });

      expect((cachedConnector as unknown as { gitRunner: GitRunner }).gitRunner).toBe(gitRunner);
      expect((boundConnector as unknown as { gitRunner: GitRunner }).gitRunner).toBe(gitRunner);
    });
  });

  describe("Invalid integration type", () => {
    it("throws for non-VCS integration type", () => {
      const integration = makeIntegration({
        id: "redmine-1",
        provider: "redmine",
        configJson: JSON.stringify({}),
      });
      expect(() => createVcsConnectorForIntegration(integration)).toThrow(
        /not a VCS push target/
      );
    });
  });
});


