import { z } from "zod";
import { getLogger } from "../logger.js";
import { writeJson, readBody, asRecord, SECRET_MASK, parseConfig, zodErrorBody } from "./adminRouteUtils.js";
import { recordAudit, type AuditCapableStore } from "./adminAudit.js";
import {
  makeAgentId,
  type AgentId,
  type AgentRecord,
  type AgentType,
  type OAuthAppStore,
  type IntegrationStore,
  type ProviderId,
  type ProjectRecord,
} from "../interfaces.js";
import {
  defaultProviderAuthService,
  type ProviderAuthService,
} from "../agents/providerAuthService.js";
import { exchangeForSessionToken, fetchAvailableModels, fetchAvailableModelsWithPat } from "../agents/copilotModelsService.js";
import { decryptToken } from "../utils/encryption.js";
import { getProviderDescriptor } from "../plugins/registry.js";
import type { Router } from "./router.js";
import type { PluginManager } from "../plugins/pluginManager.js";

const log = getLogger("admin-agents");

/** Subset of state-store methods required by the agents routes. */
export interface AgentsRouteStore {
  createAgent(input: {
    id?: string;
    name: string;
    type: AgentType;
    modelConfigJson: string;
    integrationId?: string | null;
    systemPromptId?: string | null;
    instructionsPromptId?: string | null;
    feedbackInstructionsPromptId?: string | null;
    maxConcurrent?: number;
    enabled?: boolean;
  }): Promise<AgentRecord>;
  getAgentById(id: AgentId): Promise<AgentRecord | null>;
  listAgents(filter?: { type?: AgentType; enabled?: boolean }): Promise<AgentRecord[]>;
  updateAgent(
    id: AgentId,
    partial: Partial<Pick<AgentRecord, "name" | "type" | "modelConfigJson" | "integrationId" | "systemPromptId" | "instructionsPromptId" | "feedbackInstructionsPromptId" | "maxConcurrent" | "enabled">>
  ): Promise<AgentRecord>;
  deleteAgent(id: AgentId): Promise<void>;
  setAgentEnabled(id: AgentId, enabled: boolean): Promise<void>;
  listProjects(filter?: { type?: AgentType; enabled?: boolean }): Promise<ProjectRecord[]>;
}

export interface AgentsRouteDeps {
    pluginManager?: PluginManager | undefined;
  agentStore?: AgentsRouteStore | undefined;
  integrationStore?: Pick<IntegrationStore, "getIntegration"> | undefined;
  oAuthAppStore?: OAuthAppStore | undefined;
  auditStore?: AuditCapableStore | undefined;
  adminAuthSecret?: string | undefined;
  providerAuthService?: ProviderAuthService | undefined;
}

type PluginOAuthRouteAction = "device-code" | "token" | "start" | "complete";
const VALID_OAUTH_ACTIONS = new Set<string>(["device-code", "token", "start", "complete"]);

class PluginOAuthConfigError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "PluginOAuthConfigError";
  }
}

