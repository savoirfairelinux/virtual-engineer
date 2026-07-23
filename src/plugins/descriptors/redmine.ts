import { z } from "zod";
import type { ProviderDescriptor } from "../registry.js";
import { HttpRedmineConnector } from "../../connectors/redmineConnector.js";
import { getLogger } from "../../logger.js";

const log = getLogger("redmine-descriptor");

const loginField = z
  .string()
  .trim()
  .min(1, "VE User Login is required (e.g. your Redmine username)");

export const redmineConfigSchema = z
  .object({
    baseUrl: z.string().url().optional(),
    apiKey: z.string().min(1).optional(),
    virtualEngineerUserLogin: loginField,
    closedStatusId: z.coerce.number().int().positive().default(5),
    inProgressStatusId: z.coerce.number().int().positive().default(2),
    inReviewStatusId: z.coerce.number().int().positive().default(4),
    webhookSecret: z.string().min(1).optional(),
  })
  .strict();

export type RedminePluginConfig = z.infer<typeof redmineConfigSchema>;

export const redmineDescriptor: ProviderDescriptor = {
  provider: "redmine",
  name: "Redmine",
  icon: { slug: "redmine", hex: "B32024" },
  configSchema: redmineConfigSchema,
  requiredFields: [
    { key: "baseUrl", label: "Base URL", type: "url", required: true, placeholder: "http://redmine:3000" },
    { key: "apiKey", label: "API Key", type: "password", required: true, placeholder: "Redmine API key" },
    {
      key: "virtualEngineerUserLogin",
      label: "VE User Login",
      type: "text",
      required: true,
      placeholder: "e.g. admin",
    },
    { key: "closedStatusId", label: "Closed Status ID", type: "number", required: false, placeholder: "5" },
    { key: "inProgressStatusId", label: "In Progress Status ID", type: "number", required: false, placeholder: "2" },
    { key: "inReviewStatusId", label: "In Review Status ID", type: "number", required: false, placeholder: "4" },
  ],
  discoverResources: async (config) => {
    const parsed = redmineConfigSchema.parse(config) as ConstructorParameters<typeof HttpRedmineConnector>[0];
    const connector = new HttpRedmineConnector(parsed);
    const ticketProjects = await connector.listProjects();
    return {
      ticketProjects,
      discoveredAt: new Date().toISOString(),
    };
  },
  testConnection: async (config) => {
    try {
      const cfg = config as Record<string, unknown>;
      const baseUrl = String(cfg["baseUrl"]);
      const apiKey = String(cfg["apiKey"]);
      const headers = { "X-Redmine-API-Key": apiKey };

      const authResponse = await globalThis.fetch(`${baseUrl}/users/current.json`, { headers });
      if (!authResponse.ok) {
        return { success: false, error: `Redmine authentication failed: HTTP ${authResponse.status} ${authResponse.statusText}` };
      }
      const authBody = (await authResponse.json().catch(() => ({}))) as { user?: { login?: string } };
      if (!authBody || !authBody.user) {
        return { success: false, error: "Invalid Redmine response: missing user data" };
      }
      const currentLogin = authBody.user.login;

      const login = typeof cfg["virtualEngineerUserLogin"] === "string"
        ? (cfg["virtualEngineerUserLogin"] as string).trim()
        : "";
      if (login && login !== currentLogin) {
        const lookupUrl = `${baseUrl}/users.json?name=${encodeURIComponent(login)}`;
        const lookupResponse = await globalThis.fetch(lookupUrl, { headers });
        if (lookupResponse.status === 403) {
          return {
            success: false,
            error:
              `Cannot resolve Redmine login '${login}': the API key belongs to '${currentLogin ?? "unknown"}' ` +
              `and is not allowed to list other users (admin only). Configure VE with the API key of '${login}'.`,
          };
        }
        if (!lookupResponse.ok) {
          return {
            success: false,
            error: `Redmine user lookup failed: HTTP ${lookupResponse.status} ${lookupResponse.statusText}`,
          };
        }
        const lookupBody = (await lookupResponse.json().catch(() => ({}))) as { users?: Array<{ login?: string }> };
        const users = Array.isArray(lookupBody.users) ? lookupBody.users : [];
        const exact = users.find((u) => u.login === login);
        if (!exact) {
          return { success: false, error: `Redmine user not found: no user with login '${login}'` };
        }
      }

      log.info({ baseUrl }, "Redmine connection test passed");
      const logs: string[] = [currentLogin ? `Authenticated as: ${currentLogin}` : "Authentication successful."];
      if (login && login === currentLogin) logs.push(`VE user '${login}' verified.`);
      return { success: true, error: null, logs };
    } catch (err: unknown) {
      return { success: false, error: `Redmine connection test failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
  getSummaryDetails(config) {
    const baseUrl = typeof config["baseUrl"] === "string" && config["baseUrl"].length > 0
      ? config["baseUrl"]
      : "Redmine URL missing";
    return [baseUrl];
  },
  capabilities: {
    issue_tracking: {
      createConnector: (config) => new HttpRedmineConnector(config as ConstructorParameters<typeof HttpRedmineConnector>[0]),
      intake: ["polling", "webhook"],
    },
  },
};
