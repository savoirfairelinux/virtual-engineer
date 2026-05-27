import { z } from "zod";
import type { Integration, IntegrationBindingContext } from "../../interfaces.js";
import type { PluginDescriptor } from "../registry.js";
import { GitHubPullRequestReviewConnector } from "../../connectors/githubPullRequestReviewConnector.js";
import { GitHubReviewProvider } from "../../connectors/githubReviewProvider.js";
import { GitHubVcsConnector } from "../../vcs/githubVcsConnector.js";
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

export const githubPullRequestConfigSchema = z
  .object({
    mode: githubModeSchema,
    baseUrl: githubBaseUrlSchema,
    authMode: githubAuthModeSchema,
    oauthClientId: z.string().optional(),
    token: githubTokenSchema,
    owner: z.string().min(1).optional(),
    repositorySlug: z.string().optional(),
    targetBranch: z.string().min(1).optional(),
    gitAuthorName: z.string().min(1).default("Virtual Engineer"),
    gitAuthorEmail: z.string().min(1).default("ve@virtual-engineer.local"),
    virtualEngineerUserLogin: z.string().optional(),
    virtualEngineerUserId: z.number().optional(),
    webhookSecret: z.string().min(1).optional(),
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

export type GitHubPullRequestPluginConfig = z.infer<typeof githubPullRequestConfigSchema>;

function deriveHost(mode: GitHubMode, baseUrl: string | undefined): string {
  if (mode === "github.com") return "github.com";
  if (!baseUrl) throw new Error("GitHub Enterprise mode requires a baseUrl");
  try {
    return new URL(baseUrl).host;
  } catch {
    throw new Error(`Invalid GitHub Enterprise baseUrl: ${baseUrl}`);
  }
}

function resolveRepo(
  parsedOwner: string,
  context: IntegrationBindingContext | undefined,
  legacySlug: string | undefined,
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
  throw new Error(
    `GitHub integration: no repository bound. Bind a project repo (repoKey) or set a legacy repositorySlug. owner='${parsedOwner}'`,
  );
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
      key: "targetBranch",
      label: "Target branch",
      type: "text",
      required: false,
      placeholder: "main",
    },
    {
      key: "webhookSecret",
      label: "Webhook secret",
      type: "password",
      required: false,
      placeholder: "Auto-generated when empty",
    },
  ],
  createInstance: (config: unknown, _integration: Integration, context?: IntegrationBindingContext) => {
    const parsed = githubPullRequestConfigSchema.parse(config);
    const { owner, repo } = resolveRepo(parsed.owner as string, context, parsed.repositorySlug);
    const urls = resolveGitHubUrls(parsed.mode as GitHubMode, parsed.baseUrl);
    return new GitHubPullRequestReviewConnector({
      apiBaseUrl: urls.apiBaseUrl,
      owner,
      repo,
      token: getGitHubAccessToken(parsed as Record<string, unknown>),
      ...(parsed.virtualEngineerUserLogin !== undefined
        ? { virtualEngineerUserLogin: parsed.virtualEngineerUserLogin }
        : {}),
    });
  },
  discoverResources: async (config) => {
    const parsed = githubPullRequestConfigSchema.parse(config);
    const urls = resolveGitHubUrls(parsed.mode as GitHubMode, parsed.baseUrl);
    const token = getGitHubAccessToken(parsed as Record<string, unknown>);
    const repos = await listGitHubRepositoriesForOwner(token, urls.apiBaseUrl, parsed.owner as string);
    repos.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return {
      repositories: repos.map((r) => ({
        key: r.fullName,
        name: r.name,
        webUrl: r.htmlUrl,
        cloneUrlHttp: r.cloneUrl,
        cloneUrlSsh: r.sshUrl,
        defaultBranch: r.defaultBranch,
      })),
      discoveredAt: new Date().toISOString(),
    };
  },
  createVcsConnector: (cfg: Record<string, unknown>, _integration: Integration, context?: IntegrationBindingContext) => {
    const parsed = githubPullRequestConfigSchema.parse(cfg);
    const { owner, repo } = resolveRepo(parsed.owner as string, context, parsed.repositorySlug);
    const urls = resolveGitHubUrls(parsed.mode as GitHubMode, parsed.baseUrl);
    const host = deriveHost(parsed.mode as GitHubMode, parsed.baseUrl);
    return new GitHubVcsConnector({
      apiBaseUrl: urls.apiBaseUrl,
      host,
      owner,
      repo,
      token: getGitHubAccessToken(parsed as Record<string, unknown>),
      gitAuthorName: parsed.gitAuthorName,
      gitAuthorEmail: parsed.gitAuthorEmail,
      ...(parsed.targetBranch !== undefined ? { targetBranch: parsed.targetBranch } : {}),
    });
  },
  getSummaryDetails(config) {
    const owner = typeof config["owner"] === "string" ? config["owner"] : "?";
    const mode = typeof config["mode"] === "string" ? config["mode"] : "github.com";
    return [mode, owner];
  },
  reviewSystemPromptId: "system_github_review",
  reviewUserPromptId: "user_github_review",
  createReviewer: (cfg, _integration, workspaceRunner) => {
    const parsed = githubPullRequestConfigSchema.parse(cfg);
    const owner = parsed.owner as string;
    const urls = resolveGitHubUrls(parsed.mode as GitHubMode, parsed.baseUrl);
    const token = getGitHubAccessToken(parsed as Record<string, unknown>);
    const host = deriveHost(parsed.mode as GitHubMode, parsed.baseUrl);

    const legacyRepo = parsed.repositorySlug
      ? parsed.repositorySlug.slice(parsed.repositorySlug.indexOf("/") + 1)
      : undefined;

    return {
      systemPromptId: "system_github_review",
      userPromptId: "user_github_review",
      provider: new GitHubReviewProvider({
        apiBaseUrl: urls.apiBaseUrl,
        owner,
        token,
        ...(legacyRepo !== undefined ? { repo: legacyRepo } : {}),
      }),
      buildCloneTarget: (details) => {
        const slash = details.project.indexOf("/");
        const repo = slash > 0 ? details.project.slice(slash + 1) : details.project;
        const cloneUrl = `https://x-access-token:${token}@${host}/${owner}/${repo}.git`;
        return { cloneUrl, sshKeyPath: null, sshKnownHostsPath: null };
      },
      applyPatchset: async (handle, details) => {
        if (workspaceRunner.execGitInVolume === undefined) {
          throw new Error("workspaceRunner does not support execGitInVolume — cannot fetch GitHub PR ref");
        }
        const prRef = `pull/${details.changeNumber}/head`;
        const localBranch = `ve-review-pr-${details.changeNumber}`;
        await workspaceRunner.execGitInVolume(handle, ["fetch", "--depth=1", "origin", `${prRef}:${localBranch}`]);
        await workspaceRunner.execGitInVolume(handle, ["checkout", localBranch]);
      },
    };
  },
  oauth: createGitHubOAuthConfig("github-pull-request", "GitHub Pull Request Authentication"),
  createOAuthHandler: (config) => createGitHubDeviceOAuthHandler(config),
};
