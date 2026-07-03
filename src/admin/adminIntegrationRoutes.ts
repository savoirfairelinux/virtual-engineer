import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getLogger } from "../logger.js";
import type { Integration, IntegrationStore, OAuthApp, OAuthAppStore, ProviderId } from "../interfaces.js";
import type { PluginManager } from "../plugins/pluginManager.js";
import {
  getAllProviderDescriptors,
  getPluginCapabilities,
  getProviderDescriptor,
  getProviderDomainCapabilities,
  ModelDiscoveryConfigError,
} from "../plugins/registry.js";
import { decryptToken } from "../utils/encryption.js";
import { normalizeGitLabBaseUrl } from "../utils/gitlabAuth.js";
import { writeJson, readBody, asRecord, toIsoTimestamp, SECRET_MASK, parseConfig, formatZodError } from "./adminRouteUtils.js";
import { recordAudit, type AuditCapableStore } from "./adminAudit.js";
import type { Router } from "./router.js";

const log = getLogger("admin-integrations");

export interface IntegrationRouteDeps {
  integrationStore?: IntegrationStore | undefined;
  pluginManager?: PluginManager | undefined;
  oAuthAppStore?: OAuthAppStore | undefined;
  auditStore?: AuditCapableStore | undefined;
  integrationStreams?: { getStatus(integrationId: string): unknown | null } | undefined;
  onIntegrationUpdated?: ((integrationId: string) => void) | undefined;
  adminAuthSecret?: string | undefined;
}

