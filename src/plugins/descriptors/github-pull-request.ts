import { z } from "zod";
import type { Integration, IntegrationBindingContext } from "../../interfaces.js";
import type { PluginDescriptor } from "../registry.js";
import { GitHubPullRequestReviewConnector } from "../../connectors/githubPullRequestReviewConnector.js";
import { GitHubVcsConnector } from "../../vcs/githubVcsConnector.js";
import { resolveGitHubUrls, type GitHubMode } from "../../utils/githubAuth.js";
import {
  githubModeSchema,
  githubAuthModeSchema,
  githubBaseUrlSchema,
  githubTokenSchema,
  createGitHubOAuthConfig,
  createGitHubDeviceOAuthHandler,
} from "./githubOAuth.js";

export const githubPullRequestConfigSchema = z.object({
  mode: githubModeSchema,
  baseUrl: githubBaseUrlSchema,
  authMode: githubAuthModeSchema,
  oauthClientId: z.string().optional(),
  token: githubTokenSchema,
  repositorySlug: z.string().min(1).regex(/^[^/]+\/[^/]+$/),
  targetBranch: z.string().min(1).optional(),
  gitAuthorName: z.string().min(1).default("Virtual Engineer"),
  gitAuthorEmail: z.string().min(1).default("ve@virtual-engineer.local"),
  virtualEngineerUserLogin: z.string().optional(),
  virtualEngineerUserId: z.number().optional(),
});

export type GitHubPullRequestPluginConfig = z.infer<typeof githubPullRequestConfigSchema>;

function parseRepositorySlug(slug: string): { owner: string; repo: string } {
  const parts = slug.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) {
    throw new Error(`Invalid GitHub repositorySlug "${slug}" — expected "owner/repo"`);
  }
  return { owner, repo };
}

function deriveHost(mode: GitHubMode, baseUrl: string | undefined): string {
  if (mode === "github.com") return "github.com";
  if (!baseUrl) throw new Error("GitHub Enterprise mode requires a baseUrl");
  try {
    return new URL(baseUrl).host;
  } catch {
    throw new Error(`Invalid GitHub Enterprise baseUrl: ${baseUrl}`);
  }
}

export const githubPullRequestDescriptor: PluginDescriptor = {
  type: "github-pull-request",
  name: "GitHub Pull Requests",
  category: "review",
  configSchema: githubPullRequestConfigSchema,
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
      required: true,
      placeholder: "ghp_...",
    },
    {
      key: "repositorySlug",
      label: "Repository (owner/repo)",
      type: "text",
      required: true,
      placeholder: "octocat/hello-world",
    },
    {
      key: "targetBranch",
      label: "Target branch",
      type: "text",
      required: false,
      placeholder: "main",
    },
  ],
  createInstance: (config: unknown, _integration: Integration, _context?: IntegrationBindingContext) => {
    const parsed = githubPullRequestConfigSchema.parse(config);
    const { owner, repo } = parseRepositorySlug(parsed.repositorySlug);
    const urls = resolveGitHubUrls(parsed.mode as GitHubMode, parsed.baseUrl);
    return new GitHubPullRequestReviewConnector({
      apiBaseUrl: urls.apiBaseUrl,
      owner,
      repo,
      token: parsed.token,
      ...(parsed.virtualEngineerUserLogin !== undefined
        ? { virtualEngineerUserLogin: parsed.virtualEngineerUserLogin }
        : {}),
    });
  },
  createVcsConnector: (cfg: Record<string, unknown>, _integration: Integration, _context?: IntegrationBindingContext) => {
    const parsed = githubPullRequestConfigSchema.parse(cfg);
    const { owner, repo } = parseRepositorySlug(parsed.repositorySlug);
    const urls = resolveGitHubUrls(parsed.mode as GitHubMode, parsed.baseUrl);
    const host = deriveHost(parsed.mode as GitHubMode, parsed.baseUrl);
    return new GitHubVcsConnector({
      apiBaseUrl: urls.apiBaseUrl,
      host,
      owner,
      repo,
      token: parsed.token,
      gitAuthorName: parsed.gitAuthorName,
      gitAuthorEmail: parsed.gitAuthorEmail,
      ...(parsed.targetBranch !== undefined ? { targetBranch: parsed.targetBranch } : {}),
    });
  },
  getSummaryDetails(config) {
    const slug = typeof config["repositorySlug"] === "string" ? config["repositorySlug"] : "?";
    const mode = typeof config["mode"] === "string" ? config["mode"] : "github.com";
    return [mode, slug];
  },
  oauth: createGitHubOAuthConfig("github-pull-request", "GitHub Pull Request Authentication"),
  createOAuthHandler: (config) => createGitHubDeviceOAuthHandler(config),
};
