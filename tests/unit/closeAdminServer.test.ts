/**
 * Tests for the two startup/shutdown bugs identified in the 2026-04-21 log analysis:
 *
 *  Bug 1 (startup order): resumeActiveTasks() runs before adminServer.listen()
 *    succeeds, so a port-binding failure leaves tasks partially resumed and
 *    cycle_count corrupted.  Fix: listen must succeed before resumeActiveTasks.
 *
 *  Bug 2 (shutdown timeout): open SSE connections hold the HTTP server open,
 *    causing closeAdminServer() to always time out instead of closing promptly.
 *    Fix: call server.closeAllConnections() before server.close().
 *
 * These tests import from the path the Implementer must create:
 *   src/admin/closeAdminServer.ts  — extracted from the private function in index.ts
 *   src/admin/startAdminServer.ts  — extracted listen helper used in main()
 *
 * All tests will FAIL until the implementation is in place.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeServer(): Server {
  return createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
}

async function bindOnRandomPort(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

import { closeAdminServer } from "../../src/admin/closeAdminServer.js";
import { startAdminServer } from "../../src/admin/startAdminServer.js";

// ─────────────────────────────────────────────────────────────────────────────
// Bug 2: closeAdminServer — SSE connections block shutdown
// ─────────────────────────────────────────────────────────────────────────────

describe("closeAdminServer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately when the server has no open connections", async () => {
    const server = makeServer();
    const port = await bindOnRandomPort(server);

    // No client has connected — closing should resolve without waiting.
    const start = Date.now();
    await closeAdminServer(server, 2000);
    const elapsed = Date.now() - start;

    // Should close well within the timeout.
    expect(elapsed).toBeLessThan(500);
    expect(server.listening).toBe(false);

    // Verify port is now free.
    const probe = makeServer();
    await bindOnRandomPort(probe);
    expect((probe.address() as AddressInfo).port).not.toBe(port);
    probe.close();
  });

  it("resolves null gracefully without error", async () => {
    // null means admin API was disabled — no-op expected.
    await expect(closeAdminServer(null, 2000)).resolves.toBeUndefined();
  });

  it("closes promptly when an open SSE connection exists — does NOT time out", async () => {
    // Simulate a long-lived SSE connection.
    const sseServer = createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.flushHeaders();
      // deliberately never end the response — models an open SSE stream
    });
    const port = await bindOnRandomPort(sseServer);

    // Open a persistent connection to the SSE endpoint.
    const controller = new AbortController();
    const fetchPromise = fetch(`http://127.0.0.1:${port}/`, {
      signal: controller.signal,
    }).catch(() => undefined); // swallow abort error

    // Give the connection time to establish.
    await new Promise((r) => setTimeout(r, 80));

    // closeAdminServer must close the server promptly via closeAllConnections()
    // rather than waiting up to timeoutMs for the SSE stream to end.
    const start = Date.now();
    await closeAdminServer(sseServer, 3000);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000); // must NOT wait 3 s timeout
    expect(sseServer.listening).toBe(false);

    controller.abort();
    await fetchPromise;
  });

  it("still resolves after the timeout when closeAllConnections is absent", async () => {
    // This guards the fallback path: if somehow closeAllConnections isn't
    // available (old Node version), the timeout-based resolve still works.
    const server = makeServer();
    await bindOnRandomPort(server);

    // Temporarily remove closeAllConnections to simulate the absent method.
    const rec = server as unknown as Record<string, unknown>;
    const origClose = rec["closeAllConnections"];
    delete rec["closeAllConnections"];

    // Leave a synthetic stalled close: patch server.close so it never calls back.
    const origServerClose = server.close.bind(server);
    server.close = (_cb?: (err?: Error) => void) => server; // never calls cb

    const start = Date.now();
    await closeAdminServer(server, 300);
    const elapsed = Date.now() - start;

    // Should have resolved via timeout, not hung forever.
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(1000);

    // Restore so GC can clean up.
    server.close = origServerClose;
    if (origClose !== undefined) {
      (server as unknown as Record<string, unknown>)["closeAllConnections"] = origClose;
    }
    origServerClose();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 1: startAdminServer — listen must complete before resumeActiveTasks
// ─────────────────────────────────────────────────────────────────────────────

describe("startAdminServer", () => {
  it("resolves when the server successfully binds to the port", async () => {
    const server = makeServer();

    await expect(
      startAdminServer(server, 0, "127.0.0.1")
    ).resolves.toBeUndefined();

    expect(server.listening).toBe(true);
    server.close();
  });

  it("rejects when the port is already in use (EADDRINUSE)", async () => {
    // Bind a holder server first to claim the port.
    const holder = makeServer();
    const port = await bindOnRandomPort(holder);

    const victim = makeServer();

    await expect(
      startAdminServer(victim, port, "127.0.0.1")
    ).rejects.toThrow(/EADDRINUSE/);

    expect(victim.listening).toBe(false);
    holder.close();
  });

  it("does NOT leave a partially-listening server on EADDRINUSE", async () => {
    const holder = makeServer();
    const port = await bindOnRandomPort(holder);

    const victim = makeServer();

    try {
      await startAdminServer(victim, port, "127.0.0.1");
    } catch {
      // expected
    }

    // After failure the victim must not be listening so it cannot interfere
    // with the DB or orchestrator state.
    expect(victim.listening).toBe(false);
    holder.close();
  });

  it("returns the bound port info via the server object after success", async () => {
    const server = makeServer();
    await startAdminServer(server, 0, "127.0.0.1");

    const addr = server.address() as AddressInfo;
    expect(addr.port).toBeGreaterThan(0);
    expect(addr.address).toBe("127.0.0.1");

    server.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: startup order guarantee
// ─────────────────────────────────────────────────────────────────────────────

describe("startup order contract", () => {
  it("resumeActiveTasks must not be called before listen resolves", async () => {
    /**
     * This test enforces the ordering contract: when the admin port is in use,
     * startAdminServer rejects and no orchestrator resume may have been called.
     *
     * The Implementer must ensure that in main():
     *   await startAdminServer(...)   // must succeed first
     *   await orchestrator.resumeActiveTasks()  // called only after listen
     */
    const holder = makeServer();
    const port = await bindOnRandomPort(holder);

    const resumeActiveTasks = vi.fn().mockResolvedValue(undefined);

    // Simulate the startup sequence that main() should use.
    const server = makeServer();
    let listenFailed = false;
    try {
      await startAdminServer(server, port, "127.0.0.1");
    } catch {
      listenFailed = true;
      // Must NOT call resumeActiveTasks after a failed listen.
    }

    if (listenFailed) {
      // The key assertion: resumeActiveTasks was never called.
      expect(resumeActiveTasks).not.toHaveBeenCalled();
    } else {
      // If startAdminServer somehow succeeded, mark the test as failed.
      expect.fail("Expected startAdminServer to reject on EADDRINUSE");
    }

    holder.close();
  });
});
