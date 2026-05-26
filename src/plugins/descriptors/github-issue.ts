import { z } from "zod";
import type { Integration, IntegrationBindingContext } from "../../interfaces.js";
import type { PluginDescriptor } from "../registry.js";
import { GitHubIssueConnector } from "../../connectors/githubIssueConnector.js";
import { resolveGitHubUrls, type GitHubMode } from "../../utils/githubAuth.js";
import {
  githubModeSchema,
  githubAuthModeSchema,
  githubBaseUrlSchema,
  githubTokenSchema,
  createGitHubOAuthConfig,
  createGitHubDeviceOAuthHandler,
} from "./githubOAuth.js";

export const githubIssueConfigSchema = z.object({
  mode: githubModeSchema,
  baseUrl: githubBaseUrlSchema,
  authMode: githubAuthModeSchema,
  oauthClientId: z.string().optional(),
  token: githubTokenSchema,
  repositorySlug: z.string().min(1).regex(/^[^/]+\/[^/]+$/),
  ticketLabel: z.string().min(1),
  virtualEngineerUserLogin: z.string().optional(),
  virtualEngineerUserId: z.number().optional(),
});

export type GitHubIssuePluginConfig = z.infer<typeof githubIssueConfigSchema>;

function parseRepositorySlug(slug: string): { owner: string; repo: string } {
  const parts = slug.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) {
    throw new Error(`Invalid GitHub repositorySlug "${slug}" — expected "owner/repo"`);
  }
  return { owner, repo };
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
      key: "ticketLabel",
      label: "Ticket Label",
      type: "text",
      required: true,
      placeholder: "virtual-engineer",
    },
  ],
  createInstance: (config: unknown, _integration: Integration, _context?: IntegrationBindingContext) => {
    const parsed = githubIssueConfigSchema.parse(config);
    const { owner, repo } = parseRepositorySlug(parsed.repositorySlug);
    const urls = resolveGitHubUrls(parsed.mode as GitHubMode, parsed.baseUrl);
    return new GitHubIssueConnector({
      apiBaseUrl: urls.apiBaseUrl,
      owner,
      repo,
      token: parsed.token,
      ticketLabel: parsed.ticketLabel,
      ...(parsed.virtualEngineerUserLogin !== undefined
        ? { virtualEngineerUserLogin: parsed.virtualEngineerUserLogin }
        : {}),
    });
  },
  getSummaryDetails(config) {
    const slug = typeof config["repositorySlug"] === "string" ? config["repositorySlug"] : "?";
    const mode = typeof config["mode"] === "string" ? config["mode"] : "github.com";
    return [mode, slug];
  },
  oauth: createGitHubOAuthConfig("github-issue", "GitHub Issues Authentication"),
  createOAuthHandler: (config) => createGitHubDeviceOAuthHandler(config),
};
