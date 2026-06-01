import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getLogger } from "../logger.js";
import type { Integration, IntegrationStore, OAuthApp, OAuthAppStore } from "../interfaces.js";
import { CODE_SOURCE_INTEGRATION_TYPES, TICKET_SOURCE_INTEGRATION_TYPES } from "../interfaces.js";
import type { PluginManager } from "../plugins/pluginManager.js";
import { getAllPluginDescriptors, getPluginCapabilities, getPluginDescriptor } from "../plugins/registry.js";
import { decryptToken } from "../utils/encryption.js";
import { normalizeGitLabBaseUrl } from "../utils/gitlabAuth.js";
import { exchangeForSessionToken, fetchAvailableModels } from "../agents/copilotModelsService.js";
import { writeJson, readBody, asRecord, toIsoTimestamp, SECRET_MASK, parseConfig, formatZodError } from "./adminRouteUtils.js";

const log = getLogger("admin-integrations");

export interface IntegrationRouteDeps {
  integrationStore?: IntegrationStore | undefined;
  pluginManager?: PluginManager | undefined;
  oAuthAppStore?: OAuthAppStore | undefined;
  integrationStreams?: { getStatus(integrationId: string): unknown | null } | undefined;
  onIntegrationUpdated?: ((integrationId: string) => void) | undefined;
  adminAuthSecret?: string | undefined;
}

/**
 * Try to handle an integration/plugin/oauth-app route request. Returns true
 * if the request was handled (response sent), false otherwise.
 */
