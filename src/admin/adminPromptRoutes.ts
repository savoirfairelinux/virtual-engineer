import type { IncomingMessage, ServerResponse } from "node:http";
import { getLogger } from "../logger.js";
import type { AgentRecord, Prompt, PromptStore } from "../interfaces.js";
import { writeJson, readBody, toIsoTimestamp } from "./adminRouteUtils.js";

const log = getLogger("admin-prompts");

/** Subset of agent-store methods needed for prompt usage lookup. */
export interface PromptRouteAgentStore {
  listAgents(): Promise<AgentRecord[]>;
}

export interface PromptRouteDeps {
  promptStore?: PromptStore | undefined;
  agentStore?: PromptRouteAgentStore | undefined;
}

/**
 * Try to handle a prompt-route request. Returns true if the request was
 * handled (response sent), false otherwise.
 */
export async function handlePromptsRoute(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  method: string,
  deps: PromptRouteDeps,
): Promise<boolean> {
  if (path === "/api/admin/prompts") {
    if (!deps.promptStore) {
      writeJson(response, 501, { error: "Prompt store not available" });
      return true;
    }

    if (method === "GET") {
      const prompts = await deps.promptStore.getPrompts();
      writeJson(response, 200, {
        prompts: prompts.map(serializePrompt),
      });
      return true;
    }

    if (method === "POST") {
      const body = await readBody(request);
      const label = body?.["label"];
      const content = body?.["content"];

      if (typeof label !== "string" || label.trim().length === 0) {
        writeJson(response, 400, { error: "Prompt label must be provided as a non-empty string" });
        return true;
      }

      if (typeof content !== "string" || content.trim().length === 0) {
        writeJson(response, 400, { error: "Prompt content must be provided as a non-empty string" });
        return true;
      }

      try {
        const prompt = await deps.promptStore.createPrompt(label, content);
        log.info({ promptId: prompt.id, label }, "new prompt created via admin API");
        writeJson(response, 201, { prompt: serializePrompt(prompt) });
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        if (msg.includes("already exists")) {
          writeJson(response, 409, { error: msg });
          return true;
        }
        if (msg.includes("Invalid prompt id")) {
          writeJson(response, 400, { error: msg });
          return true;
        }
        throw err;
      }
    }

    writeJson(response, 405, { error: "Method not allowed" });
    return true;
  }

  const promptUsageMatch = /^\/api\/admin\/prompts\/([^/]+)\/usage$/.exec(path);
  if (promptUsageMatch) {
    if (!deps.promptStore) {
      writeJson(response, 501, { error: "Prompt store not available" });
      return true;
    }
    if (method !== "GET") {
      writeJson(response, 405, { error: "Method not allowed" });
      return true;
    }

    const promptId = decodeURIComponent(promptUsageMatch[1] ?? "");
    const prompt = await deps.promptStore.getPrompt(promptId);
    if (!prompt) {
      writeJson(response, 404, { error: "Prompt not found" });
      return true;
    }

    const agents = deps.agentStore ? await deps.agentStore.listAgents() : [];
    const usedBy = agents
      .filter((a) => a.systemPromptId === promptId || a.instructionsPromptId === promptId || a.feedbackInstructionsPromptId === promptId)
      .map((a) => ({ id: a.id, name: a.name }));
    writeJson(response, 200, { promptId, agents: usedBy });
    return true;
  }

  const promptMatch = /^\/api\/admin\/prompts\/([^/]+)$/.exec(path);
  if (promptMatch) {
    if (!deps.promptStore) {
      writeJson(response, 501, { error: "Prompt store not available" });
      return true;
    }

    const promptId = decodeURIComponent(promptMatch[1] ?? "");

    if (method === "GET") {
      const prompt = await deps.promptStore.getPrompt(promptId);
      if (!prompt) {
        writeJson(response, 404, { error: "Prompt not found" });
        return true;
      }
      writeJson(response, 200, { prompt: serializePrompt(prompt) });
      return true;
    }

    if (method === "PUT") {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(promptId)) {
        writeJson(response, 404, { error: "Prompt not found" });
        return true;
      }

      const existing = await deps.promptStore.getPrompt(promptId);
      if (!existing) {
        writeJson(response, 404, { error: "Prompt not found" });
        return true;
      }

      const body = await readBody(request);
      if (!body || typeof body["content"] !== "string") {
        writeJson(response, 400, { error: "Prompt content must be provided as a string" });
        return true;
      }

      const newContent = body["content"] as string;
      const prompt = await deps.promptStore.upsertPrompt(promptId, newContent);
      log.warn(
        { promptId, prevLength: existing.content.length, newLength: newContent.length },
        "prompt updated via admin API"
      );
      writeJson(response, 200, { prompt: serializePrompt(prompt) });
      return true;
    }

    if (method === "DELETE") {
      try {
        await deps.promptStore.deletePrompt(promptId);
        log.info({ promptId }, "prompt deleted via admin API");
        writeJson(response, 204, {});
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        if (msg.includes("system prompt") || msg.includes("built-in")) {
          writeJson(response, 409, { error: msg });
          return true;
        }
        if (msg.includes("not found")) {
          writeJson(response, 404, { error: msg });
          return true;
        }
        throw err;
      }
    }

    writeJson(response, 405, { error: "Method not allowed" });
    return true;
  }

  return false;
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
