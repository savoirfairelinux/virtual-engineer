import { z } from "zod";
import type { Integration, IntegrationBindingContext } from "../../interfaces.js";
import type { ProviderDescriptor } from "../registry.js";
import {
  DEFAULT_GITLAB_IN_PROGRESS_LABEL,
  DEFAULT_GITLAB_IN_REVIEW_LABEL,
  GitLabIssueConnector,
} from "../../connectors/gitlabIssueConnector.js";
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

const log = getLogger("gitlab-descriptor");

/**
 * Unified GitLab provider configuration. The single GitLab provider can fulfil
 * `issue_tracking` (Issues), `code_review` (Merge Requests), and
 * `source_control` (push) capabilities; per-project project selection comes
 * from the project binding `ticketProjectKey` / `repoKey`.
 */
export const gitlabConfigSchema = z.object({
  baseUrl: z.string().url().optional(),
  gitlabMode: gitlabModeSchema,
  authMode: gitlabAuthModeSchema,
  oauthClientId: gitlabOAuthClientIdSchema,
  token: gitlabTokenSchema,
  closedStatusId: z.coerce.number().int().min(0).default(0),
  inProgressStatusId: z.coerce.number().int().min(0).default(1),
  inReviewStatusId: z.coerce.number().int().min(0).default(2),
  inProgressLabel: z.string().min(1).default(DEFAULT_GITLAB_IN_PROGRESS_LABEL),
  inReviewLabel: z.string().min(1).default(DEFAULT_GITLAB_IN_REVIEW_LABEL),
  webhookSecret: z.string().min(1).optional(),
  targetBranch: z.string().min(1).optional(),
  gitAuthorName: z.string().min(1).default("Virtual Engineer"),
  gitAuthorEmail: z.string().min(1).default("ve@virtual-engineer.local"),
});

export type GitLabPluginConfig = z.infer<typeof gitlabConfigSchema>;

function resolveGitLabProjectId(
  bound: string | undefined,
  options?: { allowUnboundFallback?: boolean }
): string {
  if (bound && bound.length > 0) return bound;
  if (options?.allowUnboundFallback === true) return UNBOUND_GITLAB_PROJECT_ID;
  throw new Error("GitLab project binding is required for this capability");
}