/** Register integration, plugin and OAuth-app routes on the given router. */
export function registerIntegrationRoutes(router: Router, deps: IntegrationRouteDeps): void {
  // ─── Plugin discovery ─────────────────────────────────────────────────────
  router.add("GET", "/api/admin/plugins", async (_req, res, _params) => {
    const descriptors = getAllProviderDescriptors();
    writeJson(res, 200, {
      plugins: descriptors.map((d) => ({
        provider: d.provider,
        name: d.name,
        icon: d.icon ?? null,
        capabilities: getPluginCapabilities(d),
        domainCapabilities: getProviderDomainCapabilities(d),
        requiredFields: d.requiredFields,
        ...(d.oauth !== undefined ? { oauth: d.oauth } : {}),
      })),
    });
  });

  // ─── OAuth Apps ────────────────────────────────────────────────────────────
  router.add("GET", "/api/admin/oauth-apps", async (req, res, _params) => {
    if (!deps.oAuthAppStore) { writeJson(res, 501, { error: "OAuth app registry is not available" }); return; }
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const providerParam = requestUrl.searchParams.get("provider") ?? undefined;
    const apps = await deps.oAuthAppStore.listOAuthApps(providerParam);
    writeJson(res, 200, { apps: apps.map((app) => serializeOAuthApp(app)) });
  });

  router.add("POST", "/api/admin/oauth-apps", async (req, res, _params) => {
    if (!deps.oAuthAppStore) { writeJson(res, 501, { error: "OAuth app registry is not available" }); return; }
    const body = await readBody(req);
    const provider = typeof body?.["provider"] === "string" ? body["provider"] : "gitlab";
    const baseUrl = typeof body?.["baseUrl"] === "string" ? body["baseUrl"] : "";
    const clientId = typeof body?.["clientId"] === "string" ? body["clientId"] : "";
    if (!baseUrl || !clientId) { writeJson(res, 400, { error: "Missing required fields: baseUrl, clientId" }); return; }
    const app = await deps.oAuthAppStore.upsertOAuthApp({ provider, baseUrl: normalizeGitLabBaseUrl(baseUrl), clientId });
    recordAudit(deps.auditStore, req, { action: "oauth_app.create", targetType: "oauth_app", targetId: `${app.provider}:${app.baseUrl}`, details: { provider: app.provider, baseUrl: app.baseUrl } });
    writeJson(res, 201, { app: serializeOAuthApp(app) });
  }, { role: "operator" });

  router.add("DELETE", "/api/admin/oauth-apps", async (req, res, _params) => {
    if (!deps.oAuthAppStore) { writeJson(res, 501, { error: "OAuth app registry is not available" }); return; }
    const body = await readBody(req);
    const provider = typeof body?.["provider"] === "string" ? body["provider"] : "gitlab";
    const baseUrl = typeof body?.["baseUrl"] === "string" ? body["baseUrl"] : "";
    if (!baseUrl) { writeJson(res, 400, { error: "baseUrl is required" }); return; }
    const normalizedBase = normalizeGitLabBaseUrl(baseUrl);
    await deps.oAuthAppStore.deleteOAuthApp(provider, normalizedBase);
    recordAudit(deps.auditStore, req, { action: "oauth_app.delete", targetType: "oauth_app", targetId: `${provider}:${normalizedBase}`, details: { provider, baseUrl: normalizedBase } });
    writeJson(res, 200, { ok: true });
  }, { role: "operator" });

  // Resolve a provider + base URL to its OAuth app registry entry.
  router.add("POST", "/api/admin/oauth-apps/resolve", async (req, res, _params) => {
    if (!deps.oAuthAppStore) { writeJson(res, 501, { error: "OAuth app registry is not available" }); return; }
    const body = await readBody(req);
    const provider = typeof body?.["provider"] === "string" ? body["provider"] : "gitlab";
    const baseUrl = typeof body?.["baseUrl"] === "string" ? body["baseUrl"] : "";
    if (!baseUrl) { writeJson(res, 400, { error: "baseUrl is required" }); return; }
    const normalizedBaseUrl = normalizeGitLabBaseUrl(baseUrl);
    const app = await deps.oAuthAppStore.getOAuthApp(provider, normalizedBaseUrl);
    if (!app) {
      writeJson(res, 404, { error: `No OAuth app is configured for ${provider}:${normalizedBaseUrl}. Ask an administrator to add one in Configuration / OAuth Apps.` });
      return;
    }
    writeJson(res, 200, { app: serializeOAuthApp(app) });
  }, { role: "operator" });

  // ─── Integrations CRUD (exact paths before :id pattern) ──────────────────
  router.add("GET", "/api/admin/integrations", async (_req, res, _params) => {
    if (!deps.integrationStore) { writeJson(res, 501, { error: "Integration store not available" }); return; }
    const list = await deps.integrationStore.getIntegrations();
    writeJson(res, 200, { integrations: list.map((i) => serializeIntegration(i, deps.pluginManager, deps.integrationStreams)) });
  });

  router.add("GET", "/api/admin/integrations/by-category", async (_req, res, _params) => {
    if (!deps.integrationStore) { writeJson(res, 501, { error: "Integration store not available" }); return; }
    const supports = (integration: Integration, capability: string): boolean => {
      const descriptor = getProviderDescriptor(integration.provider);
      return descriptor ? (getProviderDomainCapabilities(descriptor) as string[]).includes(capability) : false;
    };
    const list = await deps.integrationStore.getIntegrations();
    writeJson(res, 200, {
      codeSources: list.filter((i) => supports(i, "code_review") || supports(i, "source_control")).map((i) => serializeIntegration(i, deps.pluginManager, deps.integrationStreams)),
      ticketSources: list.filter((i) => supports(i, "issue_tracking")).map((i) => serializeIntegration(i, deps.pluginManager, deps.integrationStreams)),
    });
  });

  router.add("POST", "/api/admin/integrations", async (req, res, _params) => {
    if (!deps.integrationStore) { writeJson(res, 501, { error: "Integration store not available" }); return; }
    const body = await readBody(req);
    if (!body || !body["provider"] || !body["name"]) {
      writeJson(res, 400, { error: "Missing required fields: provider, name" }); return;
    }
    const provider = body["provider"] as ProviderId;
    const descriptor = getProviderDescriptor(provider);
    if (!descriptor) { writeJson(res, 400, { error: `Unknown provider: ${body["provider"] as string}` }); return; }
    const validatedConfig = validateIntegrationConfig(descriptor.configSchema, asRecord(body["config"]), !descriptor.validateFullConfigOnCreate);
    if (!validatedConfig.ok) {
      writeJson(res, 400, { error: validatedConfig.message || "Invalid integration config" });
      return;
    }
    const id = body["id"] as string || randomUUID();
    try {
      const integration = await deps.integrationStore.upsertIntegration({
        id, provider, name: body["name"] as string, configJson: JSON.stringify(validatedConfig.data), enabled: true,
      });
      if (deps.pluginManager) {
        try {
          await deps.pluginManager.reloadIntegration(id);
        } catch (activationErr: unknown) {
          log.warn({ id, provider, err: activationErr }, "integration created but could not be activated at runtime (incomplete config?)");
        }
      }
      recordAudit(deps.auditStore, req, { action: "integration.create", targetType: "integration", targetId: id, details: { name: integration.name, provider } });
      writeJson(res, 201, { integration: serializeIntegration(integration, deps.pluginManager, deps.integrationStreams) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err }, "create integration failed");
      writeJson(res, 500, { error: msg });
    }
  }, { role: "operator" });

  // test (exact path before :id)
  router.add("POST", "/api/admin/integrations/test", async (req, res, _params) => {
    if (!deps.pluginManager) { writeJson(res, 501, { error: "Plugin manager not available" }); return; }
    const body = (await readBody(req)) ?? {};
    const integrationId = typeof body["integrationId"] === "string" ? body["integrationId"] : undefined;
    const requestedProvider = typeof body["provider"] === "string" ? body["provider"] as ProviderId : undefined;
    const config = asRecord(body["config"]);
    try {
      if (integrationId) {
        if (!deps.integrationStore) { writeJson(res, 501, { error: "Integration store not available" }); return; }
        const existing = await deps.integrationStore.getIntegration(integrationId);
        if (!existing) { writeJson(res, 404, { error: "Integration not found" }); return; }
        if (requestedProvider !== undefined && requestedProvider !== existing.provider) {
          writeJson(res, 400, { error: "Changing integration provider is not supported" }); return;
        }
        const result = await deps.pluginManager.testConnectionConfig(existing.provider, mergeIntegrationConfig(existing, config));
        if (result.success && Array.isArray(result.models) && result.models.length > 0) {
          if (typeof deps.integrationStore.setIntegrationDiscoveredResources === "function") {
            await deps.integrationStore.setIntegrationDiscoveredResources(integrationId, JSON.stringify({ models: result.models }));
          }
        }
        writeJson(res, 200, result);
        return;
      }
      if (!requestedProvider) { writeJson(res, 400, { error: "Provider is required" }); return; }
      const result = await deps.pluginManager.testConnectionConfig(requestedProvider, config);
      writeJson(res, 200, result);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn({ integrationId, requestedProvider, errorMessage }, "config test connection failed");
      writeJson(res, 400, { success: false, error: errorMessage, models: [] });
    }
  }, { role: "operator" });

  // ─── Single integration by ID ─────────────────────────────────────────────
  router.add("GET", "/api/admin/integrations/:id", async (_req, res, params) => {
    if (!deps.integrationStore) { writeJson(res, 501, { error: "Integration store not available" }); return; }
    const id = params["id"] ?? "";
    const integration = await deps.integrationStore.getIntegration(id);
    if (!integration) { writeJson(res, 404, { error: "Integration not found" }); return; }
    writeJson(res, 200, { integration: serializeIntegration(integration, deps.pluginManager, deps.integrationStreams) });
  });

  router.add("PUT", "/api/admin/integrations/:id", async (req, res, params) => {
    if (!deps.integrationStore) { writeJson(res, 501, { error: "Integration store not available" }); return; }
    const id = params["id"] ?? "";
    const existing = await deps.integrationStore.getIntegration(id);
    if (!existing) { writeJson(res, 404, { error: "Integration not found" }); return; }
    const body = await readBody(req);
    if (!body) { writeJson(res, 400, { error: "Request body required" }); return; }
    const requestedProvider = body["provider"] as ProviderId | undefined;
    if (requestedProvider !== undefined && requestedProvider !== existing.provider) {
      writeJson(res, 400, { error: "Changing integration provider is not supported" }); return;
    }
    const nextProvider = existing.provider;
    const descriptor = getProviderDescriptor(nextProvider);
    if (!descriptor) { writeJson(res, 400, { error: `Unknown provider: ${nextProvider}` }); return; }
    const nextConfig = body["config"];
    const mergedConfig = nextConfig === undefined
      ? getStoredIntegrationConfig(existing)
      : mergeIntegrationConfig(existing, asRecord(nextConfig));
    const validatedConfig = validateIntegrationConfig(descriptor.configSchema, mergedConfig, true);
    if (!validatedConfig.ok) { writeJson(res, 400, { error: validatedConfig.message || "Invalid integration config" }); return; }
    try {
      const nextConfigJson = JSON.stringify(validatedConfig.data);
      const configChanged = nextConfig !== undefined && nextConfigJson !== existing.configJson;
      const updated = await deps.integrationStore.upsertIntegration({
        id,
        provider: nextProvider,
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
      recordAudit(deps.auditStore, req, { action: "integration.update", targetType: "integration", targetId: id, details: { name: updated.name, provider: nextProvider, configChanged } });
      writeJson(res, 200, { integration: serializeIntegration(fresh, deps.pluginManager, deps.integrationStreams), appliedAtRuntime });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err }, "update integration failed");
      writeJson(res, 500, { error: msg });
    }
  }, { role: "operator" });

  router.add("DELETE", "/api/admin/integrations/:id", async (req, res, params) => {
    if (!deps.integrationStore) { writeJson(res, 501, { error: "Integration store not available" }); return; }
    const id = params["id"] ?? "";
    const existing = await deps.integrationStore.getIntegration(id);
    if (!existing) { writeJson(res, 404, { error: "Integration not found" }); return; }
    if (deps.integrationStore.countIntegrationReferences) {
      const refCount = await deps.integrationStore.countIntegrationReferences(id);
      if (refCount > 0) {
        writeJson(res, 409, {
          error: "Conflict",
          message: `Integration "${existing.name}" is still referenced by ${refCount} agent(s) or project relation(s) and cannot be deleted`,
          referenceCount: refCount,
        });
        return;
      }
    }
    try {
      if (existing.enabled && deps.pluginManager) await deps.pluginManager.disablePlugin(id);
      await deps.integrationStore.deleteIntegration(id);
      recordAudit(deps.auditStore, req, { action: "integration.delete", targetType: "integration", targetId: id, details: { name: existing.name, provider: existing.provider } });
      writeJson(res, 200, { deleted: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err }, "delete integration failed");
      writeJson(res, 500, { error: msg });
    }
  }, { role: "operator" });

  // ─── Enable / Disable ─────────────────────────────────────────────────────
  router.add("PATCH", "/api/admin/integrations/:id/enable", async (req, res, params) => {
    if (!deps.pluginManager) { writeJson(res, 501, { error: "Plugin manager not available" }); return; }
    const id = params["id"] ?? "";
    try {
      await deps.pluginManager.enablePlugin(id);
      const integration = await deps.integrationStore?.getIntegration(id);
      recordAudit(deps.auditStore, req, { action: "integration.enable", targetType: "integration", targetId: id, details: integration ? { name: integration.name, provider: integration.provider } : {} });
      writeJson(res, 200, { integration: integration ? serializeIntegration(integration, deps.pluginManager, deps.integrationStreams) : { id, enabled: true } });
    } catch (err: unknown) {
      log.warn({ err }, "enable plugin failed");
      writeJson(res, 400, { error: "Operation failed" });
    }
  }, { role: "operator" });

  router.add("PATCH", "/api/admin/integrations/:id/disable", async (req, res, params) => {
    if (!deps.pluginManager) { writeJson(res, 501, { error: "Plugin manager not available" }); return; }
    const id = params["id"] ?? "";
    try {
      await deps.pluginManager.disablePlugin(id);
      const integration = await deps.integrationStore?.getIntegration(id);
      recordAudit(deps.auditStore, req, { action: "integration.disable", targetType: "integration", targetId: id, details: integration ? { name: integration.name, provider: integration.provider } : {} });
      writeJson(res, 200, { integration: integration ? serializeIntegration(integration, deps.pluginManager, deps.integrationStreams) : { id, enabled: false } });
    } catch (err: unknown) {
      log.warn({ err }, "disable plugin failed");
      writeJson(res, 400, { error: "Operation failed" });
    }
  }, { role: "operator" });

  // ─── Test (by ID) ─────────────────────────────────────────────────────────
  router.add("POST", "/api/admin/integrations/:id/test", async (_req, res, params) => {
    if (!deps.pluginManager) { writeJson(res, 501, { error: "Plugin manager not available" }); return; }
    const id = params["id"] ?? "";
    try {
      const result = await deps.pluginManager.testConnection(id);
      if (result.success && Array.isArray(result.models) && result.models.length > 0) {
        if (deps.integrationStore && typeof deps.integrationStore.setIntegrationDiscoveredResources === "function") {
          await deps.integrationStore.setIntegrationDiscoveredResources(id, JSON.stringify({ models: result.models }));
        }
      }
      writeJson(res, 200, result);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn({ id, errorMessage }, "test connection failed");
      writeJson(res, 400, { success: false, error: errorMessage, models: [] });
    }
  }, { role: "operator" });

  // ─── Models ───────────────────────────────────────────────────────────────
  router.add("GET", "/api/admin/integrations/:id/models", async (_req, res, params) => {
    if (!deps.integrationStore) { writeJson(res, 501, { error: "Integration store not available" }); return; }
    const id = params["id"] ?? "";
    const integration = await deps.integrationStore.getIntegration(id);
    if (!integration) { writeJson(res, 404, { error: "Integration not found" }); return; }
    if (typeof deps.integrationStore.getIntegrationDiscoveredResources === "function") {
      const discovered = await deps.integrationStore.getIntegrationDiscoveredResources(id);
      if (discovered.json) {
        try {
          const parsed = JSON.parse(discovered.json) as unknown;
          if (parsed && typeof parsed === "object" && "models" in parsed && Array.isArray((parsed as Record<string, unknown>)["models"])) {
            writeJson(res, 200, { models: (parsed as Record<string, unknown>)["models"] });
            return;
          }
        } catch { /* fallthrough to empty */ }
      }
    }
    writeJson(res, 200, { models: [] });
  });

  // ─── Discover ─────────────────────────────────────────────────────────────
  router.add("POST", "/api/admin/integrations/:id/discover", async (req, res, params) => {
    if (!deps.integrationStore) { writeJson(res, 501, { error: "Integration store not available" }); return; }
    if (typeof deps.integrationStore.setIntegrationDiscoveredResources !== "function") {
      writeJson(res, 501, { error: "Integration store does not support discovery persistence" }); return;
    }
    const id = params["id"] ?? "";
    const integration = await deps.integrationStore.getIntegration(id);
    if (!integration) { writeJson(res, 404, { error: "Integration not found" }); return; }
    const descriptor = getProviderDescriptor(integration.provider);

    // ── Model discovery (e.g. Copilot OAuth or PAT) ─────────────────────
    if (descriptor && typeof descriptor.discoverModels === "function") {
      let parsedModelConfig: unknown;
      try {
        parsedModelConfig = JSON.parse(integration.configJson);
      } catch {
        writeJson(res, 500, { error: "Stored integration config is not valid JSON" }); return;
      }
      try {
        const models = await descriptor.discoverModels(parsedModelConfig);
        const discoveredAt = new Date().toISOString();
        await deps.integrationStore.setIntegrationDiscoveredResources(id, JSON.stringify({ models, discoveredAt }));
        recordAudit(deps.auditStore, req, { action: "integration.discover", targetType: "integration", targetId: id, details: { name: integration.name, provider: integration.provider, models: models.length } });
        writeJson(res, 200, { ok: true, discoveredAt, counts: { models: models.length } });
      } catch (err: unknown) {
        if (err instanceof ModelDiscoveryConfigError) {
          writeJson(res, 400, { error: err.message }); return;
        }
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn({ id, provider: integration.provider, errorMessage }, "model discovery failed");
        writeJson(res, 502, { error: `Model discovery failed: ${errorMessage}` });
      }
      return;
    }
    if (!descriptor || typeof descriptor.discoverResources !== "function") {
      writeJson(res, 400, { error: `Provider '${integration.provider}' does not support resource discovery` }); return;
    }
    let parsedConfig: unknown;
    try {
      parsedConfig = JSON.parse(integration.configJson);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeJson(res, 500, { error: `Stored integration config is not valid JSON: ${msg}` }); return;
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
      await deps.integrationStore.setIntegrationDiscoveredResources(id, JSON.stringify(snapshot));
      recordAudit(deps.auditStore, req, { action: "integration.discover", targetType: "integration", targetId: id, details: { name: integration.name, provider: integration.provider } });
      writeJson(res, 200, {
        ok: true,
        discoveredAt: snapshot.discoveredAt,
        counts: { ticketProjects: snapshot.ticketProjects?.length ?? 0, repositories: snapshot.repositories?.length ?? 0 },
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn({ id, provider: integration.provider, errorMessage }, "resource discovery failed");
      writeJson(res, 502, { error: `Discovery failed: ${errorMessage}` });
    }
  }, { role: "operator" });

  // ─── Branches (per-repository, on-demand) ───────────────────────────────────
  router.add("GET", "/api/admin/integrations/:id/branches", async (req, res, params) => {
    if (!deps.integrationStore) { writeJson(res, 501, { error: "Integration store not available" }); return; }
    const id = params["id"] ?? "";
    const integration = await deps.integrationStore.getIntegration(id);
    if (!integration) { writeJson(res, 404, { error: "Integration not found" }); return; }

    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const repoKey = requestUrl.searchParams.get("repoKey") ?? "";
    if (repoKey.trim().length === 0) {
      writeJson(res, 400, { error: "Missing 'repoKey' query parameter" }); return;
    }

    const descriptor = getProviderDescriptor(integration.provider);
    if (!descriptor || typeof descriptor.discoverBranches !== "function") {
      writeJson(res, 400, { error: `Provider '${integration.provider}' does not support branch discovery` }); return;
    }

    let parsedConfig: unknown;
    try {
      parsedConfig = JSON.parse(integration.configJson);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeJson(res, 500, { error: `Stored integration config is not valid JSON: ${msg}` }); return;
    }

    // Decrypt password fields so discoverBranches receives real credentials.
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
      const branches = await descriptor.discoverBranches(decryptedConfig, repoKey);
      writeJson(res, 200, { branches });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn({ id, provider: integration.provider, repoKey, errorMessage }, "branch discovery failed");
      writeJson(res, 502, { error: `Branch discovery failed: ${errorMessage}` });
    }
  });
}

// ─── Integration config helpers ─────────────────────────────────────────────

/**
 * Returns the integration's stored config with every `password`-typed field replaced
 * by SECRET_MASK. Safe to send to the browser.
 */
function maskIntegrationConfig(integration: Integration): Record<string, unknown> {
  const descriptor = getProviderDescriptor(integration.provider);
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
  // Let the descriptor apply read-time normalisation (e.g. inject defaults or
  // strip transport-only fields) without the route hardcoding provider checks.
  return descriptor.normalizeConfigForRead ? descriptor.normalizeConfigForRead(masked) : masked;
}

/**
 * Merges `updates` into the integration's existing config while preserving secrets.
 */
function mergeIntegrationConfig(integration: Integration, updates: Record<string, unknown>): Record<string, unknown> {
  const descriptor = getProviderDescriptor(integration.provider);
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
  return stripUnknownIntegrationConfig(integration.provider, parseConfig(integration.configJson));
}

/** Remove any config keys not declared in the integration type's Zod schema. */
function stripUnknownIntegrationConfig(
  provider: ProviderId,
  config: Record<string, unknown>
): Record<string, unknown> {
  const descriptor = getProviderDescriptor(provider);
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
  const descriptor = getProviderDescriptor(integration.provider);
  const active = pm ? pm.isIntegrationActive(integration.id) : false;
  const streamEventsSupported = Boolean(descriptor?.capabilities.code_review?.streamEvents);
  return {
    id: integration.id,
    provider: integration.provider,
    icon: descriptor?.icon ?? null,
    capabilities: descriptor ? getPluginCapabilities(descriptor) : [],
    domainCapabilities: descriptor ? getProviderDomainCapabilities(descriptor) : [],
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