export async function handleIntegrationRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  method: string,
  deps: IntegrationRouteDeps,
): Promise<boolean> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

  // ─── Plugin discovery ─────────────────────────────────────────────────────
  if (path === "/api/admin/plugins" && method === "GET") {
    const descriptors = getAllPluginDescriptors();
    writeJson(response, 200, {
      plugins: descriptors.map((d) => ({
        type: d.type,
        name: d.name,
        category: d.category,
        capabilities: getPluginCapabilities(d),
        requiredFields: d.requiredFields,
        ...(d.oauth !== undefined ? { oauth: d.oauth } : {}),
      })),
    });
    return true;
  }

  // ─── OAuth Apps ────────────────────────────────────────────────────────────
  if (path === "/api/admin/oauth-apps" && method === "GET") {
    if (!deps.oAuthAppStore) {
      writeJson(response, 501, { error: "OAuth app registry is not available" });
      return true;
    }
    const providerParam = requestUrl.searchParams.get("provider") ?? undefined;
    const apps = await deps.oAuthAppStore.listOAuthApps(providerParam);
    writeJson(response, 200, {
      apps: apps.map((app) => serializeOAuthApp(app)),
    });
    return true;
  }

  if (path === "/api/admin/oauth-apps" && method === "POST") {
    if (!deps.oAuthAppStore) {
      writeJson(response, 501, { error: "OAuth app registry is not available" });
      return true;
    }
    const body = await readBody(request);
    const provider = typeof body?.["provider"] === "string" ? body["provider"] : "gitlab";
    const baseUrl = typeof body?.["baseUrl"] === "string" ? body["baseUrl"] : "";
    const clientId = typeof body?.["clientId"] === "string" ? body["clientId"] : "";
    if (!baseUrl || !clientId) {
      writeJson(response, 400, { error: "Missing required fields: baseUrl, clientId" });
      return true;
    }
    const app = await deps.oAuthAppStore.upsertOAuthApp({
      provider,
      baseUrl: normalizeGitLabBaseUrl(baseUrl),
      clientId,
    });
    writeJson(response, 201, { app: serializeOAuthApp(app) });
    return true;
  }

  if (path === "/api/admin/oauth-apps" && method === "DELETE") {
    if (!deps.oAuthAppStore) {
      writeJson(response, 501, { error: "OAuth app registry is not available" });
      return true;
    }
    const body = await readBody(request);
    const provider = typeof body?.["provider"] === "string" ? body["provider"] : "gitlab";
    const baseUrl = typeof body?.["baseUrl"] === "string" ? body["baseUrl"] : "";
    if (!baseUrl) {
      writeJson(response, 400, { error: "baseUrl is required" });
      return true;
    }
    await deps.oAuthAppStore.deleteOAuthApp(provider, normalizeGitLabBaseUrl(baseUrl));
    writeJson(response, 200, { ok: true });
    return true;
  }

  if (path === "/api/admin/oauth-apps/resolve" && method === "POST") {
    if (!deps.oAuthAppStore) {
      writeJson(response, 501, { error: "OAuth app registry is not available" });
      return true;
    }
    const body = await readBody(request);
    const provider = typeof body?.["provider"] === "string" ? body["provider"] : "gitlab";
    const baseUrl = typeof body?.["baseUrl"] === "string" ? body["baseUrl"] : "";
    if (!baseUrl) {
      writeJson(response, 400, { error: "baseUrl is required" });
      return true;
    }
    const normalizedBaseUrl = normalizeGitLabBaseUrl(baseUrl);
    const app = await deps.oAuthAppStore.getOAuthApp(provider, normalizedBaseUrl);
    if (!app) {
      writeJson(response, 404, { error: `No OAuth app is configured for ${provider}:${normalizedBaseUrl}. Ask an administrator to add one in Configuration / OAuth Apps.` });
      return true;
    }
    writeJson(response, 200, { app: serializeOAuthApp(app) });
    return true;
  }

  // ─── Integrations CRUD ────────────────────────────────────────────────────
  if (path === "/api/admin/integrations" && method === "GET") {
    if (!deps.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return true;
    }
    const list = await deps.integrationStore.getIntegrations();
    const pm = deps.pluginManager;
    writeJson(response, 200, {
      integrations: list.map((i) => serializeIntegration(i, pm, deps.integrationStreams)),
    });
    return true;
  }

  if (path === "/api/admin/integrations/by-category" && method === "GET") {
    if (!deps.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return true;
    }
    const codeSourceTypes = new Set<string>(CODE_SOURCE_INTEGRATION_TYPES);
    const ticketSourceTypes = new Set<string>(TICKET_SOURCE_INTEGRATION_TYPES);
    const list = await deps.integrationStore.getIntegrations();
    const codeSources = list.filter((i) => codeSourceTypes.has(i.type));
    const ticketSources = list.filter((i) => ticketSourceTypes.has(i.type));
    writeJson(response, 200, {
      codeSources: codeSources.map((i) => serializeIntegration(i, deps.pluginManager, deps.integrationStreams)),
      ticketSources: ticketSources.map((i) => serializeIntegration(i, deps.pluginManager, deps.integrationStreams)),
    });
    return true;
  }

  if (path === "/api/admin/integrations" && method === "POST") {
    if (!deps.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return true;
    }
    const body = await readBody(request);
    if (!body || !body["type"] || !body["name"]) {
      writeJson(response, 400, { error: "Missing required fields: type, name" });
      return true;
    }
    const type = body["type"] as Integration["type"];
    const descriptor = getPluginDescriptor(type);
    if (!descriptor) {
      writeJson(response, 400, { error: `Unknown integration type: ${body["type"] as string}` });
      return true;
    }
    const validatedConfig = validateIntegrationConfig(
      descriptor.configSchema,
      asRecord(body["config"]),
      type !== "copilot"
    );
    if (!validatedConfig.ok) {
      const fallback = type === "copilot" ? `Invalid config for ${type}` : "Invalid integration config";
      writeJson(response, 400, { error: validatedConfig.message || fallback });
      return true;
    }
    const id = body["id"] as string || randomUUID();
    try {
      const integration = await deps.integrationStore.upsertIntegration({
        id,
        type,
        name: body["name"] as string,
        configJson: JSON.stringify(validatedConfig.data),
        enabled: true,
      });
      if (deps.pluginManager) {
        try {
          await deps.pluginManager.reloadIntegration(id);
        } catch (activationErr: unknown) {
          log.warn({ id, type, err: activationErr }, "integration created but could not be activated at runtime (incomplete config?)");
        }
      }
      writeJson(response, 201, { integration: serializeIntegration(integration, deps.pluginManager, deps.integrationStreams) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err }, "create integration failed");
      writeJson(response, 500, { error: msg });
    }
    return true;
  }

  if (path === "/api/admin/integrations/test" && method === "POST") {
    if (!deps.pluginManager) {
      writeJson(response, 501, { error: "Plugin manager not available" });
      return true;
    }

    const body = (await readBody(request)) ?? {};
    const integrationId = typeof body["integrationId"] === "string"
      ? body["integrationId"]
      : undefined;
    const requestedType = typeof body["type"] === "string"
      ? body["type"] as Integration["type"]
      : undefined;
    const config = asRecord(body["config"]);

    try {
      if (integrationId) {
        if (!deps.integrationStore) {
          writeJson(response, 501, { error: "Integration store not available" });
          return true;
        }

        const existing = await deps.integrationStore.getIntegration(integrationId);
        if (!existing) {
          writeJson(response, 404, { error: "Integration not found" });
          return true;
        }

        if (requestedType !== undefined && requestedType !== existing.type) {
          writeJson(response, 400, { error: "Changing integration type is not supported" });
          return true;
        }

        const result = await deps.pluginManager.testConnectionConfig(
          existing.type,
          mergeIntegrationConfig(existing, config)
        );

        // Persist discovered models on successful test
        if (result.success && Array.isArray(result.models) && result.models.length > 0) {
          if (typeof deps.integrationStore.setIntegrationDiscoveredResources === "function") {
            await deps.integrationStore.setIntegrationDiscoveredResources(
              integrationId,
              JSON.stringify({ models: result.models })
            );
          }
        }

        writeJson(response, 200, result);
        return true;
      }

      if (!requestedType) {
        writeJson(response, 400, { error: "Integration type is required" });
        return true;
      }

      const result = await deps.pluginManager.testConnectionConfig(requestedType, config);
      writeJson(response, 200, result);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn({ integrationId, requestedType, errorMessage }, "config test connection failed");
      writeJson(response, 400, { success: false, error: errorMessage, models: [] });
    }
    return true;
  }

  // ─── Single integration by ID ─────────────────────────────────────────────
  const integrationIdMatch = /^\/api\/admin\/integrations\/([^/]+)$/.exec(path);

  if (integrationIdMatch && method === "PUT") {
    if (!deps.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return true;
    }
    const id = decodeURIComponent(integrationIdMatch[1] ?? "");
    const existing = await deps.integrationStore.getIntegration(id);
    if (!existing) {
      writeJson(response, 404, { error: "Integration not found" });
      return true;
    }
    const body = await readBody(request);
    if (!body) {
      writeJson(response, 400, { error: "Request body required" });
      return true;
    }
    const requestedType = body["type"] as Integration["type"] | undefined;
    if (requestedType !== undefined && requestedType !== existing.type) {
      writeJson(response, 400, { error: "Changing integration type is not supported" });
      return true;
    }

    const nextType = existing.type;
    const descriptor = getPluginDescriptor(nextType);
    if (!descriptor) {
      writeJson(response, 400, { error: `Unknown integration type: ${nextType}` });
      return true;
    }
    const nextConfig = body["config"];
    const mergedConfig = nextConfig === undefined
      ? getStoredIntegrationConfig(existing)
      : mergeIntegrationConfig(existing, asRecord(nextConfig));
    const validatedConfig = validateIntegrationConfig(descriptor.configSchema, mergedConfig, true);
    if (!validatedConfig.ok) {
      writeJson(response, 400, { error: validatedConfig.message || "Invalid integration config" });
      return true;
    }

    try {
      const nextConfigJson = JSON.stringify(validatedConfig.data);
      const configChanged = nextConfig !== undefined && nextConfigJson !== existing.configJson;
      const updated = await deps.integrationStore.upsertIntegration({
        id,
        type: nextType,
        name: (body["name"] as string) ?? existing.name,
        configJson: nextConfigJson,
        enabled: existing.enabled,
      });
      if (configChanged) {
        await deps.integrationStore.clearIntegrationDiscoveredResources?.(id);
      }
      const fresh = configChanged ? (await deps.integrationStore.getIntegration(id)) ?? updated : updated;
      const fullyValidatedConfig = validateIntegrationConfig(descriptor.configSchema, validatedConfig.data, false);
      let appliedAtRuntime = false;
      if (updated.enabled && deps.pluginManager && fullyValidatedConfig.ok) {
        await deps.pluginManager.reloadIntegration(id);
        appliedAtRuntime = true;
      }
      deps.onIntegrationUpdated?.(id);
      writeJson(response, 200, { 
        integration: serializeIntegration(fresh, deps.pluginManager, deps.integrationStreams),
        appliedAtRuntime
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err }, "update integration failed");
      writeJson(response, 500, { error: msg });
    }
    return true;
  }

  if (integrationIdMatch && method === "GET") {
    if (!deps.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return true;
    }
    const id = decodeURIComponent(integrationIdMatch[1] ?? "");
    const integration = await deps.integrationStore.getIntegration(id);
    if (!integration) {
      writeJson(response, 404, { error: "Integration not found" });
      return true;
    }
    writeJson(response, 200, { integration: serializeIntegration(integration, deps.pluginManager, deps.integrationStreams) });
    return true;
  }

  if (integrationIdMatch && method === "DELETE") {
    if (!deps.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return true;
    }
    const id = decodeURIComponent(integrationIdMatch[1] ?? "");
    const existing = await deps.integrationStore.getIntegration(id);
    if (!existing) {
      writeJson(response, 404, { error: "Integration not found" });
      return true;
    }
    if (deps.integrationStore.countIntegrationReferences) {
      const refCount = await deps.integrationStore.countIntegrationReferences(id);
      if (refCount > 0) {
        writeJson(response, 409, {
          error: "Conflict",
          message: `Integration "${existing.name}" is still referenced by ${refCount} agent(s) or project relation(s) and cannot be deleted`,
          referenceCount: refCount,
        });
        return true;
      }
    }
    try {
      if (existing.enabled && deps.pluginManager) {
        await deps.pluginManager.disablePlugin(id);
      }
      await deps.integrationStore.deleteIntegration(id);
      writeJson(response, 200, { deleted: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err }, "delete integration failed");
      writeJson(response, 500, { error: msg });
    }
    return true;
  }

  // ─── Enable / Disable ─────────────────────────────────────────────────────
  const enableMatch = /^\/api\/admin\/integrations\/([^/]+)\/enable$/.exec(path);
  if (enableMatch && method === "PATCH") {
    if (!deps.pluginManager) {
      writeJson(response, 501, { error: "Plugin manager not available" });
      return true;
    }
    const id = decodeURIComponent(enableMatch[1] ?? "");
    try {
      await deps.pluginManager.enablePlugin(id);
      const integration = await deps.integrationStore?.getIntegration(id);
      writeJson(response, 200, { integration: integration ? serializeIntegration(integration, deps.pluginManager, deps.integrationStreams) : { id, enabled: true } });
    } catch (err: unknown) {
      log.warn({ err }, "enable plugin failed");
      writeJson(response, 400, { error: "Operation failed" });
    }
    return true;
  }

  const disableMatch = /^\/api\/admin\/integrations\/([^/]+)\/disable$/.exec(path);
  if (disableMatch && method === "PATCH") {
    if (!deps.pluginManager) {
      writeJson(response, 501, { error: "Plugin manager not available" });
      return true;
    }
    const id = decodeURIComponent(disableMatch[1] ?? "");
    try {
      await deps.pluginManager.disablePlugin(id);
      const integration = await deps.integrationStore?.getIntegration(id);
      writeJson(response, 200, { integration: integration ? serializeIntegration(integration, deps.pluginManager, deps.integrationStreams) : { id, enabled: false } });
    } catch (err: unknown) {
      log.warn({ err }, "disable plugin failed");
      writeJson(response, 400, { error: "Operation failed" });
    }
    return true;
  }

  // ─── Test (by ID) ─────────────────────────────────────────────────────────
  const testMatch = /^\/api\/admin\/integrations\/([^/]+)\/test$/.exec(path);
  if (testMatch && method === "POST") {
    if (!deps.pluginManager) {
      writeJson(response, 501, { error: "Plugin manager not available" });
      return true;
    }
    const id = decodeURIComponent(testMatch[1] ?? "");
    try {
      const result = await deps.pluginManager.testConnection(id);

      // Persist discovered models on successful test
      if (result.success && Array.isArray(result.models) && result.models.length > 0) {
        if (deps.integrationStore && typeof deps.integrationStore.setIntegrationDiscoveredResources === "function") {
          await deps.integrationStore.setIntegrationDiscoveredResources(
            id,
            JSON.stringify({ models: result.models })
          );
        }
      }

      writeJson(response, 200, result);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn({ id, errorMessage }, "test connection failed");
      writeJson(response, 400, { success: false, error: errorMessage, models: [] });
    }
    return true;
  }

  // ─── Models ───────────────────────────────────────────────────────────────
  const modelsMatch = /^\/api\/admin\/integrations\/([^/]+)\/models$/.exec(path);
  if (modelsMatch && method === "GET") {
    if (!deps.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return true;
    }
    const id = decodeURIComponent(modelsMatch[1] ?? "");
    const integration = await deps.integrationStore.getIntegration(id);
    if (!integration) {
      writeJson(response, 404, { error: "Integration not found" });
      return true;
    }
    if (typeof deps.integrationStore.getIntegrationDiscoveredResources === "function") {
      const discovered = await deps.integrationStore.getIntegrationDiscoveredResources(id);
      if (discovered.json) {
        try {
          const parsed = JSON.parse(discovered.json) as unknown;
          if (parsed && typeof parsed === "object" && "models" in parsed && Array.isArray((parsed as Record<string, unknown>)["models"])) {
            writeJson(response, 200, { models: (parsed as Record<string, unknown>)["models"] });
            return true;
          }
        } catch { /* fallthrough to empty */ }
      }
    }
    writeJson(response, 200, { models: [] });
    return true;
  }

  // ─── Discover ─────────────────────────────────────────────────────────────
  const discoverMatch = /^\/api\/admin\/integrations\/([^/]+)\/discover$/.exec(path);
  if (discoverMatch && method === "POST") {
    if (!deps.integrationStore) {
      writeJson(response, 501, { error: "Integration store not available" });
      return true;
    }
    if (typeof deps.integrationStore.setIntegrationDiscoveredResources !== "function") {
      writeJson(response, 501, { error: "Integration store does not support discovery persistence" });
      return true;
    }

    const id = decodeURIComponent(discoverMatch[1] ?? "");
    const integration = await deps.integrationStore.getIntegration(id);
    if (!integration) {
      writeJson(response, 404, { error: "Integration not found" });
      return true;
    }

    const descriptor = getPluginDescriptor(integration.type);

    // ── Copilot: model discovery via OAuth token ──────────────────────────
    if (integration.type === "copilot") {
      let parsedCopilotConfig: Record<string, unknown>;
      try {
        parsedCopilotConfig = JSON.parse(integration.configJson) as Record<string, unknown>;
      } catch {
        writeJson(response, 500, { error: "Stored integration config is not valid JSON" });
        return true;
      }
      const encryptedToken = typeof parsedCopilotConfig["sessionToken"] === "string"
        ? parsedCopilotConfig["sessionToken"]
        : undefined;
      if (!encryptedToken) {
        writeJson(response, 400, {
          error: "No GitHub OAuth token stored. Connect via OAuth first (AI Adapters → Connect with GitHub).",
        });
        return true;
      }
      try {
        const oauthToken = decryptToken(encryptedToken, deps.adminAuthSecret);
        const sessionToken = await exchangeForSessionToken(oauthToken);
        const models = await fetchAvailableModels(sessionToken);
        const discoveredAt = new Date().toISOString();
        const json = JSON.stringify({ models, discoveredAt });
        await deps.integrationStore.setIntegrationDiscoveredResources(id, json);
        writeJson(response, 200, { ok: true, discoveredAt, counts: { models: models.length } });
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn({ id, type: "copilot", errorMessage }, "Copilot model discovery failed");
        writeJson(response, 502, { error: `Model discovery failed: ${errorMessage}` });
      }
      return true;
    }
    // ─────────────────────────────────────────────────────────────────────

    if (!descriptor || typeof descriptor.discoverResources !== "function") {
      writeJson(response, 400, {
        error: `Integration type '${integration.type}' does not support resource discovery`,
      });
      return true;
    }

    let parsedConfig: unknown;
    try {
      parsedConfig = JSON.parse(integration.configJson);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeJson(response, 500, { error: `Stored integration config is not valid JSON: ${msg}` });
      return true;
    }

    // Decrypt password fields so discoverResources receives real credentials.
    // Tokens are stored as encrypted (or plain:-prefixed) strings via encryptToken.
    const decryptedConfig = { ...(parsedConfig as Record<string, unknown>) };
    for (const field of descriptor.requiredFields.filter((f) => f.type === "password")) {
      const raw = decryptedConfig[field.key];
      if (typeof raw === "string" && raw.length > 0) {
        try {
          decryptedConfig[field.key] = decryptToken(raw, deps.adminAuthSecret);
        } catch {
          // Not a managed encrypted token (e.g. a raw PAT) — leave as-is.
        }
      }
    }

    try {
      const snapshot = await descriptor.discoverResources(decryptedConfig);
      const json = JSON.stringify(snapshot);
      await deps.integrationStore.setIntegrationDiscoveredResources(id, json);
      writeJson(response, 200, {
        ok: true,
        discoveredAt: snapshot.discoveredAt,
        counts: {
          ticketProjects: snapshot.ticketProjects?.length ?? 0,
          repositories: snapshot.repositories?.length ?? 0,
        },
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn({ id, type: integration.type, errorMessage }, "resource discovery failed");
      writeJson(response, 502, { error: `Discovery failed: ${errorMessage}` });
    }
    return true;
  }

  return false;
}

// ─── Integration config helpers ─────────────────────────────────────────────

/**
 * Returns the integration's stored config with every `password`-typed field replaced
 * by SECRET_MASK. Safe to send to the browser.
 */
function maskIntegrationConfig(integration: Integration): Record<string, unknown> {
  const descriptor = getPluginDescriptor(integration.type);
  const config = getStoredIntegrationConfig(integration);
  if (!descriptor) {
    return config;
  }

  const masked = { ...config };
  for (const secretField of descriptor.requiredFields.filter((field) => field.type === "password")) {
    const currentValue = masked[secretField.key];
    if (currentValue !== undefined && currentValue !== null && String(currentValue).length > 0) {
      masked[secretField.key] = SECRET_MASK;
    }
  }
  for (const [key, value] of Object.entries(masked)) {
    if (/secret/i.test(key) && value !== undefined && value !== null && String(value).length > 0) {
      masked[key] = SECRET_MASK;
    }
  }
  if (integration.type === "gerrit") {
    delete masked["webhookSecret"];
    delete masked["webhookAllowedIps"];
  }
  if (
    (integration.type === "gitlab-issue" || integration.type === "gitlab-merge-request") &&
    masked["authMode"] === undefined
  ) {
    masked["authMode"] = "pat";
  }
  return masked;
}

/**
 * Merges `updates` into the integration's existing config while preserving secrets.
 */
function mergeIntegrationConfig(integration: Integration, updates: Record<string, unknown>): Record<string, unknown> {
  const descriptor = getPluginDescriptor(integration.type);
  const existingConfig = getStoredIntegrationConfig(integration);
  const merged: Record<string, unknown> = {
    ...existingConfig,
    ...updates,
  };

  if (!descriptor) {
    return merged;
  }

  for (const secretField of descriptor.requiredFields.filter((field) => field.type === "password")) {
    const incomingValue = updates[secretField.key];
    if (
      incomingValue === undefined ||
      incomingValue === null ||
      incomingValue === "" ||
      incomingValue === SECRET_MASK
    ) {
      if (secretField.key in existingConfig) {
        merged[secretField.key] = existingConfig[secretField.key];
      } else {
        delete merged[secretField.key];
      }
    }
  }

  for (const key of Object.keys({ ...existingConfig, ...updates })) {
    if (!/secret/i.test(key)) continue;
    if (descriptor.requiredFields.some((f) => f.key === key && f.type === "password")) continue;
    const incomingValue = updates[key];
    if (
      incomingValue === undefined ||
      incomingValue === null ||
      incomingValue === "" ||
      incomingValue === SECRET_MASK
    ) {
      if (key in existingConfig) {
        merged[key] = existingConfig[key];
      } else {
        delete merged[key];
      }
    }
  }

  return merged;
}

/** Return the integration's stored config with schema-unknown keys stripped. */
function getStoredIntegrationConfig(integration: Integration): Record<string, unknown> {
  return stripUnknownIntegrationConfig(integration.type, parseConfig(integration.configJson));
}

/** Remove any config keys not declared in the integration type's Zod schema. */
function stripUnknownIntegrationConfig(
  type: Integration["type"],
  config: Record<string, unknown>
): Record<string, unknown> {
  const descriptor = getPluginDescriptor(type);
  if (!descriptor || !(descriptor.configSchema instanceof z.ZodObject)) {
    return config;
  }

  const allowedKeys = new Set(descriptor.configSchema.keyof().options);
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (allowedKeys.has(key)) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Validate a config object against a Zod schema.
 * Returns `{ ok: true, data }` on success or `{ ok: false, message }` on failure
 * with a human-readable summary of the validation issues.
 */
function validateIntegrationConfig(
  schema: z.ZodType<unknown>,
  config: Record<string, unknown>,
  partial: boolean
): { ok: true; data: Record<string, unknown> } | { ok: false; message: string } {
  const validationSchema = schema instanceof z.ZodObject
    ? (partial ? schema.strict().partial() : schema.strict())
    : schema;
  const validation = validationSchema.safeParse(config);
  if (!validation.success) {
    return { ok: false, message: formatZodError(validation.error, "Invalid integration config") };
  }

  return { ok: true, data: asRecord(validation.data) };
}

/** Serialize an Integration record to the admin API response shape with masked secrets. */
function serializeIntegration(
  integration: Integration,
  pm?: PluginManager,
  integrationStreams?: { getStatus(integrationId: string): unknown | null }
): Record<string, unknown> {
  const descriptor = getPluginDescriptor(integration.type);
  const active = pm ? pm.isIntegrationActive(integration.id) : false;
  const streamEventsSupported = Boolean(descriptor?.streamEvents);
  return {
    id: integration.id,
    type: integration.type,
    category: descriptor?.category ?? null,
    capabilities: descriptor ? getPluginCapabilities(descriptor) : [],
    name: integration.name,
    enabled: integration.enabled,
    active,
    config: maskIntegrationConfig(integration),
    createdAt: toIsoTimestamp(integration.createdAt),
    updatedAt: toIsoTimestamp(integration.updatedAt),
    discoveredAt: integration.discoveredAt ? toIsoTimestamp(integration.discoveredAt) : null,
    discoveredResources: parseDiscoveredResources(integration.discoveredResourcesJson ?? null),
    discoverySupported: typeof descriptor?.discoverResources === "function",
    streamEventsSupported,
    ...(streamEventsSupported
      ? { streamStatus: integrationStreams?.getStatus(integration.id) ?? null }
      : {}),
  };
}

function serializeOAuthApp(app: OAuthApp): Record<string, unknown> {
  return {
    provider: app.provider,
    baseUrl: app.baseUrl,
    clientId: app.clientId,
    createdAt: toIsoTimestamp(app.createdAt),
    updatedAt: toIsoTimestamp(app.updatedAt),
  };
}

/** Parse a discovered-resources JSON string, returning null on failure or empty input. */
function parseDiscoveredResources(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
