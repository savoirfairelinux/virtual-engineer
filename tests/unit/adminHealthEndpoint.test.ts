import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAdminServer } from "../../src/admin/adminServer.js";
import type { AdminRuntimeConfig } from "../../src/admin/adminServer.js";
import type { StateStore, IntegrationStore } from "../../src/interfaces.js";
import type { AddressInfo } from "net";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";

describe("Admin Server - Unauthenticated Health Endpoint", () => {
  let server: Awaited<ReturnType<typeof createAdminServer>> | null = null;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join("/tmp", "ve-test-"));
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should return 200 OK on GET /health without authentication", async () => {
    // Setup minimal config (no auth)
    const config: AdminRuntimeConfig = {
      nodeEnv: "test",
      logLevel: "error",
      maxAgentCycles: 3,
      maxRetryAttempts: 5,
      pollingIntervalMs: 30_000,
      adminAuthSecret: undefined, // No auth required
    };

    // Setup mock dependencies
    const polling = {
      isRunning: () => true,
      getIntervals: () => ({ intervalMs: 30000 }),
    };

    // Create a minimal stateStore mock (just needs to exist)
    const stateStore = {
      // Minimal mock
    } as unknown as StateStore;

    const integrationStore = {
      // Minimal mock
    } as unknown as IntegrationStore;

    server = createAdminServer({
      polling,
      stateStore,
      integrationStore,
      config,
      providers: [],
    });

    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    if (!addr) throw new Error("Server failed to bind");
    const baseUrl = `http://${addr.address}:${addr.port}`;

    // Test: GET /health should return 200 without auth header
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json).toHaveProperty("status", "ok");
    expect(json).toHaveProperty("timestamp");
  });

  it("should reject non-GET requests to /health with 405", async () => {
    const config: AdminRuntimeConfig = {
      nodeEnv: "test",
      logLevel: "error",
      maxAgentCycles: 3,
      maxRetryAttempts: 5,
      pollingIntervalMs: 30_000,
      adminAuthSecret: undefined,
    };

    const polling = {
      isRunning: () => true,
      getIntervals: () => ({ intervalMs: 30000 }),
    };

    const stateStore = {} as unknown as StateStore;
    const integrationStore = {} as unknown as IntegrationStore;

    server = createAdminServer({
      polling,
      stateStore,
      integrationStore,
      config,
      providers: [],
    });

    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    if (!addr) throw new Error("Server failed to bind");
    const baseUrl = `http://${addr.address}:${addr.port}`;

    // Test: POST /health should return 405
    const response = await fetch(`${baseUrl}/health`, { method: "POST" });
    expect(response.status).toBe(405);
  });
});
