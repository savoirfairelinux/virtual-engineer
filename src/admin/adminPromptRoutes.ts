import { getLogger } from "../logger.js";
import type { AgentRecord, Prompt, PromptStore, PromptType } from "../interfaces.js";
import { writeJson, readBody, toIsoTimestamp, requireStore } from "./adminRouteUtils.js";
import { recordAudit, type AuditCapableStore } from "./adminAudit.js";
import { getAuthContext, getEffectivePermissions, requestCanAccessResource } from "./authContext.js";
import { canAccessResource } from "./authorization/policyEngine.js";
import { BUILT_IN_PROMPT_IDS } from "../domain/prompts.js";
import type { Router } from "./router.js";

const log = getLogger("admin-prompts");

/** Subset of agent-store methods needed for prompt usage lookup. */
export interface PromptRouteAgentStore {
  listAgents(): Promise<AgentRecord[]>;
}

export interface PromptRouteDeps {
  promptStore?: PromptStore | undefined;
  agentStore?: PromptRouteAgentStore | undefined;
  auditStore?: AuditCapableStore | undefined;
}

/** Register prompt routes on the given router. */
export function registerPromptRoutes(router: Router, deps: PromptRouteDeps): void {
  router.add("GET", "/api/admin/prompts", async (req, res, _params) => {
    if (!requireStore(deps.promptStore, res, "Prompt store not available")) return;
    const prompts = await deps.promptStore.getPrompts();
    const perms = getEffectivePermissions(req);
    const actorUserId = getAuthContext(req)?.userId ?? null;
    const visible = perms
      ? prompts.filter((prompt) => canAccessResource(
          perms,
          "prompt.read",
          { type: "prompt", id: prompt.id, ownerUserId: prompt.ownerUserId ?? null },
          actorUserId
        ))
      : prompts;
    writeJson(res, 200, { prompts: visible.map(serializePrompt) });
  }, { permission: "prompt.read", collection: true });

  router.add("POST", "/api/admin/prompts", async (req, res, _params) => {
    if (!requireStore(deps.promptStore, res, "Prompt store not available")) return;
    const body = await readBody(req);
    const label = body?.["label"];
    const content = body?.["content"];
    const promptType = body?.["promptType"];
    if (typeof label !== "string" || label.trim().length === 0) {
      writeJson(res, 400, { error: "Prompt label must be provided as a non-empty string" });
      return;
    }
    if (typeof content !== "string" || content.trim().length === 0) {
      writeJson(res, 400, { error: "Prompt content must be provided as a non-empty string" });
      return;
    }
    if (!isPromptType(promptType)) {
      writeJson(res, 400, { error: "Prompt type must be either 'system' or 'instructions'" });
      return;
    }
    try {
      const prompt = await deps.promptStore.createPrompt(
        label,
        content,
        promptType,
        getAuthContext(req)?.userId ?? null
      );
      log.info({ promptId: prompt.id, label }, "new prompt created via admin API");
      recordAudit(deps.auditStore, req, { action: "prompt.create", targetType: "prompt", targetId: prompt.id, details: { label, promptType } });
      writeJson(res, 201, { prompt: serializePrompt(prompt) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.includes("already exists")) { writeJson(res, 409, { error: msg }); return; }
      if (msg.includes("Invalid prompt id")) { writeJson(res, 400, { error: msg }); return; }
      throw err;
    }
  }, { permission: "prompt.create" });

  // Return the list of agents that reference the given prompt.
  router.add("GET", "/api/admin/prompts/:id/usage", async (req, res, params) => {
    if (!requireStore(deps.promptStore, res, "Prompt store not available")) return;
    const promptId = params["id"] ?? "";
    const prompt = await deps.promptStore.getPrompt(promptId);
    if (!prompt) { writeJson(res, 404, { error: "Prompt not found" }); return; }
    const agents = deps.agentStore ? await deps.agentStore.listAgents() : [];
    const usedBy = agents
      .filter((a) => a.systemPromptId === promptId || a.instructionsPromptId === promptId || a.feedbackInstructionsPromptId === promptId)
      .filter((agent) => requestCanAccessResource(req, "agent.read", {
        type: "agent",
        id: agent.id,
        ownerUserId: agent.ownerUserId ?? null,
      }))
      .map((a) => ({ id: a.id, name: a.name }));
    writeJson(res, 200, { promptId, agents: usedBy });
  }, { permission: "prompt.read", resourceParam: "id" });

  router.add("GET", "/api/admin/prompts/:id", async (_req, res, params) => {
    if (!requireStore(deps.promptStore, res, "Prompt store not available")) return;
    const promptId = params["id"] ?? "";
    const prompt = await deps.promptStore.getPrompt(promptId);
    if (!prompt) { writeJson(res, 404, { error: "Prompt not found" }); return; }
    writeJson(res, 200, { prompt: serializePrompt(prompt) });
  }, { permission: "prompt.read", resourceParam: "id" });

  router.add("PUT", "/api/admin/prompts/:id", async (req, res, params) => {
    if (!requireStore(deps.promptStore, res, "Prompt store not available")) return;
    const promptId = params["id"] ?? "";
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(promptId)) {
      writeJson(res, 404, { error: "Prompt not found" });
      return;
    }
    const existing = await deps.promptStore.getPrompt(promptId);
    if (!existing) { writeJson(res, 404, { error: "Prompt not found" }); return; }
    if (BUILT_IN_PROMPT_IDS.has(promptId)) {
      writeJson(res, 409, { error: "Built-in prompts are read-only. Create a private copy to customize this prompt." });
      return;
    }
    const body = await readBody(req);
    if (!body || typeof body["content"] !== "string") {
      writeJson(res, 400, { error: "Prompt content must be provided as a string" });
      return;
    }
    const newContent = body["content"];
    const prompt = await deps.promptStore.upsertPrompt(promptId, newContent);
    log.warn(
      { promptId, prevLength: existing.content.length, newLength: newContent.length },
      "prompt updated via admin API"
    );
    recordAudit(deps.auditStore, req, { action: "prompt.update", targetType: "prompt", targetId: promptId, details: { label: existing.label } });
    writeJson(res, 200, { prompt: serializePrompt(prompt) });
  }, { permission: "prompt.write", resourceParam: "id" });

  router.add("DELETE", "/api/admin/prompts/:id", async (req, res, params) => {
    if (!requireStore(deps.promptStore, res, "Prompt store not available")) return;
    const promptId = params["id"] ?? "";
    try {
      await deps.promptStore.deletePrompt(promptId);
      log.info({ promptId }, "prompt deleted via admin API");
      recordAudit(deps.auditStore, req, { action: "prompt.delete", targetType: "prompt", targetId: promptId });
      writeJson(res, 204, {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.includes("system prompt") || msg.includes("built-in")) {
        writeJson(res, 409, { error: msg });
        return;
      }
      if (msg.includes("not found")) { writeJson(res, 404, { error: msg }); return; }
      throw err;
    }
  }, { permission: "prompt.delete", resourceParam: "id" });
}

function isPromptType(value: unknown): value is PromptType {
  return value === "system" || value === "instructions";
}

/** Serialize a Prompt to the admin API response shape. */
function serializePrompt(prompt: Prompt): Record<string, unknown> {
  return {
    id: prompt.id,
    label: prompt.label,
    content: prompt.content,
    promptType: prompt.promptType,
    builtin: BUILT_IN_PROMPT_IDS.has(prompt.id),
    ownerUserId: prompt.ownerUserId,
    updatedAt: toIsoTimestamp(prompt.updatedAt),
  };
}
