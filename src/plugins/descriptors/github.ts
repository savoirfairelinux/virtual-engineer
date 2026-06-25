import { z } from "zod";
import type { Integration, IntegrationBindingContext } from "../../interfaces.js";
import type { ProviderDescriptor } from "../registry.js";
import { GitHubIssueConnector } from "../../connectors/githubIssueConnector.js";
import { GitHubPullRequestReviewConnector } from "../../connectors/githubPullRequestReviewConnector.js";
import { GitHubReviewProvider } from "../../connectors/githubReviewProvider.js";
import { GitHubVcsConnector } from "../../vcs/githubVcsConnector.js";
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

/**
 * Unified GitHub provider configuration. The single GitHub provider can fulfil
 * `issue_tracking` (Issues), `code_review` (Pull Requests), and
 * `source_control` (push) capabilities; per-project repository selection comes
 * from the project binding `ticketProjectKey` / `repoKey`.
 */
export const githubConfigSchema = z.object({
  mode: githubModeSchema,
  baseUrl: githubBaseUrlSchema,
  authMode: githubAuthModeSchema,
  oauthClientId: z.string().optional(),
  token: githubTokenSchema,
  repositorySlug: z.string().optional(),
  targetBranch: z.string().min(1).optional(),
  gitAuthorName: z.string().min(1).default("Virtual Engineer"),
  gitAuthorEmail: z.string().min(1).default("ve@virtual-engineer.local"),
  virtualEngineerUserLogin: z.string().optional(),
  virtualEngineerUserId: z.number().optional(),
  webhookSecret: z.string().min(1).optional(),
});

export type GitHubPluginConfig = z.infer<typeof githubConfigSchema>;

const UNBOUND_GITHUB_REPO = "__ve_unbound_repo__";
const UNBOUND_GITHUB_OWNER = "__ve_unbound_owner__";

function deriveHost(mode: GitHubMode, baseUrl: string | undefined): string {
  if (mode === "github.com") return "github.com";
  if (!baseUrl) throw new Error("GitHub Enterprise mode requires a baseUrl");
  try {
    return new URL(baseUrl).host;
  } catch {
    throw new Error(`Invalid GitHub Enterprise baseUrl: ${baseUrl}`);
  }
}

function splitSlug(key: string, label: string): { owner: string; repo: string } {
  const slash = key.indexOf("/");
  if (slash > 0) {
    const owner = key.slice(0, slash);
    const repo = key.slice(slash + 1);
    if (owner && repo) return { owner, repo };
  }
  throw new Error(`GitHub integration: invalid ${label} '${key}'. Expected 'owner/repo'.`);
}

/** Resolve the bound repository from an explicit key, falling back to the legacy slug. */
function resolveRepo(
  boundKey: string | undefined,
  legacySlug: string | undefined,
  label: string,
  options?: { allowUnboundFallback?: boolean },
): { owner: string; repo: string } {
  const key = boundKey?.trim();
  if (key) return splitSlug(key, label);
  if (legacySlug) {
    const parts = legacySlug.split("/");
    if (parts[0] && parts[1]) return { owner: parts[0], repo: parts[1] };
  }
  if (options?.allowUnboundFallback === true) {
    return { owner: UNBOUND_GITHUB_OWNER, repo: UNBOUND_GITHUB_REPO };
  }
  throw new Error(
    "GitHub integration: no repository bound. Bind a project (owner/repo) for this capability.",
  );
}

export const githubDescriptor: ProviderDescriptor = {
  provider: "github",
  name: "GitHub",
  icon: { slug: "github", hex: "181717" },
  configSchema: githubConfigSchema,
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
      dependsOn: { field: "authMode", value: "pat" },
    },
    {
      key: "webhookSecret",
      label: "Webhook secret",
      type: "password",
      required: false,
      placeholder: "Auto-generated when empty",
    },
  ],
  oauth: createGitHubOAuthConfig("github", "GitHub Authentication"),
  createOAuthHandler: (config) => createGitHubDeviceOAuthHandler(config),
  discoverResources: async (config) => {
    const parsed = githubConfigSchema.parse(config);
    const urls = resolveGitHubUrls(parsed.mode as GitHubMode, parsed.baseUrl);
    const token = getGitHubAccessTokenSafe(parsed);
    if (!token) {
      return { ticketProjects: [], repositories: [], discoveredAt: new Date().toISOString() };
    }
    const repos = await listGitHubRepositoriesForUser(token, urls.apiBaseUrl);
    repos.sort((a, b) => a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" }));
    return {
      ticketProjects: repos.map((r) => ({ key: r.fullName, name: r.fullName, url: r.htmlUrl })),
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
  getSummaryDetails(config) {
    const mode = typeof config["mode"] === "string" ? config["mode"] : "github.com";
    return [mode, "project-bound"];
  },
  capabilities: {
    issue_tracking: {
      createConnector: (config: unknown, _integration: Integration, context?: IntegrationBindingContext) => {
        const parsed = githubConfigSchema.parse(config);
        const { owner, repo } = resolveRepo(context?.ticketProjectKey, parsed.repositorySlug, "ticketProjectKey", {
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
    },
    code_review: {
      systemPromptId: "system_github_review",
      userPromptId: "user_github_review",
      createConnector: (config: unknown, _integration: Integration, context?: IntegrationBindingContext) => {
        const parsed = githubConfigSchema.parse(config);
        const { owner, repo } = resolveRepo(context?.repoKey, parsed.repositorySlug, "repoKey", {
          allowUnboundFallback: context === undefined,
        });
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
      createReviewer: (cfg, _integration, workspaceRunner) => {
        const parsed = githubConfigSchema.parse(cfg);
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
            token,
            ...(legacyRepo !== undefined ? { repo: legacyRepo } : {}),
          }),
          buildCloneTarget: (details): { cloneUrl: string; sshKeyPath: null; sshKnownHostsPath: null } => {
            const slash = details.project.indexOf("/");
            const ownerSlug = slash > 0 ? details.project.slice(0, slash) : "";
            const repo = slash > 0 ? details.project.slice(slash + 1) : details.project;
            const cloneUrl = `https://x-access-token:${token}@${host}/${ownerSlug}/${repo}.git`;
            return { cloneUrl, sshKeyPath: null, sshKnownHostsPath: null };
          },
          applyPatchset: async (handle, details): Promise<void> => {
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
    },
    source_control: {
      createVcsConnector: (cfg: Record<string, unknown>, _integration: Integration, context?: IntegrationBindingContext) => {
        const parsed = githubConfigSchema.parse(cfg);
        const { owner, repo } = resolveRepo(context?.repoKey, parsed.repositorySlug, "repoKey");
        const urls = resolveGitHubUrls(parsed.mode as GitHubMode, parsed.baseUrl);
        const host = deriveHost(parsed.mode as GitHubMode, parsed.baseUrl);
        const targetBranch = context?.targetBranch ?? parsed.targetBranch;
        return new GitHubVcsConnector({
          apiBaseUrl: urls.apiBaseUrl,
          host,
          owner,
          repo,
          token: getGitHubAccessToken(parsed as Record<string, unknown>),
          gitAuthorName: parsed.gitAuthorName,
          gitAuthorEmail: parsed.gitAuthorEmail,
          ...(targetBranch !== undefined ? { targetBranch } : {}),
        });
      },
    },
  },
};

/** Return the access token or undefined (discovery tolerates a missing token). */
function getGitHubAccessTokenSafe(config: Record<string, unknown>): string | undefined {
  const raw = config["token"];
  const token = typeof raw === "string" ? raw.trim() : "";
  return token.length > 0 ? token : undefined;
}
