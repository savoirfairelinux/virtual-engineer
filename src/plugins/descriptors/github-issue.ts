import { z } from "zod";
import type { Integration, IntegrationBindingContext } from "../../interfaces.js";
import type { PluginDescriptor } from "../registry.js";
import { GitHubIssueConnector } from "../../connectors/githubIssueConnector.js";
import {
  resolveGitHubUrls,
  listGitHubRepositoriesForOwner,
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
    owner: z.string().min(1).optional(),
    repositorySlug: z.string().optional(),
    ticketLabel: z.string().min(1),
    virtualEngineerUserLogin: z.string().optional(),
    virtualEngineerUserId: z.number().optional(),
  })
  .transform((cfg) => {
    if (!cfg.owner && cfg.repositorySlug) {
      const before = cfg.repositorySlug.split("/")[0];
      if (before) return { ...cfg, owner: before };
    }
    return cfg;
  })
  .refine((cfg) => Boolean(cfg.owner), {
    message: "GitHub integration requires an `owner` (user or organization login)",
    path: ["owner"],
  });

export type GitHubIssuePluginConfig = z.infer<typeof githubIssueConfigSchema>;

const UNBOUND_GITHUB_REPO = "__ve_unbound_repo__";

function resolveRepo(
  parsedOwner: string,
  context: IntegrationBindingContext | undefined,
  legacySlug: string | undefined,
  options?: { allowUnboundFallback?: boolean },
): { owner: string; repo: string } {
  const key = context?.repoKey?.trim();
  if (key) {
    const slash = key.indexOf("/");
    if (slash > 0) {
      const o = key.slice(0, slash);
      const r = key.slice(slash + 1);
      if (o && r) return { owner: o, repo: r };
    }
    return { owner: parsedOwner, repo: key };
  }
  if (legacySlug) {
    const parts = legacySlug.split("/");
    if (parts[0] && parts[1]) return { owner: parts[0], repo: parts[1] };
  }
  if (options?.allowUnboundFallback === true) {
    return { owner: parsedOwner, repo: UNBOUND_GITHUB_REPO };
  }
  throw new Error(
    `GitHub issue integration: no repository bound. Bind a project ticketSourceProjectKey (repoKey) or set a legacy repositorySlug. owner='${parsedOwner}'`,
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
      dependsOn: { field: "authMode", value: "oauth" },
    },
    {
      key: "token",
      label: "Personal Access Token",
      type: "password",
      required: false,
      placeholder: "ghp_...",
      dependsOn: { field: "authMode", value: "pat" },
    },
    {
      key: "owner",
      label: "Owner (user or organization)",
      type: "text",
      required: true,
      placeholder: "octocat",
    },
    {
      key: "ticketLabel",
      label: "Ticket Label",
      type: "text",
      required: true,
      placeholder: "virtual-engineer",
    },
  ],
  discoverResources: async (config) => {
    const parsed = githubIssueConfigSchema.parse(config);
    const urls = resolveGitHubUrls(parsed.mode as GitHubMode, parsed.baseUrl);
    const token = getGitHubAccessToken(parsed as Record<string, unknown>);
    const repos = await listGitHubRepositoriesForOwner(token, urls.apiBaseUrl, parsed.owner as string);
    repos.sort((a, b) => a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" }));
    return {
      ticketProjects: repos.map((r) => ({ key: r.fullName, name: r.fullName, url: r.htmlUrl })),
      discoveredAt: new Date().toISOString(),
    };
  },
  createInstance: (config: unknown, _integration: Integration, context?: IntegrationBindingContext) => {
    const parsed = githubIssueConfigSchema.parse(config);
    const { owner, repo } = resolveRepo(parsed.owner as string, context, parsed.repositorySlug, {
      allowUnboundFallback: context === undefined,
    });
    const urls = resolveGitHubUrls(parsed.mode as GitHubMode, parsed.baseUrl);
    return new GitHubIssueConnector({
      apiBaseUrl: urls.apiBaseUrl,
      owner,
      repo,
      token: getGitHubAccessToken(parsed as Record<string, unknown>),
      ticketLabel: parsed.ticketLabel,
      ...(parsed.virtualEngineerUserLogin !== undefined
        ? { virtualEngineerUserLogin: parsed.virtualEngineerUserLogin }
        : {}),
    });
  },
  getSummaryDetails(config) {
    const owner = typeof config["owner"] === "string" ? config["owner"] : "?";
    const mode = typeof config["mode"] === "string" ? config["mode"] : "github.com";
    return [mode, owner];
  },
  oauth: createGitHubOAuthConfig("github-issue", "GitHub Issues Authentication"),
  createOAuthHandler: (config) => createGitHubDeviceOAuthHandler(config),
};
