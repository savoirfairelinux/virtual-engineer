import { z } from "zod";
import type { PluginDescriptor } from "../registry.js";
import { HttpRedmineConnector } from "../../connectors/redmineConnector.js";
import { getLogger } from "../../logger.js";

const log = getLogger("redmine-descriptor");

export const redmineConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  virtualEngineerUserId: z.coerce.number().int().positive(),
  closedStatusId: z.coerce.number().int().positive().default(5),
  inProgressStatusId: z.coerce.number().int().positive().default(2),
  inReviewStatusId: z.coerce.number().int().positive().default(4),
  /** Phase 5: HMAC secret for the inbound webhook endpoint /webhooks/:integrationId/:event. */
  webhookSecret: z.string().min(1).optional(),
});

export type RedminePluginConfig = z.infer<typeof redmineConfigSchema>;

export const redmineDescriptor: PluginDescriptor = {
  type: "redmine",
  name: "Redmine",
  category: "ticketing",
  configSchema: redmineConfigSchema,
  requiredFields: [
    { key: "baseUrl", label: "Base URL", type: "url", required: true, placeholder: "http://redmine:3000" },
    { key: "apiKey", label: "API Key", type: "password", required: true, placeholder: "Redmine API key" },
    { key: "virtualEngineerUserId", label: "VE User ID", type: "number", required: true, placeholder: "1" },
    { key: "closedStatusId", label: "Closed Status ID", type: "number", required: false, placeholder: "5" },
    { key: "inProgressStatusId", label: "In Progress Status ID", type: "number", required: false, placeholder: "2" },
    { key: "inReviewStatusId", label: "In Review Status ID", type: "number", required: false, placeholder: "4" },
  ],
  discoverResources: async (config) => {
    const parsed = redmineConfigSchema.parse(config);
    const connector = new HttpRedmineConnector(parsed);
    const ticketProjects = await connector.listProjects();
    return {
      ticketProjects,
      discoveredAt: new Date().toISOString(),
    };
  },
  createInstance: (config) => new HttpRedmineConnector(config as ConstructorParameters<typeof HttpRedmineConnector>[0]),
  testConnection: async (config) => {
    try {
      const cfg = config as Record<string, unknown>;
      const response = await globalThis.fetch(`${String(cfg["baseUrl"])}/users/current.json`, {
        headers: { "X-Redmine-API-Key": String(cfg["apiKey"]) },
      });
      if (!response.ok) {
        return { success: false, error: `Redmine authentication failed: HTTP ${response.status} ${response.statusText}` };
      }
      const user = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!user || !("user" in user)) {
        return { success: false, error: "Invalid Redmine response: missing user data" };
      }
      log.info({ baseUrl: cfg["baseUrl"] }, "Redmine connection test passed");
      return { success: true, error: null };
    } catch (err: unknown) {
      return { success: false, error: `Redmine connection test failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
