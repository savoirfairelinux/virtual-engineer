import { z } from "zod";
import type { PluginDescriptor } from "../registry.js";
import {
  githubModeSchema,
  githubAuthModeSchema,
  githubBaseUrlSchema,
  githubTokenSchema,
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

export const githubIssueDescriptor: PluginDescriptor = {
  type: "github-issue",
  name: "GitHub Issues",
  category: "ticketing",
  configSchema: githubIssueConfigSchema,
  requiredFields: [
    { key: "mode", label: "GitHub Mode", type: "text", required: true, placeholder: "github.com" },
    { key: "baseUrl", label: "Base URL", type: "url", required: false, placeholder: "https://github.example.com" },
    { key: "authMode", label: "Auth Mode", type: "text", required: true, placeholder: "pat" },
    { key: "oauthClientId", label: "OAuth Client ID", type: "text", required: false, placeholder: "Iv1.abc123" },
    { key: "token", label: "Personal Access Token", type: "password", required: true, placeholder: "ghp_..." },
    { key: "repositorySlug", label: "Repository (owner/repo)", type: "text", required: true, placeholder: "octocat/hello-world" },
    { key: "ticketLabel", label: "Ticket Label", type: "text", required: true, placeholder: "virtual-engineer" },
  ],
};
