import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type {
  Integration,
  IntegrationReferenceDetails,
  OAuthApp,
} from "../../interfaces.js";
import { normalizeGitLabBaseUrl } from "../../utils/gitlabAuth.js";
import {
  agents,
  integrations,
  oauthApps,
  projectIntegrationBindings,
  projectPushTargets,
  projects,
} from "../schema.js";
import * as schema from "../schema.js";

export interface IntegrationStoreApi {
  getIntegrations(): Promise<Integration[]>;
  getIntegration(id: string): Promise<Integration | null>;
  upsertIntegration(data: Omit<Integration, "createdAt" | "updatedAt">): Promise<Integration>;
  deleteIntegration(id: string): Promise<void>;
  getIntegrationReferenceDetails(id: string): Promise<IntegrationReferenceDetails>;
  countIntegrationReferences(id: string): Promise<number>;
  setIntegrationEnabled(id: string, enabled: boolean): Promise<Integration>;
  listOAuthApps(provider?: string): Promise<OAuthApp[]>;
  getOAuthApp(provider: string, baseUrl: string): Promise<OAuthApp | null>;
  upsertOAuthApp(app: Omit<OAuthApp, "createdAt" | "updatedAt">): Promise<OAuthApp>;
  deleteOAuthApp(provider: string, baseUrl: string): Promise<void>;
  setIntegrationDiscoveredResources(id: string, json: string): Promise<void>;
  getIntegrationDiscoveredResources(id: string): Promise<{ json: string | null; at: Date | null }>;
  clearIntegrationDiscoveredResources(id: string): Promise<void>;
}

interface IntegrationStoreContext {
  db: BetterSQLite3Database<typeof schema>;
}

