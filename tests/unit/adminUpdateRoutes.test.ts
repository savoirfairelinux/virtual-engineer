import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminServer, type AdminServerDependencies } from "../../src/admin/adminServer.js";
import { createReleaseChecker, type ReleaseCheckResult, type ReleaseChecker } from "../../src/runtime/releaseCheck.js";
import { UpdateHandshakeStore } from "../../src/runtime/updateHandshake.js";
import { requestJson } from "./helpers/adminHttp.js";

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

function latest(version: string | null, error: string | null = null): ReleaseCheckResult {
  return {
    release: version === null ? null : { version, url: `https://github.com/savoirfairelinux/virtual-engineer/releases/tag/v${version}`, publishedAt: undefined },
    error,
    checkedAt: NOW_MS,
  };
}

describe("Admin API — release update routes", () => {
  let dir: string;
  let server: Server;
  let baseUrl: string;
  let releases: ReleaseChecker & { latest: ReturnType<typeof vi.fn> };
  let appendAuditEntry: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ve-update-routes-"));
    releases = { latest: vi.fn(async () => latest("0.4.0")) };
    appendAuditEntry = vi.fn(async () => undefined);
    const deps: AdminServerDependencies = {
      stateStore: { appendAuditEntry } as unknown as AdminServerDependencies["stateStore"],
      allowUnauthenticatedAdmin: true,
      config: { nodeEnv: "test", logLevel: "error", maxAgentCycles: 3, maxRetryAttempts: 5, pollingIntervalMs: 30_000 },
      polling: { isRunning: () => false, getIntervals: () => ({ intervalMs: 30_000 }) },
      providers: [],
      buildInfo: { version: "0.3.0", gitSha: "abc1234", buildDate: undefined },
      updates: { handshake: new UpdateHandshakeStore(dir), releases },
    };
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
    server = createAdminServer(deps);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  async function installUpdater(): Promise<void> {
    await writeFile(join(dir, "updater.installed"), "installed_at=1\n");
  }

  it("reports the running and latest versions and whether the host updater is installed", async () => {
    const r = await requestJson(baseUrl, "GET", "/api/admin/system/update?refresh=1");

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      current: { version: "0.3.0", gitSha: "abc1234" },
      latest: { version: "0.4.0" },
      latestError: null,
      updateAvailable: true,
      updaterInstalled: false,
      request: null,
      status: null,
      inProgress: false,
    });
    expect(releases.latest).toHaveBeenCalledWith({ refresh: true });
  });

  it("does not offer an older or equal release", async () => {
    releases.latest.mockResolvedValue(latest("0.3.0"));
    const r = await requestJson(baseUrl, "GET", "/api/admin/system/update");
    expect(r.body["updateAvailable"]).toBe(false);
  });

  it("records an update request for the host updater and audits it", async () => {
    await installUpdater();

    const r = await requestJson(baseUrl, "POST", "/api/admin/system/update", { body: { version: "0.4.0" } });

    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ inProgress: true, request: { version: "0.4.0", requestedAt: NOW_S } });
    const request = await readFile(join(dir, "update.request"), "utf8");
    expect(request).toMatch(/^version=0\.4\.0\nrequested_by=[A-Za-z0-9._@-]+\nrequested_at=1800000000\n$/);
    expect(appendAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      action: "system.update_requested",
      targetId: "0.4.0",
      details: { from: "0.3.0", to: "0.4.0" },
    }));
  });

  it.each([
    ["a missing updater service", async (): Promise<void> => undefined, "0.4.0", 409, /--install-service/],
    ["an invalid version", installUpdaterFor, "0.4.0;id", 400, /release version/],
    ["a release other than the latest", installUpdaterFor, "0.3.9", 409, /latest release/],
  ])("rejects %s", async (_label, prepare, version, status, error) => {
    await prepare(dir);
    const r = await requestJson(baseUrl, "POST", "/api/admin/system/update", { body: { version } });
    expect(r.status).toBe(status);
    expect(String(r.body["error"])).toMatch(error);
    await expect(readFile(join(dir, "update.request"), "utf8")).rejects.toThrow();
  });

  it("rejects a second request while an update is running, but not after a stale status", async () => {
    await installUpdater();
    await writeFile(join(dir, "update.status"), `state=draining\nfrom=0.3.0\nto=0.4.0\nmessage=Waiting\nupdated_at=${NOW_S - 60}\n`);

    const running = await requestJson(baseUrl, "POST", "/api/admin/system/update", { body: { version: "0.4.0" } });
    expect(running.status).toBe(409);

    await writeFile(join(dir, "update.status"), `state=draining\nfrom=0.3.0\nto=0.4.0\nmessage=Waiting\nupdated_at=${NOW_S - 7 * 3600}\n`);
    const stale = await requestJson(baseUrl, "POST", "/api/admin/system/update", { body: { version: "0.4.0" } });
    expect(stale.status).toBe(202);
  });

  it("surfaces the updater's status file", async () => {
    await writeFile(join(dir, "update.status"), `state=rolled_back\nfrom=0.3.0\nto=0.4.0\nmessage=Health check failed. Restored 0.3.0.\nupdated_at=${NOW_S}\n`);
    const r = await requestJson(baseUrl, "GET", "/api/admin/system/update");
    expect(r.body["status"]).toEqual({
      state: "rolled_back", from: "0.3.0", to: "0.4.0", message: "Health check failed. Restored 0.3.0.", updatedAt: NOW_S,
    });
    expect(r.body["inProgress"]).toBe(false);
  });
});

async function installUpdaterFor(dir: string): Promise<void> {
  await writeFile(join(dir, "updater.installed"), "installed_at=1\n");
}

describe("release checker", () => {
  function response(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  it("caches the latest release and refreshes on demand", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => response(200, {
      tag_name: "v0.4.0", html_url: "https://github.com/savoirfairelinux/virtual-engineer/releases/tag/v0.4.0", published_at: "2026-11-01T00:00:00Z",
    }));
    const checker = createReleaseChecker({ fetch: fetchImpl as unknown as typeof fetch, now: () => now });

    expect((await checker.latest()).release).toEqual({
      version: "0.4.0", url: "https://github.com/savoirfairelinux/virtual-engineer/releases/tag/v0.4.0", publishedAt: "2026-11-01T00:00:00Z",
    });
    now = 30 * 60 * 1000;
    await checker.latest();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await checker.latest({ refresh: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps the last known release when a later check fails", async () => {
    let now = 0;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200, { tag_name: "v0.4.0", html_url: "https://github.com/savoirfairelinux/virtual-engineer/releases/tag/v0.4.0" }))
      .mockResolvedValueOnce(response(503, {}));
    const checker = createReleaseChecker({ fetch: fetchImpl as unknown as typeof fetch, now: () => now });
    await checker.latest();
    now = 2 * 60 * 60 * 1000;

    const result = await checker.latest();

    expect(result.release?.version).toBe("0.4.0");
    expect(result.error).toMatch(/Could not reach GitHub/);
  });

  it.each([
    { tag_name: "latest", html_url: "https://github.com/x" },
    { tag_name: "v1.2.3", html_url: "https://evil.example/v1.2.3" },
  ])("rejects an unexpected release payload %#", async (body) => {
    const checker = createReleaseChecker({ fetch: (async () => response(200, body)) as unknown as typeof fetch });
    expect(await checker.latest()).toMatchObject({ release: null, error: expect.any(String) });
  });
});
