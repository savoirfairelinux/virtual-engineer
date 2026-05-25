import { z } from "zod";

// ─── Shared Zod schemas for GitHub OAuth / auth configuration ─────────────────

export const githubModeSchema = z.enum(["github.com", "github-enterprise"]);

export const githubAuthModeSchema = z.enum(["pat", "oauth"]);

export const githubBaseUrlSchema = z.string().url().optional();

export const githubTokenSchema = z.string().min(1);

export const githubOAuthClientIdSchema = z.string().min(1).optional();
