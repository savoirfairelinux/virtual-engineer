import type { Server } from "node:http";

/**
 * Bind the admin HTTP server to the given port and host.
 * Rejects with the underlying Error (including `EADDRINUSE`) when the port cannot be claimed.
 */
export function startAdminServer(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    /** Reject the promise and clean up the listening listener. */
    function handleError(err: Error): void {
      server.off("listening", handleListening);
      reject(err);
    }

    /** Resolve the promise and clean up the error listener. */
    function handleListening(): void {
      server.off("error", handleError);
      resolve();
    }

    server.once("error", handleError);
    server.listen(port, host, handleListening);
  });
}
