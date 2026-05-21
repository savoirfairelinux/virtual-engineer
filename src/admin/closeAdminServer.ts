import type { Server } from "node:http";
import { getLogger } from "../logger.js";

const log = getLogger("main");

/**
 * Gracefully close the admin HTTP server.
 * Calls `closeAllConnections()` first so long-lived SSE connections don't block shutdown.
 * Resolves after the server stops listening or after `timeoutMs`. Never rejects.
 */
export function closeAdminServer(server: Server | null, timeoutMs: number): Promise<void> {
  if (!server) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      log.warn({ timeoutMs }, "admin server close timed out; continuing shutdown");
      resolve();
    }, timeoutMs);

    // Close all keep-alive / SSE connections so server.close() can resolve
    // promptly rather than waiting for every stream to drain.
    if (typeof (server as unknown as Record<string, unknown>)["closeAllConnections"] === "function") {
      (server as unknown as { closeAllConnections(): void }).closeAllConnections();
    }

    try {
      server.close(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      log.warn({ err }, "admin server close failed; continuing shutdown");
      resolve();
    }
  });
}