export function createIntegrationStore(context: IntegrationStoreContext): IntegrationStoreApi {
  const { db } = context;

  function rowToIntegration(row: typeof integrations.$inferSelect): Integration {
    return {
      id: row.id,
      provider: row.provider,
      name: row.name,
      configJson: row.configJson,
      enabled: row.enabled === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      discoveredResourcesJson: row.discoveredResourcesJson ?? null,
      discoveredAt: row.discoveredAt ?? null,
    };
  }

  function rowToOAuthApp(row: typeof oauthApps.$inferSelect): OAuthApp {
    return {
      provider: row.provider,
      baseUrl: row.baseUrl,
      clientId: row.clientId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function getIntegrations(): Promise<Integration[]> {
    const rows = await db.query.integrations.findMany();
    return rows.map((row) => rowToIntegration(row));
  }

  async function getIntegration(id: string): Promise<Integration | null> {
    const row = await db.query.integrations.findFirst({
      where: eq(integrations.id, id),
    });
    return row ? rowToIntegration(row) : null;
  }

  async function upsertIntegration(data: Omit<Integration, "createdAt" | "updatedAt">): Promise<Integration> {
    const now = new Date();
    const existing = await getIntegration(data.id);
    if (existing) {
      await db
        .update(integrations)
        .set({
          provider: data.provider,
          name: data.name,
          configJson: data.configJson,
          enabled: data.enabled ? 1 : 0,
          updatedAt: now,
        })
        .where(eq(integrations.id, data.id));
    } else {
      await db.insert(integrations).values({
        id: data.id,
        provider: data.provider,
        name: data.name,
        configJson: data.configJson,
        enabled: data.enabled ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      });
    }
    const result = await getIntegration(data.id);
    if (!result) throw new Error(`Failed to upsert integration ${data.id}`);
    return result;
  }

  async function deleteIntegration(id: string): Promise<void> {
    await db.delete(integrations).where(eq(integrations.id, id));
  }

  async function getIntegrationReferenceDetails(id: string): Promise<IntegrationReferenceDetails> {
    const [agentRows, bindingRows, pushRows] = await Promise.all([
      db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(eq(agents.integrationId, id)),
      db
        .select({
          projectId: projectIntegrationBindings.projectId,
          projectName: projects.name,
          capability: projectIntegrationBindings.capability,
        })
        .from(projectIntegrationBindings)
        .innerJoin(projects, eq(projectIntegrationBindings.projectId, projects.id))
        .where(eq(projectIntegrationBindings.integrationId, id)),
      db
        .select({
          projectId: projectPushTargets.projectId,
          projectName: projects.name,
          repoKey: projectPushTargets.repoKey,
        })
        .from(projectPushTargets)
        .innerJoin(projects, eq(projectPushTargets.projectId, projects.id))
        .where(eq(projectPushTargets.integrationId, id)),
    ]);
    return {
      agents: agentRows,
      projectBindings: bindingRows,
      projectPushTargets: pushRows,
    };
  }

  async function countIntegrationReferences(id: string): Promise<number> {
    const references = await getIntegrationReferenceDetails(id);
    return references.agents.length + references.projectBindings.length + references.projectPushTargets.length;
  }

  async function setIntegrationEnabled(id: string, enabled: boolean): Promise<Integration> {
    const existing = await getIntegration(id);
    if (!existing) throw new Error(`Integration not found: ${id}`);
    await db
      .update(integrations)
      .set({ enabled: enabled ? 1 : 0, updatedAt: new Date() })
      .where(eq(integrations.id, id));
    const result = await getIntegration(id);
    if (!result) throw new Error(`Integration disappeared after update: ${id}`);
    return result;
  }

  async function listOAuthApps(provider?: string): Promise<OAuthApp[]> {
    const rows = provider
      ? await db.query.oauthApps.findMany({ where: eq(oauthApps.provider, provider) })
      : await db.query.oauthApps.findMany();
    return rows.map((row) => rowToOAuthApp(row));
  }

  async function getOAuthApp(provider: string, baseUrl: string): Promise<OAuthApp | null> {
    const normalizedBaseUrl = normalizeGitLabBaseUrl(baseUrl);
    const row = await db.query.oauthApps.findFirst({
      where: and(eq(oauthApps.provider, provider), eq(oauthApps.baseUrl, normalizedBaseUrl)),
    });
    return row ? rowToOAuthApp(row) : null;
  }

  async function upsertOAuthApp(app: Omit<OAuthApp, "createdAt" | "updatedAt">): Promise<OAuthApp> {
    const normalizedBaseUrl = normalizeGitLabBaseUrl(app.baseUrl);
    const now = new Date();
    await db
      .insert(oauthApps)
      .values({
        provider: app.provider,
        baseUrl: normalizedBaseUrl,
        clientId: app.clientId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [oauthApps.provider, oauthApps.baseUrl],
        set: { clientId: app.clientId, updatedAt: now },
      });
    const result = await getOAuthApp(app.provider, normalizedBaseUrl);
    if (!result) throw new Error(`Failed to upsert OAuth app ${app.provider}:${normalizedBaseUrl}`);
    return result;
  }

  async function deleteOAuthApp(provider: string, baseUrl: string): Promise<void> {
    const normalizedBaseUrl = normalizeGitLabBaseUrl(baseUrl);
    await db.delete(oauthApps).where(
      and(eq(oauthApps.provider, provider), eq(oauthApps.baseUrl, normalizedBaseUrl))
    );
  }

  async function setIntegrationDiscoveredResources(id: string, json: string): Promise<void> {
    const existing = await getIntegration(id);
    if (!existing) throw new Error(`Integration not found: ${id}`);
    const now = new Date();
    await db
      .update(integrations)
      .set({ discoveredResourcesJson: json, discoveredAt: now, updatedAt: now })
      .where(eq(integrations.id, id));
  }

  async function getIntegrationDiscoveredResources(id: string): Promise<{ json: string | null; at: Date | null }> {
    const row = await db.query.integrations.findFirst({ where: eq(integrations.id, id) });
    if (!row) return { json: null, at: null };
    return {
      json: row.discoveredResourcesJson ?? null,
      at: row.discoveredAt ?? null,
    };
  }

  async function clearIntegrationDiscoveredResources(id: string): Promise<void> {
    await db
      .update(integrations)
      .set({ discoveredResourcesJson: null, discoveredAt: null, updatedAt: new Date() })
      .where(eq(integrations.id, id));
  }

  return {
    getIntegrations,
    getIntegration,
    upsertIntegration,
    deleteIntegration,
    getIntegrationReferenceDetails,
    countIntegrationReferences,
    setIntegrationEnabled,
    listOAuthApps,
    getOAuthApp,
    upsertOAuthApp,
    deleteOAuthApp,
    setIntegrationDiscoveredResources,
    getIntegrationDiscoveredResources,
    clearIntegrationDiscoveredResources,
  };
}