function mergePluginOAuthConfig(
  pluginType: ProviderId,
  existingConfig: Record<string, unknown>,
  updates: Record<string, unknown>
): Record<string, unknown> {
  const descriptor = getProviderDescriptor(pluginType);
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
    if (!/secret/i.test(key)) {
      continue;
    }
    if (descriptor.requiredFields.some((field) => field.key === key && field.type === "password")) {
      continue;
    }
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

async function resolvePluginOAuthConfig(
  pluginType: ProviderId,
  body: Record<string, unknown>,
  integrationStore?: Pick<IntegrationStore, "getIntegration"> | undefined
): Promise<Record<string, unknown>> {
  const updates = asRecord(body["config"]);
  const integrationId = body["integrationId"];
  if (typeof integrationId !== "string" || !integrationId || !integrationStore) {
    return updates;
  }

  const existing = await integrationStore.getIntegration(integrationId);
  if (!existing) {
    throw new PluginOAuthConfigError("Integration not found", 404);
  }
  if (existing.provider !== pluginType) {
    throw new PluginOAuthConfigError("Integration type mismatch", 400);
  }

  return mergePluginOAuthConfig(pluginType, parseConfig(existing.configJson), updates);
}

/** Detect "secret-like" keys in an arbitrary modelConfig object. */
const SECRET_KEY_PATTERNS = ["token", "password", "secret", "apikey", "key"];

/** Returns true if the field name matches a known secret-key pattern. */
function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

/** Mask all secret-looking string values in a model config object. */
export function maskAgentSecrets(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (isSecretKey(k) && typeof v === "string" && v.length > 0) {
      out[k] = SECRET_MASK;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Merge updates into an existing config, treating SECRET_MASK as "preserve
 * existing value" for any secret-looking key.
 */
export function mergeAgentConfig(
  existing: Record<string, unknown>,
  updates: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(updates)) {
    if (isSecretKey(k) && v === SECRET_MASK) {
      // preserve existing
      continue;
    }
    merged[k] = v;
  }
  return merged;
}

export interface AgentSummary {
  id: string;
  name: string;
  type: AgentType;
  enabled: boolean;
  maxConcurrent: number;
  model: string | null;
  integrationId: string | null;
  systemPromptId: string | null;
  instructionsPromptId: string | null;
  feedbackInstructionsPromptId: string | null;
  projectCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDetail extends AgentSummary {
  modelConfig: Record<string, unknown>;
}

/** Convert an AgentRecord to its summary API shape. */
function toAgentSummary(agent: AgentRecord, projectCount: number): AgentSummary {
  const config = parseConfig(agent.modelConfigJson);
  const model = typeof config["model"] === "string" ? (config["model"] as string) : null;
  return {
    id: agent.id,
    name: agent.name,
    type: agent.type,
    enabled: agent.enabled,
    maxConcurrent: agent.maxConcurrent,
    model,
    integrationId: agent.integrationId,
    systemPromptId: agent.systemPromptId,
    instructionsPromptId: agent.instructionsPromptId,
    feedbackInstructionsPromptId: agent.feedbackInstructionsPromptId,
    projectCount,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

/** Convert an AgentRecord to its full detail API shape with masked model config. */
function toAgentDetail(agent: AgentRecord, projectCount: number): AgentDetail {
  const config = parseConfig(agent.modelConfigJson);
  return {
    ...toAgentSummary(agent, projectCount),
    modelConfig: maskAgentSecrets(config),
  };
}

const createSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, "Agent name is required"),
  type: z.enum(["coding", "review"], {
    errorMap: () => ({ message: "Agent type must be either 'coding' or 'review'" }),
  }),
  modelConfig: z.record(z.unknown()).default({}),
  integrationId: z.string().nullable().optional(),
  systemPromptId: z.string().nullable().optional(),
  instructionsPromptId: z.string().nullable().optional(),
  feedbackInstructionsPromptId: z.string().nullable().optional(),
  maxConcurrent: z.number({ invalid_type_error: "Max concurrent must be a number" }).int("Max concurrent must be an integer").min(1, "Max concurrent must be at least 1").optional(),
  enabled: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1, "Agent name cannot be empty").optional(),
  type: z.enum(["coding", "review"], {
    errorMap: () => ({ message: "Agent type must be either 'coding' or 'review'" }),
  }).optional(),
  modelConfig: z.record(z.unknown()).optional(),
  integrationId: z.string().nullable().optional(),
  systemPromptId: z.string().nullable().optional(),
  instructionsPromptId: z.string().nullable().optional(),
  feedbackInstructionsPromptId: z.string().nullable().optional(),
  maxConcurrent: z.number({ invalid_type_error: "Max concurrent must be a number" }).int("Max concurrent must be an integer").min(1, "Max concurrent must be at least 1").optional(),
  enabled: z.boolean().optional(),
});



/** Count the number of projects that reference the given agent id. */
async function countProjectsForAgent(store: AgentsRouteStore, agentId: AgentId): Promise<number> {
  const all = await store.listProjects();
  return all.filter((p) => p.agentId === agentId).length;
}

/** Register agent and plugin OAuth routes on the given router. */
export function registerAgentRoutes(router: Router, deps: AgentsRouteDeps): void {
  const providerAuthService = deps.providerAuthService ?? defaultProviderAuthService;

  // ── Generic plugin OAuth routes (no agentStore needed) ──────────────────
  router.add("POST", "/api/admin/plugins/:type/oauth/:action", async (req, res, params) => {
    const pluginType = params["type"] as ProviderId ?? "";
    const action = params["action"] ?? "";
    if (!VALID_OAUTH_ACTIONS.has(action)) {
      writeJson(res, 404, { error: "OAuth route not available" }); return;
    }
    const oauthAction = action as PluginOAuthRouteAction;
    const auditOAuth = (): void => recordAudit(deps.auditStore, req, {
      action: "plugin.oauth",
      targetType: "plugin",
      targetId: pluginType,
      details: { provider: pluginType, action: oauthAction },
    });

    const body = (await readBody(req)) ?? {};
    const descriptor = getProviderDescriptor(pluginType);
    let oauthConfig: Record<string, unknown>;
    try {
      oauthConfig = await resolvePluginOAuthConfig(pluginType, body, deps.integrationStore);
      if (descriptor?.resolveOAuthConfig) {
        oauthConfig = await descriptor.resolveOAuthConfig(oauthConfig, { oAuthAppStore: deps.oAuthAppStore });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      writeJson(res, err instanceof PluginOAuthConfigError ? err.statusCode : 400, { error: msg });
      return;
    }

    const oauth = descriptor?.oauth;
    const handler = descriptor?.createOAuthHandler?.(oauthConfig);
    if (!descriptor || !oauth || !handler || oauth.mode !== handler.kind) {
      writeJson(res, 404, { error: "OAuth route not available" }); return;
    }

    if (oauth.mode === "device") {
      if (oauthAction === "device-code") {
        try {
          const result = await providerAuthService.startAuthFlow(handler);
          auditOAuth();
          writeJson(res, 200, result);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn({ err, pluginType }, "provider device flow start failed");
          writeJson(res, 502, { error: msg });
        }
        return;
      }
      if (oauthAction !== "token") { writeJson(res, 404, { error: "OAuth route not available" }); return; }
      const deviceCode = body?.["deviceCode"];
      if (typeof deviceCode !== "string" || !deviceCode) {
        writeJson(res, 400, { error: "deviceCode is required" }); return;
      }
      try {
        const { encryptedToken, isPlaintext } = await providerAuthService.completeAuthFlow(
          handler, { deviceCode }, { adminAuthSecret: deps.adminAuthSecret }
        );
        auditOAuth();
        writeJson(res, 200, { encryptedToken, isPlaintext });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ err, pluginType }, "provider token exchange failed");
        writeJson(res, 502, { error: msg });
      }
      return;
    }

    if (oauthAction === "start") {
      const redirectUri = body?.["redirectUri"];
      const state = body?.["state"];
      const codeChallenge = body?.["codeChallenge"];
      const codeChallengeMethod = body?.["codeChallengeMethod"];
      if (typeof redirectUri !== "string" || !redirectUri) { writeJson(res, 400, { error: "redirectUri is required" }); return; }
      if (state !== undefined && typeof state !== "string") { writeJson(res, 400, { error: "state must be a string" }); return; }
      if (codeChallenge !== undefined && typeof codeChallenge !== "string") { writeJson(res, 400, { error: "codeChallenge must be a string" }); return; }
      if (codeChallengeMethod !== undefined && typeof codeChallengeMethod !== "string") { writeJson(res, 400, { error: "codeChallengeMethod must be a string" }); return; }
      try {
        const result = await providerAuthService.startAuthFlow(handler, {
          redirectUri,
          ...(state !== undefined ? { state } : {}),
          ...(codeChallenge !== undefined ? { codeChallenge } : {}),
          ...(codeChallengeMethod !== undefined ? { codeChallengeMethod } : {}),
        });
        auditOAuth();
        writeJson(res, 200, result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ err, pluginType }, "provider redirect flow start failed");
        writeJson(res, 502, { error: msg });
      }
      return;
    }

    if (oauthAction !== "complete") { writeJson(res, 404, { error: "OAuth route not available" }); return; }
    const code = body?.["code"];
    const state = body?.["state"];
    const redirectUri = body?.["redirectUri"];
    const codeVerifier = body?.["codeVerifier"];
    if (typeof code !== "string" || !code) { writeJson(res, 400, { error: "code is required" }); return; }
    if (typeof redirectUri !== "string" || !redirectUri) { writeJson(res, 400, { error: "redirectUri is required" }); return; }
    if (state !== undefined && typeof state !== "string") { writeJson(res, 400, { error: "state must be a string" }); return; }
    if (codeVerifier !== undefined && typeof codeVerifier !== "string") { writeJson(res, 400, { error: "codeVerifier must be a string" }); return; }
    try {
      const { encryptedToken, isPlaintext } = await providerAuthService.completeAuthFlow(
        handler,
        {
          code, redirectUri,
          ...(state !== undefined ? { state } : {}),
          ...(codeVerifier !== undefined ? { codeVerifier } : {}),
        },
        { adminAuthSecret: deps.adminAuthSecret }
      );
      auditOAuth();
      writeJson(res, 200, { encryptedToken, isPlaintext });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err, pluginType }, "provider redirect completion failed");
      writeJson(res, 502, { error: msg });
    }
  }, { permission: "oauth.manage" });

  // ── Agent CRUD ─────────────────────────────────────────────────────────────
  router.add("GET", "/api/admin/agents", async (_req, res, _params) => {
    if (!deps.agentStore) { writeJson(res, 501, { error: "Agent store not available" }); return; }
    const store = deps.agentStore;
    const agents = await store.listAgents();
    const projects = await store.listProjects();
    const counts = new Map<string, number>();
    for (const p of projects) { counts.set(p.agentId, (counts.get(p.agentId) ?? 0) + 1); }
    writeJson(res, 200, { agents: agents.map((a) => toAgentSummary(a, counts.get(a.id) ?? 0)) });
  }, { permission: "agent.read" });

  router.add("POST", "/api/admin/agents", async (req, res, _params) => {
    if (!deps.agentStore) { writeJson(res, 501, { error: "Agent store not available" }); return; }
    const store = deps.agentStore;
    const body = await readBody(req);
    if (!body) { writeJson(res, 400, { error: "Request body required" }); return; }
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) { writeJson(res, 400, zodErrorBody(parsed.error, "Invalid agent payload")); return; }
    try {
      const created = await store.createAgent({
        ...(parsed.data.id !== undefined ? { id: parsed.data.id } : {}),
        name: parsed.data.name,
        type: parsed.data.type,
        modelConfigJson: JSON.stringify(parsed.data.modelConfig ?? {}),
        ...(parsed.data.integrationId !== undefined ? { integrationId: parsed.data.integrationId } : {}),
        ...(parsed.data.systemPromptId !== undefined ? { systemPromptId: parsed.data.systemPromptId } : {}),
        ...(parsed.data.instructionsPromptId !== undefined ? { instructionsPromptId: parsed.data.instructionsPromptId } : {}),
        ...(parsed.data.feedbackInstructionsPromptId !== undefined ? { feedbackInstructionsPromptId: parsed.data.feedbackInstructionsPromptId } : {}),
        ...(parsed.data.maxConcurrent !== undefined ? { maxConcurrent: parsed.data.maxConcurrent } : {}),
        ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
      });
      recordAudit(deps.auditStore, req, { action: "agent.create", targetType: "agent", targetId: created.id, details: { name: created.name, type: created.type } });
      log.info(
        {
          agentId: created.id,
          name: created.name,
          type: created.type,
          integrationId: created.integrationId,
        },
        "agent created"
      );
      writeJson(res, 201, { agent: toAgentDetail(created, 0) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err }, "create agent failed");
      writeJson(res, 500, { error: msg });
    }
  }, { permission: "agent.write" });

  // /agents/:id/available-models has a distinct path shape from /agents/:id (anchored regex), so registration order does not matter here
  router.add("GET", "/api/admin/agents/:id/available-models", async (_req, res, params) => {
    if (!deps.agentStore) { writeJson(res, 501, { error: "Agent store not available" }); return; }
    const id = makeAgentId(params["id"] ?? "");
    const agent = await deps.agentStore.getAgentById(id);
    if (!agent) { writeJson(res, 404, { error: "Agent not found" }); return; }
    let configJson: Record<string, unknown> = {};
    try {
      configJson = agent.modelConfigJson
        ? (JSON.parse(agent.modelConfigJson) as Record<string, unknown>)
        : {};
    } catch {
      // ignore parse errors
    }
    // PAT mode: resolve token from linked integration; OAuth: fall back to agent's sessionToken
    let githubToken: string | undefined;
    let isPat = false;
    if (agent.integrationId && deps.integrationStore) {
      const integration = await deps.integrationStore.getIntegration(agent.integrationId);
      if (integration) {
        let integrationConfig: Record<string, unknown> = {};
        try {
          integrationConfig = deps.pluginManager
            ? deps.pluginManager.decryptIntegrationConfig(integration)
            : JSON.parse(integration.configJson) as Record<string, unknown>;
        } catch { /* ignore */ }
        if (integrationConfig["authMode"] === "pat") {
          const pat = typeof integrationConfig["token"] === "string" ? integrationConfig["token"].trim() : "";
          if (!pat) {
            writeJson(res, 400, { error: "No PAT configured for the linked integration" });
            return;
          }
          githubToken = pat;
          isPat = true;
        }
      }
    }
    if (githubToken === undefined) {
      const encrypted = typeof configJson["sessionToken"] === "string" ? configJson["sessionToken"] : undefined;
      if (!encrypted) {
        writeJson(res, 400, { error: "No session token configured for this agent" });
        return;
      }
      githubToken = decryptToken(encrypted, deps.adminAuthSecret);
    }
    try {
      // PAT: use the @github/copilot-sdk CopilotClient which spawns the
      //      bundled CLI and handles its own token exchange internally.
      //      OAuth: exchange the user token for a short-lived session token
      //      first, then call the Copilot models HTTP API.
      const models = isPat
        ? await fetchAvailableModelsWithPat(githubToken)
        : await fetchAvailableModels(await exchangeForSessionToken(githubToken));
      writeJson(res, 200, { models });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err }, "fetch available models failed");
      writeJson(res, 502, { error: msg });
    }
  }, { permission: "agent.read", resourceParam: "id" });

  router.add("GET", "/api/admin/agents/:id", async (_req, res, params) => {
    if (!deps.agentStore) { writeJson(res, 501, { error: "Agent store not available" }); return; }
    const store = deps.agentStore;
    const id = makeAgentId(params["id"] ?? "");
    const existing = await store.getAgentById(id);
    if (!existing) { writeJson(res, 404, { error: "Agent not found" }); return; }
    const count = await countProjectsForAgent(store, id);
    writeJson(res, 200, { agent: toAgentDetail(existing, count) });
  }, { permission: "agent.read", resourceParam: "id" });

  router.add("PUT", "/api/admin/agents/:id", async (req, res, params) => {
    if (!deps.agentStore) { writeJson(res, 501, { error: "Agent store not available" }); return; }
    const store = deps.agentStore;
    const id = makeAgentId(params["id"] ?? "");
    const existing = await store.getAgentById(id);
    if (!existing) { writeJson(res, 404, { error: "Agent not found" }); return; }
    const body = await readBody(req);
    if (!body) { writeJson(res, 400, { error: "Request body required" }); return; }
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) { writeJson(res, 400, zodErrorBody(parsed.error, "Invalid agent payload")); return; }
    const updates: Parameters<AgentsRouteStore["updateAgent"]>[1] = {};
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.type !== undefined) updates.type = parsed.data.type;
    if (parsed.data.modelConfig !== undefined) {
      const existingConfig = parseConfig(existing.modelConfigJson);
      updates.modelConfigJson = JSON.stringify(mergeAgentConfig(existingConfig, parsed.data.modelConfig));
    }
    if (parsed.data.integrationId !== undefined) updates.integrationId = parsed.data.integrationId;
    if (parsed.data.systemPromptId !== undefined) updates.systemPromptId = parsed.data.systemPromptId;
    if (parsed.data.instructionsPromptId !== undefined) updates.instructionsPromptId = parsed.data.instructionsPromptId;
    if (parsed.data.feedbackInstructionsPromptId !== undefined) updates.feedbackInstructionsPromptId = parsed.data.feedbackInstructionsPromptId;
    if (parsed.data.maxConcurrent !== undefined) updates.maxConcurrent = parsed.data.maxConcurrent;
    if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;
    try {
      const updated = await store.updateAgent(id, updates);
      const count = await countProjectsForAgent(store, id);
      recordAudit(deps.auditStore, req, { action: "agent.update", targetType: "agent", targetId: id, details: { name: updated.name, type: updated.type } });
      writeJson(res, 200, { agent: toAgentDetail(updated, count) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err, id }, "update agent failed");
      writeJson(res, 500, { error: msg });
    }
  }, { permission: "agent.write", resourceParam: "id" });

  router.add("DELETE", "/api/admin/agents/:id", async (req, res, params) => {
    if (!deps.agentStore) { writeJson(res, 501, { error: "Agent store not available" }); return; }
    const store = deps.agentStore;
    const id = makeAgentId(params["id"] ?? "");
    const existing = await store.getAgentById(id);
    if (!existing) { writeJson(res, 404, { error: "Agent not found" }); return; }
    const count = await countProjectsForAgent(store, id);
    if (count > 0) {
      writeJson(res, 409, {
        error: "Conflict",
        message: `Agent ${id} is referenced by ${count} project(s) and cannot be deleted`,
        referencedByProjects: count,
      });
      return;
    }
    try {
      await store.deleteAgent(id);
      recordAudit(deps.auditStore, req, { action: "agent.delete", targetType: "agent", targetId: id, details: { name: existing.name, type: existing.type } });
      res.statusCode = 204;
      res.end();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err, id }, "delete agent failed");
      writeJson(res, 500, { error: msg });
    }
  }, { permission: "agent.delete", resourceParam: "id" });

  router.add("PATCH", "/api/admin/agents/:id/enable", async (req, res, params) => {
    if (!deps.agentStore) { writeJson(res, 501, { error: "Agent store not available" }); return; }
    const store = deps.agentStore;
    const id = makeAgentId(params["id"] ?? "");
    const existing = await store.getAgentById(id);
    if (!existing) { writeJson(res, 404, { error: "Agent not found" }); return; }
    await store.setAgentEnabled(id, true);
    recordAudit(deps.auditStore, req, { action: "agent.enable", targetType: "agent", targetId: id, details: { name: existing.name } });
    res.statusCode = 204;
    res.end();
  }, { permission: "agent.operate", resourceParam: "id" });

  router.add("PATCH", "/api/admin/agents/:id/disable", async (req, res, params) => {
    if (!deps.agentStore) { writeJson(res, 501, { error: "Agent store not available" }); return; }
    const store = deps.agentStore;
    const id = makeAgentId(params["id"] ?? "");
    const existing = await store.getAgentById(id);
    if (!existing) { writeJson(res, 404, { error: "Agent not found" }); return; }
    await store.setAgentEnabled(id, false);
    recordAudit(deps.auditStore, req, { action: "agent.disable", targetType: "agent", targetId: id, details: { name: existing.name } });
    res.statusCode = 204;
    res.end();
  }, { permission: "agent.operate", resourceParam: "id" });
}
