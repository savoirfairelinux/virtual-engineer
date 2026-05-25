import type { IncomingMessage, ServerResponse } from "node:http";
import { writeJson } from "./adminRouteUtils.js";

export interface ConcurrencyRouteDeps {
  concurrency?: {
    /** Live in-memory run-slot counters keyed by integration id. */
    snapshot(): { global: number; perProject: Record<string, number>; perAgent: Record<string, number> };
  } | undefined;
}

/**
 * Try to handle a concurrency-route request. Returns true if the request was
 * handled (response sent), false otherwise.
 */
export async function handleConcurrencyRoute(
  _request: IncomingMessage,
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
    writeJson(response, 200, { snapshot: deps.concurrency.snapshot() });
    return true;
  }

  writeJson(response, 405, { error: "Method not allowed" });
  return true;
}
