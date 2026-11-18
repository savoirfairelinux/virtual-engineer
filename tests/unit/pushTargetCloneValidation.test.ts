import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { validatePushTargetCloneUrls } from "../../src/admin/adminProjectsShared.js";
import { registerProjectRoutes } from "../../src/admin/adminProjectsRoutes.js";
import { setEffectivePermissions } from "../../src/admin/authContext.js";
import { Router } from "../../src/admin/router.js";
import type { Integration } from "../../src/interfaces.js";
import { registerBuiltinPlugins } from "../../src/plugins/init.js";

describe("project save clone URL validation", () => {
  it.each([
    ["github", {}, "http://github.com/team/app.git", false],
    ["github", {}, "https://api.github.com/team/app.git", false],
    ["github", {}, "https://github.com:8443/team/app.git", false],
    ["github", {}, "git@github.com:team/app.git", false],
    ["github", {}, "not a URL", false],
    ["github", {}, "https://github.com/team/app.git", true],
    ["github", {}, "https://GITHUB.COM:443/team/app.git", true],
    ["github", {}, "https://placeholder@github.com/team/app.git", false],
    ["github", { mode: "github.com", baseUrl: "https://mirror.example" }, "https://mirror.example/team/app.git", false],
    ["github", { mode: "github-enterprise", baseUrl: "https://github.example:8443" }, "https://github.example:8443/team/app.git", true],
    ["github", { mode: "github-enterprise" }, "https://github.com/team/app.git", false],
    ["gitlab", {}, "https://gitlab.com/team/app.git", true],
    ["gitlab", { gitlabMode: "self-hosted" }, "https://gitlab.com/team/app.git", false],
    ["gitlab", {}, "https://mirror.example/team/app.git", false],
    ["gitlab", { baseUrl: "https://gitlab.example:8443/" }, "https://gitlab.example/team/app.git", false],
    ["gitlab", { baseUrl: "https://gitlab.example:8443/" }, "https://gitlab.example:8443/team/app.git", true],
    ["gitlab", { baseUrl: "http://gitlab.example" }, "https://gitlab.example/team/app.git", false],
    ["gerrit", {}, "git@gerrit.example:team/app.git", true],
  ] as const)("validates %s (%j) clone URL %s (allowed: %s)", async (provider, config, cloneUrl, allowed) => {
    const now = new Date();
    const integration: Integration = {
      id: "vcs", provider, name: "VCS", configJson: JSON.stringify(config),
      enabled: true, createdAt: now, updatedAt: now,
    };
    const getIntegration = vi.fn().mockResolvedValue(integration);
    const result = await validatePushTargetCloneUrls(
      [{ integrationId: "vcs", repoKey: "app", cloneUrl }],
      { getIntegration },
    );
    if (allowed) {
      expect(result).toBeNull();
    } else {
      expect(result).toMatch(/trusted HTTPS origin/);
      expect(result).not.toContain(cloneUrl);
    }
  });

  it.each(["POST", "PUT"])("%s rejects an untrusted target before writing the project", async (method) => {
    registerBuiltinPlugins();
    const router = new Router();
    const createProject = vi.fn().mockResolvedValue({ id: "project" });
    const deleteProject = vi.fn().mockResolvedValue(undefined);
    const updateProjectConfiguration = vi.fn();
    const deps = {
      projectStore: {
        getAgentById: vi.fn().mockResolvedValue({ type: "coding", enabled: true, integrationId: "agent-vcs" }),
        getProjectById: vi.fn().mockResolvedValue({ id: "project", type: "coding" }),
        findProjectByTicketSource: vi.fn().mockResolvedValue(null),
        createProject,
        deleteProject,
        updateProjectConfiguration,
      },
      integrationStore: {
        getIntegration: vi.fn(async (id: string) => ({
          id, enabled: true, provider: id === "agent-vcs" ? "copilot" : "github", configJson: "{}",
        })),
      },
    } as unknown as Parameters<typeof registerProjectRoutes>[1];
    registerProjectRoutes(router, deps);
    const path = method === "POST" ? "/api/admin/projects" : "/api/admin/projects/project";
    const cloneUrl = "https://mirror.example/team/app.git";
    const request = Readable.from([Buffer.from(JSON.stringify({
      ...(method === "POST" ? {
        name: "Synthetic project", type: "coding", agentId: "agent",
        ticketSource: { integrationId: "tickets", ticketProjectKey: "sandbox" },
      } : {}),
      pushTargets: [{
        integrationId: "vcs", repoKey: "app", cloneUrl,
        targetBranch: "main", role: "primary", commitOrder: 1, localPath: ".",
      }],
    }))]) as unknown as IncomingMessage;
    setEffectivePermissions(request, {
      isSuperuser: true, grants: new Map(), resourceOwnerGrants: new Set(),
      projectOwnerGrants: new Set(), registeredUserGrants: new Set(),
    });
    const end = vi.fn();
    const response = { statusCode: 0, setHeader: vi.fn(), end };
    await router.dispatch(request, response as unknown as ServerResponse, path, method);
    expect(response.statusCode).toBe(400);
    expect(end).toHaveBeenCalledWith(expect.stringContaining("trusted HTTPS origin"));
    expect(end).not.toHaveBeenCalledWith(expect.stringContaining(cloneUrl));
    expect(createProject).not.toHaveBeenCalled();
    expect(updateProjectConfiguration).not.toHaveBeenCalled();
  });
});
