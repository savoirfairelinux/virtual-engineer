import { getLogger } from "../logger.js";
import type { IntegrationStore } from "../interfaces.js";
import { generateWebhookSecret, listSupportedEvents } from "../webhooks/webhookServer.js";
import { writeJson, readBody } from "./adminRouteUtils.js";
import { recordAudit, type AuditCapableStore } from "./adminAudit.js";
import type { Router } from "./router.js";

const log = getLogger("admin-webhooks");

export interface WebhookRouteDeps {
  integrationStore?: IntegrationStore | undefined;
  auditStore?: AuditCapableStore | undefined;
  onIntegrationUpdated?: ((integrationId: string) => void) | undefined;
  webhookPublicBaseUrl?: string | undefined;
}

/** Register webhook-management routes on the given router. */
export function registerWebhookRoutes(router: Router, deps: WebhookRouteDeps): void {
  router.add("POST", "/api/admin/integrations/:id/webhook-secret/rotate", async (req, res, params) => {
    if (!deps.integrationStore) { writeJson(res, 501, { error: "Integration store not available" }); return; }
    const id = params["id"] ?? "";
    const integration = await deps.integrationStore.getIntegration(id);
    if (!integration) { writeJson(res, 404, { error: "Integration not found" }); return; }
    const newSecret = generateWebhookSecret();
    let parsed: Record<string, unknown>;
    try {
      const obj = JSON.parse(integration.configJson) as unknown;
      parsed = (typeof obj === "object" && obj !== null && !Array.isArray(obj))
        ? (obj as Record<string, unknown>)
        : {};
    } catch {
      parsed = {};
    }
    parsed["webhookSecret"] = newSecret;
    try {
      await deps.integrationStore.upsertIntegration({
        id: integration.id,
        provider: integration.provider,
        name: integration.name,
        configJson: JSON.stringify(parsed),
        enabled: integration.enabled,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ id, err }, "rotate webhook secret failed");
      writeJson(res, 500, { error: msg });
      return;
    }
    deps.onIntegrationUpdated?.(id);
    recordAudit(deps.auditStore, req, { action: "webhook.secret_rotate", targetType: "integration", targetId: id, details: { name: integration.name, provider: integration.provider } });
    writeJson(res, 200, { secret: newSecret });
  }, { role: "admin" });

  router.add("PUT", "/api/admin/integrations/:id/webhook-allowed-ips", async (req, res, params) => {
    if (!deps.integrationStore) { writeJson(res, 501, { error: "Integration store not available" }); return; }
    const id = params["id"] ?? "";
    const integration = await deps.integrationStore.getIntegration(id);
    if (!integration) { writeJson(res, 404, { error: "Integration not found" }); return; }
    const body = await readBody(req);
    if (!body) { writeJson(res, 400, { error: "Invalid JSON body" }); return; }
    const { allowedIps } = body as Record<string, unknown>;
    if (!Array.isArray(allowedIps)) {
      writeJson(res, 400, { error: "allowedIps must be an array of IP strings" });
      return;
    }
    for (const ip of allowedIps) {
      if (typeof ip !== "string") {
        writeJson(res, 400, { error: "Each allowed IP must be a string" });
        return;
      }
    }
    let parsed: Record<string, unknown>;
    try {
      const obj = JSON.parse(integration.configJson) as unknown;
      parsed = (typeof obj === "object" && obj !== null && !Array.isArray(obj))
        ? (obj as Record<string, unknown>)
        : {};
    } catch {
      parsed = {};
    }
    parsed["webhookAllowedIps"] = allowedIps;
    try {
      await deps.integrationStore.upsertIntegration({
        id: integration.id,
        provider: integration.provider,
        name: integration.name,
        configJson: JSON.stringify(parsed),
        enabled: integration.enabled,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ id, err }, "update webhook allowed IPs failed");
      writeJson(res, 500, { error: msg });
      return;
    }
    deps.onIntegrationUpdated?.(id);
    recordAudit(deps.auditStore, req, { action: "webhook.allowed_ips_update", targetType: "integration", targetId: id, details: { name: integration.name, provider: integration.provider, allowedIps } });
    writeJson(res, 200, { allowedIps });
  }, { role: "admin" });

  router.add("GET", "/api/admin/integrations/:id/webhook-allowed-ips", async (_req, res, params) => {
    if (!deps.integrationStore) { writeJson(res, 501, { error: "Integration store not available" }); return; }
    const id = params["id"] ?? "";
    const integration = await deps.integrationStore.getIntegration(id);
    if (!integration) { writeJson(res, 404, { error: "Integration not found" }); return; }
    let parsed: Record<string, unknown>;
    try {
      const obj = JSON.parse(integration.configJson) as unknown;
      parsed = (typeof obj === "object" && obj !== null && !Array.isArray(obj))
        ? (obj as Record<string, unknown>)
        : {};
    } catch {
      parsed = {};
    }
    const allowedIps = Array.isArray(parsed["webhookAllowedIps"]) ? parsed["webhookAllowedIps"] : [];
    writeJson(res, 200, { allowedIps });
  });

  router.add("GET", "/api/admin/integrations/:id/webhook-info", async (req, res, params) => {
    if (!deps.integrationStore) { writeJson(res, 501, { error: "Integration store not available" }); return; }
    const id = params["id"] ?? "";
    const integration = await deps.integrationStore.getIntegration(id);
    if (!integration) { writeJson(res, 404, { error: "Integration not found" }); return; }
    let secretConfigured = false;
    try {
      const obj = JSON.parse(integration.configJson) as unknown;
      if (typeof obj === "object" && obj !== null) {
        const v = (obj as Record<string, unknown>)["webhookSecret"];
        secretConfigured = typeof v === "string" && v.length > 0;
      }
    } catch { /* secretConfigured stays false */ }
    const events = listSupportedEvents(integration.provider);
    const hostHeader = req.headers.host ?? "127.0.0.1";
    const base = deps.webhookPublicBaseUrl ?? `http://${hostHeader}`;
    const sample = events[0] ?? "<event>";
    writeJson(res, 200, {
      integrationId: integration.id,
      integrationType: integration.provider,
      url: `${base.replace(/\/$/, "")}/webhooks/${encodeURIComponent(integration.id)}/${encodeURIComponent(sample)}`,
      urlTemplate: `${base.replace(/\/$/, "")}/webhooks/${encodeURIComponent(integration.id)}/:event`,
      events,
      secretConfigured,
    });
  });
}
