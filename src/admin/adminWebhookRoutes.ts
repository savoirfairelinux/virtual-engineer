import type { IncomingMessage, ServerResponse } from "node:http";
import { getLogger } from "../logger.js";
import type { IntegrationStore } from "../interfaces.js";
import { generateWebhookSecret, listSupportedEvents } from "../webhooks/webhookServer.js";
import { writeJson, readBody } from "./adminRouteUtils.js";

const log = getLogger("admin-webhooks");

export interface WebhookRouteDeps {
  integrationStore?: IntegrationStore | undefined;
  onIntegrationUpdated?: ((integrationId: string) => void) | undefined;
  webhookPublicBaseUrl?: string | undefined;
}

/**
 * Try to handle a webhook-management route request. Returns true if the request
 * was handled (response sent), false otherwise.
 */
export async function handleWebhookRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  method: string,
  deps: WebhookRouteDeps,
): Promise<boolean> {
  const rotateSecretMatch = /^\/api\/admin\/integrations\/([^/]+)\/webhook-secret\/rotate$/.exec(path);
  if (rotateSecretMatch && method === "POST") {
    if (!deps.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return true;
    }
    const id = decodeURIComponent(rotateSecretMatch[1] ?? "");
    const integration = await deps.integrationStore.getIntegration(id);
    if (!integration) {
      writeJson(response, 404, { error: "Integration not found" });
      return true;
    }
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
        type: integration.type,
        name: integration.name,
        configJson: JSON.stringify(parsed),
        enabled: integration.enabled,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ id, err }, "rotate webhook secret failed");
      writeJson(response, 500, { error: msg });
      return true;
    }
    deps.onIntegrationUpdated?.(id);
    writeJson(response, 200, { secret: newSecret });
    return true;
  }

  // ─── Webhook allowed IPs management route ─────────────────────────────────
  const webhookIpsMatch = /^\/api\/admin\/integrations\/([^/]+)\/webhook-allowed-ips$/.exec(path);
  if (webhookIpsMatch && method === "PUT") {
    if (!deps.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return true;
    }
    const id = decodeURIComponent(webhookIpsMatch[1] ?? "");
    const integration = await deps.integrationStore.getIntegration(id);
    if (!integration) {
      writeJson(response, 404, { error: "Integration not found" });
      return true;
    }
    const body = await readBody(request);
    if (!body) {
      writeJson(response, 400, { error: "Invalid JSON body" });
      return true;
    }
    const { allowedIps } = body as Record<string, unknown>;
    if (!Array.isArray(allowedIps)) {
      writeJson(response, 400, { error: "allowedIps must be an array of IP strings" });
      return true;
    }
    for (const ip of allowedIps) {
      if (typeof ip !== "string") {
        writeJson(response, 400, { error: "Each allowed IP must be a string" });
        return true;
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
        type: integration.type,
        name: integration.name,
        configJson: JSON.stringify(parsed),
        enabled: integration.enabled,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ id, err }, "update webhook allowed IPs failed");
      writeJson(response, 500, { error: msg });
      return true;
    }
    deps.onIntegrationUpdated?.(id);
    writeJson(response, 200, { allowedIps });
    return true;
  }

  // ─── Webhook allowed IPs GET route ────────────────────────────────────────
  if (webhookIpsMatch && method === "GET") {
    if (!deps.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return true;
    }
    const id = decodeURIComponent(webhookIpsMatch[1] ?? "");
    const integration = await deps.integrationStore.getIntegration(id);
    if (!integration) {
      writeJson(response, 404, { error: "Integration not found" });
      return true;
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
    const allowedIps = Array.isArray(parsed["webhookAllowedIps"]) ? parsed["webhookAllowedIps"] : [];
    writeJson(response, 200, { allowedIps });
    return true;
  }

  const webhookInfoMatch = /^\/api\/admin\/integrations\/([^/]+)\/webhook-info$/.exec(path);
  if (webhookInfoMatch && method === "GET") {
    if (!deps.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return true;
    }
    const id = decodeURIComponent(webhookInfoMatch[1] ?? "");
    const integration = await deps.integrationStore.getIntegration(id);
    if (!integration) {
      writeJson(response, 404, { error: "Integration not found" });
      return true;
    }
    let secretConfigured = false;
    try {
      const obj = JSON.parse(integration.configJson) as unknown;
      if (typeof obj === "object" && obj !== null) {
        const v = (obj as Record<string, unknown>)["webhookSecret"];
        secretConfigured = typeof v === "string" && v.length > 0;
      }
    } catch { /* secretConfigured stays false */ }

    const events = listSupportedEvents(integration.type);
    const hostHeader = request.headers.host ?? "127.0.0.1";
    const base = deps.webhookPublicBaseUrl ?? `http://${hostHeader}`;
    const sample = events[0] ?? "<event>";
    writeJson(response, 200, {
      integrationId: integration.id,
      integrationType: integration.type,
      url: `${base.replace(/\/$/, "")}/webhooks/${encodeURIComponent(integration.id)}/${encodeURIComponent(sample)}`,
      urlTemplate: `${base.replace(/\/$/, "")}/webhooks/${encodeURIComponent(integration.id)}/:event`,
      events,
      secretConfigured,
    });
    return true;
  }

  return false;
}
