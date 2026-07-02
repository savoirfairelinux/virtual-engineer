import { describe, it, expect } from "vitest";
import {
  githubConfigSchema,
  githubDescriptor,
} from "../../src/plugins/descriptors/github.js";
import type { Integration } from "../../src/interfaces.js";

const baseIntegration: Integration = {
  id: "gh-1",
  provider: "github",
  name: "GH",
  configJson: "{}",
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("github descriptors — schema migration + runtime resolution", () => {
  describe("github pull request — schema migration + runtime resolution", () => {
    it("drops the legacy repositorySlug field (project binding is the source)", () => {
      const parsed = githubConfigSchema.parse({
        mode: "github.com",
        authMode: "pat",
        token: "ghp_x",
        repositorySlug: "octocat/hello-world",
      });
      expect("repositorySlug" in parsed).toBe(false);
      expect("owner" in parsed).toBe(false);
    });

    it("accepts config without owner when project binding will provide repoKey", () => {
      const result = githubConfigSchema.safeParse({
        mode: "github.com",
        authMode: "pat",
        token: "ghp_x",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("github issue — schema migration + runtime resolution", () => {
    it("drops the legacy repositorySlug field (project binding is the source)", () => {
      const parsed = githubConfigSchema.parse({
        mode: "github.com",
        authMode: "pat",
        token: "ghp_x",
        repositorySlug: "octocat/hello-world",
      });
      expect("repositorySlug" in parsed).toBe(false);
      expect("owner" in parsed).toBe(false);
    });

    it("accepts config without owner when project binding will provide repoKey", () => {
      const result = githubConfigSchema.safeParse({
        mode: "github.com",
        authMode: "pat",
        token: "ghp_x",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("github pull request createInstance — boot vs per-task", () => {
    const cfg = {
      mode: "github.com",
      authMode: "pat",
      token: "ghp_x",
    };

    it("returns an unbound instance when context is undefined (boot path)", () => {
      const parsed = githubConfigSchema.parse(cfg) as unknown as Record<string, unknown>;
      const conn = githubDescriptor.capabilities.code_review!.createConnector!(parsed, baseIntegration, undefined);
      expect(conn).toBeDefined();
    });

    it("uses context.repoKey when provided (per-task path)", () => {
      const parsed = githubConfigSchema.parse(cfg) as unknown as Record<string, unknown>;
      const conn = githubDescriptor.capabilities.code_review!.createConnector!(parsed, baseIntegration, {
        repoKey: "acme/hello-world",
      });
      expect(conn).toBeDefined();
    });

    it("throws when context is provided but repoKey is empty (strict per-task)", () => {
      const parsed = githubConfigSchema.parse(cfg) as unknown as Record<string, unknown>;
      expect(() =>
        githubDescriptor.capabilities.code_review!.createConnector!(parsed, baseIntegration, { repoKey: "" }),
      ).toThrow(/no repository bound/i);
    });
  });

  describe("github pull request createVcsConnector — repo resolution", () => {
    const cfg = {
      mode: "github.com",
      authMode: "pat",
      token: "ghp_x",
    };

    it("uses context.repoKey when it contains owner/repo", () => {
      const conn = githubDescriptor.capabilities.source_control!.createVcsConnector(
        githubConfigSchema.parse(cfg) as unknown as Record<string, unknown>,
        baseIntegration,
        { repoKey: "acme/hello-world" },
      );
      expect(conn).toBeDefined();
    });

    it("rejects bare repoKey without owner prefix (no owner fallback)", () => {
      expect(() =>
        githubDescriptor.capabilities.source_control!.createVcsConnector(
          githubConfigSchema.parse(cfg) as unknown as Record<string, unknown>,
          baseIntegration,
          { repoKey: "hello-world" },
        ),
      ).toThrow(/expected 'owner\/repo'/i);
    });

    it("throws when no context.repoKey is provided", () => {
      const parsed = githubConfigSchema.parse(cfg) as unknown as Record<string, unknown>;
      expect(() =>
        githubDescriptor.capabilities.source_control!.createVcsConnector(parsed, baseIntegration, undefined),
      ).toThrow(/no repository bound/i);
    });
  });

  describe("github issue createInstance — repo resolution", () => {
    const cfg = {
      mode: "github.com",
      authMode: "pat",
      token: "ghp_x",
    };

    it("uses context.ticketProjectKey", () => {
      const conn = githubDescriptor.capabilities.issue_tracking!.createConnector(
        githubConfigSchema.parse(cfg) as unknown as Record<string, unknown>,
        { ...baseIntegration, provider: "github" },
        { ticketProjectKey: "acme/hello-world" },
      );
      expect(conn).toBeDefined();
    });

    it("rejects bare ticketProjectKey without owner prefix", () => {
      expect(() =>
        githubDescriptor.capabilities.issue_tracking!.createConnector(
          githubConfigSchema.parse({
            mode: "github.com",
            authMode: "pat",
            token: "ghp_x",
          }) as unknown as Record<string, unknown>,
          { ...baseIntegration, provider: "github" },
          { ticketProjectKey: "hello-world" },
        ),
      ).toThrow(/expected 'owner\/repo'/i);
    });

    it("returns an unbound instance when no context (boot-time owner-level)", () => {
      const parsed = githubConfigSchema.parse(cfg) as unknown as Record<string, unknown>;
      const conn = githubDescriptor.capabilities.issue_tracking!.createConnector(
        parsed,
        { ...baseIntegration, provider: "github" },
        undefined,
      );
      expect(conn).toBeDefined();
    });
  });
});
