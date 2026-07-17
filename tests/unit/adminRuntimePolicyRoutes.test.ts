import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createAdminServer } from "../../src/admin/adminServer.js";
import { SqliteStateStore } from "../../src/state/stateStore.js";

function tempDbPath(): string {
  return join(tmpdir(), `ve-runtime-policy-routes-${randomUUID()}.db`);
}

describe("Admin API — runtime policy bindings", () => {
  let store: SqliteStateStore;
  let server: ReturnType<typeof createAdminServer>;
  let baseUrl: string;

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDbPath());
    server = createAdminServer({
      stateStore: store,
      integrationStore: store,
      promptStore: store,
      projectStore: store,
      agentStore: store,
      runtimePolicyStore: store,
      config: {
        nodeEnv: "test",
        logLevel: "error",
        maxAgentCycles: 3,
        maxRetryAttempts: 5,
        pollingIntervalMs: 30_000,
      },
      polling: { isRunning: () => true, getIntervals: () => ({ intervalMs: 30_000 }) },
      providers: [],
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });

  it("lists persisted bindings for a policy", async () => {
    const agent = await store.createAgent({ name: "agent", type: "coding", modelConfigJson: "{}" });
    const policy = await store.createRuntimePolicy({
      name: "network-deny",
      kind: "network",
      yaml: "network_policies: {}\n",
    });
    const binding = await store.bindRuntimePolicy({ policyId: policy.id, agentId: agent.id });

    const response = await fetch(`${baseUrl}/api/admin/runtime/policies/${policy.id}/bindings`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { bindings: Array<{ id: string; agentId: string | null }> };
    expect(body.bindings).toEqual([expect.objectContaining({ id: binding.id, agentId: agent.id })]);
  });
});