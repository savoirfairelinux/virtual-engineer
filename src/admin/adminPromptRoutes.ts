import { getLogger } from "../logger.js";
import type { AgentRecord, Prompt, PromptStore } from "../interfaces.js";
import { writeJson, readBody, toIsoTimestamp } from "./adminRouteUtils.js";
import { recordAudit, type AuditCapableStore } from "./adminAudit.js";
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
  router.add("GET", "/api/admin/prompts", async (_req, res, _params) => {
    if (!deps.promptStore) { writeJson(res, 501, { error: "Prompt store not available" }); return; }
    const prompts = await deps.promptStore.getPrompts();
    writeJson(res, 200, { prompts: prompts.map(serializePrompt) });
  });

  router.add("POST", "/api/admin/prompts", async (req, res, _params) => {
    if (!deps.promptStore) { writeJson(res, 501, { error: "Prompt store not available" }); return; }
    const body = await readBody(req);
    const label = body?.["label"];
    const content = body?.["content"];
    if (typeof label !== "string" || label.trim().length === 0) {
      writeJson(res, 400, { error: "Prompt label must be provided as a non-empty string" });
      return;
    }
    if (typeof content !== "string" || content.trim().length === 0) {
      writeJson(res, 400, { error: "Prompt content must be provided as a non-empty string" });
      return;
    }
    try {
      const prompt = await deps.promptStore.createPrompt(label, content);
      log.info({ promptId: prompt.id, label }, "new prompt created via admin API");
      recordAudit(deps.auditStore, req, { action: "prompt.create", targetType: "prompt", targetId: prompt.id, details: { label } });
      writeJson(res, 201, { prompt: serializePrompt(prompt) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.includes("already exists")) { writeJson(res, 409, { error: msg }); return; }
      if (msg.includes("Invalid prompt id")) { writeJson(res, 400, { error: msg }); return; }
      throw err;
    }
  });

  // Return the list of agents that reference the given prompt.
  router.add("GET", "/api/admin/prompts/:id/usage", async (_req, res, params) => {
    if (!deps.promptStore) { writeJson(res, 501, { error: "Prompt store not available" }); return; }
    const promptId = params["id"] ?? "";
    const prompt = await deps.promptStore.getPrompt(promptId);
    if (!prompt) { writeJson(res, 404, { error: "Prompt not found" }); return; }
    const agents = deps.agentStore ? await deps.agentStore.listAgents() : [];
    const usedBy = agents
      .filter((a) => a.systemPromptId === promptId || a.instructionsPromptId === promptId || a.feedbackInstructionsPromptId === promptId)
      .map((a) => ({ id: a.id, name: a.name }));
    writeJson(res, 200, { promptId, agents: usedBy });
  });

  router.add("GET", "/api/admin/prompts/:id", async (_req, res, params) => {
    if (!deps.promptStore) { writeJson(res, 501, { error: "Prompt store not available" }); return; }
    const promptId = params["id"] ?? "";
    const prompt = await deps.promptStore.getPrompt(promptId);
    if (!prompt) { writeJson(res, 404, { error: "Prompt not found" }); return; }
    writeJson(res, 200, { prompt: serializePrompt(prompt) });
  });

  router.add("PUT", "/api/admin/prompts/:id", async (req, res, params) => {
    if (!deps.promptStore) { writeJson(res, 501, { error: "Prompt store not available" }); return; }
    const promptId = params["id"] ?? "";
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(promptId)) {
      writeJson(res, 404, { error: "Prompt not found" });
      return;
    }
    const existing = await deps.promptStore.getPrompt(promptId);
    if (!existing) { writeJson(res, 404, { error: "Prompt not found" }); return; }
    const body = await readBody(req);
    if (!body || typeof body["content"] !== "string") {
      writeJson(res, 400, { error: "Prompt content must be provided as a string" });
      return;
    }
    const newContent = body["content"] as string;
    const prompt = await deps.promptStore.upsertPrompt(promptId, newContent);
    log.warn(
      { promptId, prevLength: existing.content.length, newLength: newContent.length },
      "prompt updated via admin API"
    );
    recordAudit(deps.auditStore, req, { action: "prompt.update", targetType: "prompt", targetId: promptId, details: { label: existing.label } });
    writeJson(res, 200, { prompt: serializePrompt(prompt) });
  });

  router.add("DELETE", "/api/admin/prompts/:id", async (req, res, params) => {
    if (!deps.promptStore) { writeJson(res, 501, { error: "Prompt store not available" }); return; }
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
  });
}

/** Serialize a Prompt to the admin API response shape. */
function serializePrompt(prompt: Prompt): Record<string, unknown> {
  return {
    id: prompt.id,
    label: prompt.label,
    content: prompt.content,
    promptType: prompt.promptType,
    updatedAt: toIsoTimestamp(prompt.updatedAt),
  };
}
