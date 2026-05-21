import { z } from "zod";
import type { PluginDescriptor } from "../registry.js";
import {
  DEFAULT_GITLAB_IN_PROGRESS_LABEL,
  DEFAULT_GITLAB_IN_REVIEW_LABEL,
  GitLabIssueConnector,
} from "../../connectors/gitlabIssueConnector.js";
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

const log = getLogger("gitlab-issue-descriptor");

/**
 * Configuration schema for the GitLab Issues ticketing provider.
 *
 * - `baseUrl`           — Base URL of the GitLab instance (e.g. https://gitlab.example.com).
 * - `token`             — GitLab Personal Access Token with `api` scope; used for all REST calls.
 * - `projectId`         — Legacy fallback project binding. New rows resolve the project from the VE project ticket source.
 * - `closedStatusId`    — Internal workflow close mapping (default: 0).
 * - `inProgressStatusId`— Internal workflow in-progress mapping (default: 1).
 * - `inReviewStatusId`  — Internal workflow in-review mapping (default: 2).
 * - `inProgressLabel`   — Legacy override for the in-progress workflow label (default: `in-progress`).
 * - `inReviewLabel`     — Legacy override for the in-review workflow label (default: `in-review`).
 */
export const gitlabIssueConfigSchema = z.object({
  baseUrl: z.string().url().optional(),
  gitlabMode: gitlabModeSchema,
  projectId: z.union([z.string().min(1), z.coerce.number().int().positive()]).transform(String).optional(),
  authMode: gitlabAuthModeSchema,
  oauthClientId: gitlabOAuthClientIdSchema,
  token: gitlabTokenSchema,
  closedStatusId: z.coerce.number().int().min(0).default(0),
  inProgressStatusId: z.coerce.number().int().min(0).default(1),
  inReviewStatusId: z.coerce.number().int().min(0).default(2),
  inProgressLabel: z.string().min(1).default(DEFAULT_GITLAB_IN_PROGRESS_LABEL),
  inReviewLabel: z.string().min(1).default(DEFAULT_GITLAB_IN_REVIEW_LABEL),
  /** Phase 5: HMAC secret (or X-Gitlab-Token) for the inbound webhook endpoint /webhooks/:integrationId/:event. */
  webhookSecret: z.string().min(1).optional(),
});

export type GitLabIssuePluginConfig = z.infer<typeof gitlabIssueConfigSchema>;

export const gitlabIssueDescriptor: PluginDescriptor = {
  type: "gitlab-issue",
  name: "GitLab Issues",
  category: "ticketing",
  configSchema: gitlabIssueConfigSchema,
  requiredFields: [
    ...createGitLabAuthFields("Personal Access Token"),
  ],
  oauth: createGitLabOAuthConfig("gitlab-issue", "GitLab Issues Authentication"),
  resolveOAuthConfig: resolveGitLabOAuthConfig,
  createOAuthHandler: (config) => createGitLabDeviceOAuthHandler(config),
  discoverResources: async (config) => {
    const parsed = gitlabIssueConfigSchema.parse(config);
    const connector = new GitLabIssueConnector({
      baseUrl: parsed.baseUrl ?? GITLAB_COM_BASE_URL,
      projectId: parsed.projectId ?? UNBOUND_GITLAB_PROJECT_ID,
      token: getGitLabAccessToken(parsed),
      ...(parsed.closedStatusId !== undefined ? { closedStatusId: parsed.closedStatusId } : {}),
      ...(parsed.inProgressStatusId !== undefined ? { inProgressStatusId: parsed.inProgressStatusId } : {}),
      ...(parsed.inReviewStatusId !== undefined ? { inReviewStatusId: parsed.inReviewStatusId } : {}),
      inProgressLabel: parsed.inProgressLabel,
      inReviewLabel: parsed.inReviewLabel,
    });
    const ticketProjects = await connector.listProjects();
    return {
      ticketProjects,
      discoveredAt: new Date().toISOString(),
    };
  },
  createInstance: (config, _integration, context) => {
    const parsed = gitlabIssueConfigSchema.parse(config);
    return new GitLabIssueConnector({
      baseUrl: parsed.baseUrl ?? GITLAB_COM_BASE_URL,
      projectId: context?.ticketProjectKey ?? parsed.projectId ?? UNBOUND_GITLAB_PROJECT_ID,
      token: getGitLabAccessToken(parsed),
      ...(parsed.closedStatusId !== undefined ? { closedStatusId: parsed.closedStatusId } : {}),
      ...(parsed.inProgressStatusId !== undefined ? { inProgressStatusId: parsed.inProgressStatusId } : {}),
      ...(parsed.inReviewStatusId !== undefined ? { inReviewStatusId: parsed.inReviewStatusId } : {}),
      inProgressLabel: parsed.inProgressLabel,
      inReviewLabel: parsed.inReviewLabel,
    });
  },
  testConnection: async (config) => {
    const cfg = config as Record<string, unknown>;
    const result = await testGitLabConnection(cfg);
    if (result.success) {
      log.info({ baseUrl: cfg["baseUrl"] }, "GitLab Issues connection test passed");
    }
    return result;
  },
};
