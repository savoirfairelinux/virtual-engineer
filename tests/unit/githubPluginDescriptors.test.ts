import { describe, it, expect } from "vitest";
import {
  githubPullRequestConfigSchema,
  githubPullRequestDescriptor,
} from "../../src/plugins/descriptors/github-pull-request.js";
import {
  githubIssueConfigSchema,
  githubIssueDescriptor,
} from "../../src/plugins/descriptors/github-issue.js";
import type { Integration } from "../../src/interfaces.js";

const baseIntegration: Integration = {
  id: "gh-1",
  type: "github-pull-request",
  name: "GH",
  configJson: "{}",
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("github descriptors — schema migration + runtime resolution", () => {
  describe("github-pull-request schema", () => {
    it("accepts a config with legacy repositorySlug (owner field removed)", () => {
      const parsed = githubPullRequestConfigSchema.parse({
        mode: "github.com",
        authMode: "pat",
        token: "ghp_x",
        repositorySlug: "octocat/hello-world",
      });
      expect(parsed.repositorySlug).toBe("octocat/hello-world");
      expect("owner" in parsed).toBe(false);
    });

    it("accepts config without owner when project binding will provide repoKey", () => {
      const result = githubPullRequestConfigSchema.safeParse({
        mode: "github.com",
        authMode: "pat",
        token: "ghp_x",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("github-issue schema", () => {
    it("accepts a config with legacy repositorySlug (owner field removed)", () => {
      const parsed = githubIssueConfigSchema.parse({
        mode: "github.com",
        authMode: "pat",
        token: "ghp_x",
        repositorySlug: "octocat/hello-world",
      });
      expect(parsed.repositorySlug).toBe("octocat/hello-world");
      expect("owner" in parsed).toBe(false);
    });

    it("accepts config without owner when project binding will provide repoKey", () => {
      const result = githubIssueConfigSchema.safeParse({
        mode: "github.com",
        authMode: "pat",
        token: "ghp_x",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("github-pull-request createInstance — boot vs per-task", () => {
    const cfg = {
      mode: "github.com",
      authMode: "pat",
      token: "ghp_x",
    };

    it("returns an unbound instance when context is undefined (boot path)", () => {
      const parsed = githubPullRequestConfigSchema.parse(cfg) as unknown as Record<string, unknown>;
      const conn = githubPullRequestDescriptor.createInstance!(parsed, baseIntegration, undefined);
      expect(conn).toBeDefined();
    });

    it("uses context.repoKey when provided (per-task path)", () => {
      const parsed = githubPullRequestConfigSchema.parse(cfg) as unknown as Record<string, unknown>;
      const conn = githubPullRequestDescriptor.createInstance!(parsed, baseIntegration, {
        repoKey: "acme/hello-world",
      });
      expect(conn).toBeDefined();
    });

    it("throws when context is provided but repoKey is empty (strict per-task)", () => {
      const parsed = githubPullRequestConfigSchema.parse(cfg) as unknown as Record<string, unknown>;
      expect(() =>
        githubPullRequestDescriptor.createInstance!(parsed, baseIntegration, { repoKey: "" }),
      ).toThrow(/no repository bound/i);
    });
  });

  describe("github-pull-request createVcsConnector — repo resolution", () => {
    const cfg = {
      mode: "github.com",
      authMode: "pat",
      token: "ghp_x",
    };

    it("uses context.repoKey when it contains owner/repo", () => {
      const conn = githubPullRequestDescriptor.createVcsConnector!(
        githubPullRequestConfigSchema.parse(cfg) as unknown as Record<string, unknown>,
        baseIntegration,
        { repoKey: "acme/hello-world" },
      );
      expect(conn).toBeDefined();
    });

    it("rejects bare repoKey without owner prefix (no owner fallback)", () => {
      expect(() =>
        githubPullRequestDescriptor.createVcsConnector!(
          githubPullRequestConfigSchema.parse(cfg) as unknown as Record<string, unknown>,
          baseIntegration,
          { repoKey: "hello-world" },
        ),
      ).toThrow(/expected 'owner\/repo'/i);
    });

    it("falls back to legacy repositorySlug when no context is provided", () => {
      const cfgWithLegacy = githubPullRequestConfigSchema.parse({
        ...cfg,
        repositorySlug: "acme/legacy-repo",
      }) as unknown as Record<string, unknown>;
      const conn = githubPullRequestDescriptor.createVcsConnector!(
        cfgWithLegacy,
        baseIntegration,
        undefined,
      );
      expect(conn).toBeDefined();
    });

    it("throws when no context.repoKey and no legacy repositorySlug", () => {
      const parsed = githubPullRequestConfigSchema.parse(cfg) as unknown as Record<string, unknown>;
      expect(() =>
        githubPullRequestDescriptor.createVcsConnector!(parsed, baseIntegration, undefined),
      ).toThrow(/no repository bound/i);
    });
  });

  describe("github-issue createInstance — repo resolution", () => {
    const cfg = {
      mode: "github.com",
      authMode: "pat",
      token: "ghp_x",
    };

    it("uses context.ticketProjectKey", () => {
      const conn = githubIssueDescriptor.createInstance!(
        githubIssueConfigSchema.parse(cfg) as unknown as Record<string, unknown>,
        { ...baseIntegration, type: "github-issue" },
        { ticketProjectKey: "acme/hello-world" },
      );
      expect(conn).toBeDefined();
    });

    it("rejects bare ticketProjectKey without owner prefix", () => {
      expect(() =>
        githubIssueDescriptor.createInstance!(
          githubIssueConfigSchema.parse({
            mode: "github.com",
            authMode: "pat",
            token: "ghp_x",
          }) as unknown as Record<string, unknown>,
          { ...baseIntegration, type: "github-issue" },
          { ticketProjectKey: "hello-world" },
        ),
      ).toThrow(/expected 'owner\/repo'/i);
    });

    it("returns an unbound instance when no context (boot-time owner-level)", () => {
      const parsed = githubIssueConfigSchema.parse(cfg) as unknown as Record<string, unknown>;
      const conn = githubIssueDescriptor.createInstance!(
        parsed,
        { ...baseIntegration, type: "github-issue" },
        undefined,
      );
      expect(conn).toBeDefined();
    });

    it("falls back to legacy repositorySlug when no context", () => {
      const cfgWithLegacy = githubIssueConfigSchema.parse({
        ...cfg,
        repositorySlug: "acme/legacy",
      }) as unknown as Record<string, unknown>;
      const conn = githubIssueDescriptor.createInstance!(
        cfgWithLegacy,
        { ...baseIntegration, type: "github-issue" },
        undefined,
      );
      expect(conn).toBeDefined();
    });
  });
});
