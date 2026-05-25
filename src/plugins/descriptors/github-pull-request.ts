import { z } from "zod";
import type { PluginDescriptor } from "../registry.js";
import {
  githubModeSchema,
  githubAuthModeSchema,
  githubBaseUrlSchema,
  githubTokenSchema,
} from "./githubOAuth.js";

export const githubPullRequestConfigSchema = z.object({
  mode: githubModeSchema,
  baseUrl: githubBaseUrlSchema,
  authMode: githubAuthModeSchema,
  oauthClientId: z.string().optional(),
  token: githubTokenSchema,
  repositorySlug: z.string().min(1).regex(/^[^/]+\/[^/]+$/),
  virtualEngineerUserLogin: z.string().optional(),
  virtualEngineerUserId: z.number().optional(),
});

export type GitHubPullRequestPluginConfig = z.infer<typeof githubPullRequestConfigSchema>;

export const githubPullRequestDescriptor: PluginDescriptor = {
  type: "github-pull-request",
  name: "GitHub Pull Requests",
  category: "review",
  configSchema: githubPullRequestConfigSchema,
  requiredFields: [
    { key: "mode", label: "GitHub Mode", type: "text", required: true, placeholder: "github.com" },
    { key: "baseUrl", label: "Base URL", type: "url", required: false, placeholder: "https://github.example.com" },
    { key: "authMode", label: "Auth Mode", type: "text", required: true, placeholder: "pat" },
    { key: "oauthClientId", label: "OAuth Client ID", type: "text", required: false, placeholder: "Iv1.abc123" },
    { key: "token", label: "Personal Access Token", type: "password", required: true, placeholder: "ghp_..." },
    { key: "repositorySlug", label: "Repository (owner/repo)", type: "text", required: true, placeholder: "octocat/hello-world" },
  ],
};
