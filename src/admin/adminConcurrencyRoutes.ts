import type { IncomingMessage, ServerResponse } from "node:http";
import { writeJson, readBody } from "./adminRouteUtils.js";

export interface ConcurrencyRouteDeps {
  concurrency?: {
    getGlobalLimit(): Promise<number | null>;
    setGlobalLimit(value: number | null): Promise<void>;
    snapshot(): { global: number; perProject: Record<string, number>; perAgent: Record<string, number> };
  } | undefined;
}

/**
 * Try to handle a concurrency-route request. Returns true if the request was
 * handled (response sent), false otherwise.
 */
export async function handleConcurrencyRoute(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  method: string,
  deps: ConcurrencyRouteDeps,
): Promise<boolean> {
  if (path !== "/api/admin/concurrency") {
    return false;
  }

  if (!deps.concurrency) {
    writeJson(response, 501, { error: "Concurrency tracker not available" });
    return true;
  }

  if (method === "GET") {
    const global = await deps.concurrency.getGlobalLimit();
    writeJson(response, 200, {
      global,
      snapshot: deps.concurrency.snapshot(),
    });
    return true;
  }

  if (method === "PUT") {
    let body: Record<string, unknown> | null;
    try {
      body = await readBody(request);
    } catch {
      writeJson(response, 400, { error: "Invalid JSON body" });
      return true;
    }
    const value = body?.["global"];
    let next: number | null;
    if (value === null) {
      next = null;
    } else if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      next = Math.floor(value);
    } else {
      writeJson(response, 400, { error: "global must be a non-negative number or null" });
      return true;
    }
    await deps.concurrency.setGlobalLimit(next);
    writeJson(response, 200, {
      global: next,
      snapshot: deps.concurrency.snapshot(),
    });
    return true;
  }

  writeJson(response, 405, { error: "Method not allowed" });
  return true;
}
