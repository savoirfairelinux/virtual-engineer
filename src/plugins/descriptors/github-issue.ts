import { z } from "zod";
import type { Integration, IntegrationBindingContext } from "../../interfaces.js";
import type { PluginDescriptor } from "../registry.js";
import { GitHubIssueConnector } from "../../connectors/githubIssueConnector.js";
import {
  resolveGitHubUrls,
  listGitHubRepositoriesForUser,
  type GitHubMode,
} from "../../utils/githubAuth.js";
import {
  githubModeSchema,
  githubAuthModeSchema,
  githubBaseUrlSchema,
  githubTokenSchema,
  createGitHubOAuthConfig,
  createGitHubDeviceOAuthHandler,
  getGitHubAccessToken,
} from "./githubOAuth.js";

export const githubIssueConfigSchema = z
  .object({
    mode: githubModeSchema,
    baseUrl: githubBaseUrlSchema,
    authMode: githubAuthModeSchema,
    oauthClientId: z.string().optional(),
    token: githubTokenSchema,
    repositorySlug: z.string().optional(),
    virtualEngineerUserLogin: z.string().optional(),
    virtualEngineerUserId: z.number().optional(),
  });

export type GitHubIssuePluginConfig = z.infer<typeof githubIssueConfigSchema>;

const UNBOUND_GITHUB_REPO = "__ve_unbound_repo__";
const UNBOUND_GITHUB_OWNER = "__ve_unbound_owner__";

function resolveRepo(
  context: IntegrationBindingContext | undefined,
  legacySlug: string | undefined,
  options?: { allowUnboundFallback?: boolean },
): { owner: string; repo: string } {
  const key = context?.ticketProjectKey?.trim();
  if (key) {
    const slash = key.indexOf("/");
    if (slash > 0) {
      const o = key.slice(0, slash);
      const r = key.slice(slash + 1);
      if (o && r) return { owner: o, repo: r };
    }
    throw new Error(
      `GitHub issue integration: invalid ticketProjectKey '${key}'. Expected 'owner/repo'.`,
    );
  }
  if (legacySlug) {
    const parts = legacySlug.split("/");
    if (parts[0] && parts[1]) return { owner: parts[0], repo: parts[1] };
  }
  if (options?.allowUnboundFallback === true) {
    return { owner: UNBOUND_GITHUB_OWNER, repo: UNBOUND_GITHUB_REPO };
  }
  throw new Error(
    "GitHub issue integration: no repository bound. Set the project ticket source to an 'owner/repo' key.",
  );
}

export const githubIssueDescriptor: PluginDescriptor = {
  type: "github-issue",
  name: "GitHub Issues",
  category: "ticketing",
  configSchema: githubIssueConfigSchema,
  requiredFields: [
    {
      key: "mode",
      label: "GitHub Mode",
      type: "select",
      required: true,
      options: [
        { value: "github.com", label: "GitHub.com" },
        { value: "github-enterprise", label: "GitHub Enterprise Server" },
      ],
    },
    {
      key: "baseUrl",
      label: "Base URL",
      type: "url",
      required: false,
      placeholder: "https://github.example.com",
      dependsOn: { field: "mode", value: "github-enterprise" },
    },
    {
      key: "authMode",
      label: "Auth Mode",
      type: "select",
      required: true,
      options: [
        { value: "pat", label: "Personal Access Token" },
        { value: "oauth", label: "OAuth Device Flow" },
      ],
    },
    {
      key: "oauthClientId",
      label: "OAuth Client ID",
      type: "text",
      required: false,
      placeholder: "Iv1.abc123",
      dependsOn: { allOf: [{ field: "authMode", value: "oauth" }, { field: "mode", value: "github-enterprise" }] },
    },
    {
      key: "token",
      label: "Personal Access Token",
      type: "password",
      required: false,
      placeholder: "ghp_...",
      dependsOn: { field: "authMode", value: "pat" },
    },
  ],
  discoverResources: async (config) => {
    const parsed = githubIssueConfigSchema.parse(config);
    const urls = resolveGitHubUrls(parsed.mode as GitHubMode, parsed.baseUrl);
    const token = getGitHubAccessToken(parsed as Record<string, unknown>);
    if (!token) {
      return { ticketProjects: [], discoveredAt: new Date().toISOString() };
    }
    const repos = await listGitHubRepositoriesForUser(token, urls.apiBaseUrl);
    repos.sort((a, b) => a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" }));
    return {
      ticketProjects: repos.map((r) => ({ key: r.fullName, name: r.fullName, url: r.htmlUrl })),
      discoveredAt: new Date().toISOString(),
    };
  },
  createInstance: (config: unknown, _integration: Integration, context?: IntegrationBindingContext) => {
    const parsed = githubIssueConfigSchema.parse(config);
    const { owner, repo } = resolveRepo(context, parsed.repositorySlug, {
      allowUnboundFallback: context === undefined,
    });
    const urls = resolveGitHubUrls(parsed.mode as GitHubMode, parsed.baseUrl);
    return new GitHubIssueConnector({
      apiBaseUrl: urls.apiBaseUrl,
      owner,
      repo,
      token: getGitHubAccessToken(parsed as Record<string, unknown>),
      ...(parsed.virtualEngineerUserLogin !== undefined
        ? { virtualEngineerUserLogin: parsed.virtualEngineerUserLogin }
        : {}),
    });
  },
  getSummaryDetails(config) {
    const mode = typeof config["mode"] === "string" ? config["mode"] : "github.com";
    return [mode, "project-bound"];
  },
  oauth: createGitHubOAuthConfig("github-issue", "GitHub Issues Authentication"),
  createOAuthHandler: (config) => createGitHubDeviceOAuthHandler(config),
};