export const gitlabDescriptor: ProviderDescriptor = {
  provider: "gitlab",
  name: "GitLab",
  icon: { slug: "gitlab", hex: "FC6D26" },
  configSchema: gitlabConfigSchema,
  requiredFields: [
    ...createGitLabAuthFields("Personal Access Token"),
    {
      key: "webhookSecret",
      label: "Webhook secret",
      type: "password",
      required: false,
      placeholder: "Auto-generated when empty",
    },
  ],
  oauth: createGitLabOAuthConfig("gitlab", "GitLab Authentication"),
  resolveOAuthConfig: resolveGitLabOAuthConfig,
  createOAuthHandler: (config) => createGitLabDeviceOAuthHandler(config),
  discoverResources: async (config) => {
    const parsed = gitlabConfigSchema.parse(config);
    const baseUrl = parsed.baseUrl ?? GITLAB_COM_BASE_URL;
    const token = getGitLabAccessToken(parsed);
    const issueConnector = new GitLabIssueConnector({
      baseUrl,
      projectId: UNBOUND_GITLAB_PROJECT_ID,
      token,
      ...(parsed.closedStatusId !== undefined ? { closedStatusId: parsed.closedStatusId } : {}),
      ...(parsed.inProgressStatusId !== undefined ? { inProgressStatusId: parsed.inProgressStatusId } : {}),
      ...(parsed.inReviewStatusId !== undefined ? { inReviewStatusId: parsed.inReviewStatusId } : {}),
      inProgressLabel: parsed.inProgressLabel,
      inReviewLabel: parsed.inReviewLabel,
    });
    const mrConnector = new GitLabMergeRequestConnector({
      baseUrl,
      projectId: UNBOUND_GITLAB_PROJECT_ID,
      token,
    });
    const ticketProjects = await issueConnector.listProjects();
    const repositories = await mrConnector.listRepositories();
    return {
      ticketProjects,
      repositories,
      discoveredAt: new Date().toISOString(),
    };
  },
  discoverBranches: async (config, repoKey) => {
    const parsed = gitlabConfigSchema.parse(config);
    const baseUrl = parsed.baseUrl ?? GITLAB_COM_BASE_URL;
    const token = getGitLabAccessToken(parsed);
    const mrConnector = new GitLabMergeRequestConnector({
      baseUrl,
      projectId: UNBOUND_GITLAB_PROJECT_ID,
      token,
    });
    return mrConnector.listBranches(repoKey);
  },
  testConnection: async (config) => {
    const cfg = config as Record<string, unknown>;
    const result = await testGitLabConnection(cfg);
    if (result.success) {
      log.info({ baseUrl: cfg["baseUrl"] }, "GitLab connection test passed");
    }
    return result;
  },
  getSummaryDetails(config) {
    const baseUrl = typeof config["baseUrl"] === "string" && config["baseUrl"].length > 0
      ? config["baseUrl"]
      : "GitLab URL missing";
    return [baseUrl, "project-bound"];
  },
  normalizeConfigForRead(masked) {
    // Default legacy configs (saved before authMode existed) to PAT auth so the
    // admin UI renders the correct auth controls.
    if (masked["authMode"] === undefined) {
      return { ...masked, authMode: "pat" };
    }
    return masked;
  },
  capabilities: {
    issue_tracking: {
      createConnector: (config: unknown, _integration: Integration, context?: IntegrationBindingContext) => {
        const parsed = gitlabConfigSchema.parse(config);
        return new GitLabIssueConnector({
          baseUrl: parsed.baseUrl ?? GITLAB_COM_BASE_URL,
          projectId: context?.ticketProjectKey ?? UNBOUND_GITLAB_PROJECT_ID,
          token: getGitLabAccessToken(parsed),
          ...(parsed.closedStatusId !== undefined ? { closedStatusId: parsed.closedStatusId } : {}),
          ...(parsed.inProgressStatusId !== undefined ? { inProgressStatusId: parsed.inProgressStatusId } : {}),
          ...(parsed.inReviewStatusId !== undefined ? { inReviewStatusId: parsed.inReviewStatusId } : {}),
          inProgressLabel: parsed.inProgressLabel,
          inReviewLabel: parsed.inReviewLabel,
        });
      },
      intake: ["polling", "webhook"],
    },
    code_review: {
      createConnector: (config: unknown, _integration: Integration, context?: IntegrationBindingContext) => {
        const parsed = gitlabConfigSchema.parse(config);
        return new GitLabMergeRequestConnector({
          baseUrl: parsed.baseUrl ?? GITLAB_COM_BASE_URL,
          projectId: resolveGitLabProjectId(context?.repoKey, { allowUnboundFallback: true }),
          token: getGitLabAccessToken(parsed),
        });
      },
      intake: ["polling", "webhook"],
    },
    source_control: {
      createVcsConnector: (cfg: Record<string, unknown>, _integration: Integration, context?: IntegrationBindingContext) => {
        const parsed = gitlabConfigSchema.parse(cfg);
        const targetBranch = context?.targetBranch ?? parsed.targetBranch;
        return new GitLabVcsConnector({
          baseUrl: parsed.baseUrl ?? GITLAB_COM_BASE_URL,
          projectId: resolveGitLabProjectId(context?.repoKey),
          token: getGitLabAccessToken(parsed),
          gitAuthorName: parsed.gitAuthorName,
          gitAuthorEmail: parsed.gitAuthorEmail,
          ...(targetBranch !== undefined ? { targetBranch } : {}),
        });
      },
    },
  },
};
