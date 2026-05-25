import { z } from "zod";
import type { PluginDescriptor } from "../registry.js";
import { GitLabMergeRequestConnector } from "../../connectors/gitlabMergeRequestConnector.js";
import { GitLabVcsConnector } from "../../vcs/gitlabVcsConnector.js";
import { getLogger } from "../../logger.js";
import {
  createGitLabAuthFields,
  createGitLabOAuthConfig,
  createGitLabDeviceOAuthHandler,
  gitlabAuthModeSchema,
  gitlabModeSchema,
  gitlabOAuthClientIdSchema,
  gitlabTokenSchema,
  resolveGitLabOAuthConfig,
  testGitLabConnection,
  UNBOUND_GITLAB_PROJECT_ID,
  GITLAB_COM_BASE_URL,
} from "./gitlabOAuth.js";
import { getGitLabAccessToken } from "../../utils/gitlabAuth.js";

const log = getLogger("gitlab-merge-request-descriptor");

function resolveGitLabReviewProjectId(
  projectId: string | number | undefined,
  repoKey: string | undefined,
  options?: { allowUnboundFallback?: boolean }
): string | number {
  if (repoKey && repoKey.length > 0) {
    return repoKey;
  }
  if (projectId !== undefined) {
    return projectId;
  }
  if (options?.allowUnboundFallback === true) {
    return UNBOUND_GITLAB_PROJECT_ID;
  }
  throw new Error("GitLab project binding is required for merge request VCS operations");
}

/**
 * Configuration schema for the GitLab Merge Requests review provider.
 *
 * - `baseUrl`   — Base URL of the GitLab instance (e.g. https://gitlab.example.com).
 * - `projectId` — Legacy fallback target project. New rows resolve the project from the VE project repo binding.
 * - `token`     — GitLab Personal Access Token with `api` scope; used for MR creation, polling,
 *                 and comment operations.
 */
export const gitlabMergeRequestConfigSchema = z.object({
  baseUrl: z.string().url().optional(),
  gitlabMode: gitlabModeSchema,
  projectId: z.union([z.string().min(1), z.coerce.number().int().positive()]).optional(),
  authMode: gitlabAuthModeSchema,
  oauthClientId: gitlabOAuthClientIdSchema,
  token: gitlabTokenSchema,
  /** Phase 5: HMAC secret (or X-Gitlab-Token) for the inbound webhook endpoint /webhooks/:integrationId/:event. */
  webhookSecret: z.string().min(1).optional(),
  /** Target branch for MR creation. Defaults to "main" when not set. */
  targetBranch: z.string().min(1).optional(),
  /** Git author name used when the agent creates commits. */
  gitAuthorName: z.string().min(1).default("Virtual Engineer"),
  /** Git author email used when the agent creates commits. */
  gitAuthorEmail: z.string().min(1).default("ve@virtual-engineer.local"),
});

export type GitLabMergeRequestPluginConfig = z.infer<typeof gitlabMergeRequestConfigSchema>;

export const gitlabMergeRequestDescriptor: PluginDescriptor = {
  type: "gitlab-merge-request",
  name: "GitLab Merge Requests",
  category: "review",
  configSchema: gitlabMergeRequestConfigSchema,
  requiredFields: [
    ...createGitLabAuthFields("Personal Access Token"),
  ],
  oauth: createGitLabOAuthConfig("gitlab-merge-request", "GitLab Merge Request Authentication"),
  resolveOAuthConfig: resolveGitLabOAuthConfig,
  createOAuthHandler: (config) => createGitLabDeviceOAuthHandler(config),
  discoverResources: async (config) => {
    const parsed = gitlabMergeRequestConfigSchema.parse(config);
    const connector = new GitLabMergeRequestConnector({
      baseUrl: parsed.baseUrl ?? GITLAB_COM_BASE_URL,
      projectId: parsed.projectId ?? UNBOUND_GITLAB_PROJECT_ID,
      token: getGitLabAccessToken(parsed),
    });
    const repositories = await connector.listRepositories();
    return {
      repositories,
      discoveredAt: new Date().toISOString(),
    };
  },
  createInstance: (config, _integration, context) => {
    const parsed = gitlabMergeRequestConfigSchema.parse(config);
    return new GitLabMergeRequestConnector({
      baseUrl: parsed.baseUrl ?? GITLAB_COM_BASE_URL,
      projectId: resolveGitLabReviewProjectId(parsed.projectId, context?.repoKey, { allowUnboundFallback: true }),
      token: getGitLabAccessToken(parsed),
    });
  },
  testConnection: async (config) => {
    const cfg = config as Record<string, unknown>;
    const result = await testGitLabConnection(cfg);
    if (result.success) {
      log.info({ baseUrl: cfg["baseUrl"] }, "GitLab Merge Request connection test passed");
    }
    return result;
  },
  createVcsConnector: (cfg, _integration, context) => new GitLabVcsConnector({
    baseUrl: (typeof cfg["baseUrl"] === "string" && cfg["baseUrl"].trim() ? cfg["baseUrl"] : GITLAB_COM_BASE_URL) as string,
    projectId: resolveGitLabReviewProjectId(
      cfg["projectId"] as string | number | undefined,
      context?.repoKey
    ),
    token: getGitLabAccessToken(cfg),
    gitAuthorName: cfg["gitAuthorName"] as string,
    gitAuthorEmail: cfg["gitAuthorEmail"] as string,
    ...(typeof cfg["targetBranch"] === "string" ? { targetBranch: cfg["targetBranch"] } : {}),
  }),
  getSummaryDetails(config) {
    const baseUrl = typeof config["baseUrl"] === "string" && config["baseUrl"].length > 0
      ? config["baseUrl"]
      : "GitLab URL missing";
    const id = config["projectId"];
    const projectId = typeof id === "string" ? id : typeof id === "number" ? String(id) : "unset";
    return [baseUrl, `Project ${projectId}`];
  },
};
