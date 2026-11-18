import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentLogBus } from "../../src/agents/agentEventBus.js";
import { registerStreamRoutes, type StreamRouteDeps } from "../../src/admin/adminStreamRoutes.js";
import { buildEffectivePermissions } from "../../src/admin/authorization/policyEngine.js";
import { getEffectivePermissions, setEffectivePermissions } from "../../src/admin/authContext.js";
import { Router } from "../../src/admin/router.js";
import { makeProjectId, makeTaskId, type AgentCycle, type AgentLogEvent, type Task } from "../../src/interfaces.js";

const task = {
  taskId: makeTaskId("fixture"),
  projectId: makeProjectId("p1"),
  updatedAt: new Date(0),
} as Task;
const scoped = (...projectIds: string[]) => buildEffectivePermissions(
  "viewer", projectIds.map((resourceId) => ({
    id: resourceId, policyId: "test-policy", permission: "task.read", resourceId, createdAt: new Date(0),
  })),
);
const logEvent: AgentLogEvent = {
  type: "log",
  taskId: task.taskId,
  timestamp: "2026-01-01T00:00:00.000Z",
  cycleNumber: 1,
  data: { message: "Local fixture log" },
};

let response: EventEmitter | undefined;
afterEach(() => {
  response?.emit("close");
  vi.useRealTimers();
});

function fixture(path: string) {
  vi.useFakeTimers();
  const router = new Router();
  const req = { url: path, headers: {} } as IncomingMessage;
  const write = vi.fn<(chunk: string) => boolean>().mockReturnValue(true);
  const emitter = new EventEmitter();
  response = emitter;
  const res = Object.assign(emitter, {
    writable: true,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write,
    end: vi.fn(() => { res.writable = false; emitter.emit("close"); }),
  });
  let perms: ReturnType<typeof scoped> | null = scoped("p1", "p2");
  setEffectivePermissions(req, perms);
  const getAllTasks = vi.fn(async () => [task]);
  const getAgentCycles = vi.fn<() => Promise<AgentCycle[]>>().mockResolvedValue([]);
  const refreshAuthorization = vi.fn(async () => perms);
  const deps = {
    stateStore: {
      getTask: vi.fn(async () => task),
      getAgentCycles,
      getAllTasks,
    },
    refreshAuthorization,
  } satisfies StreamRouteDeps & { refreshAuthorization: typeof refreshAuthorization };
  registerStreamRoutes(router, deps);
  return {
    start: () => router.dispatch(req, res as unknown as ServerResponse, path.split("?")[0]!, "GET"),
    req, res, write, getAllTasks, getAgentCycles,
    setPermissions: (value: typeof perms) => { perms = value; },
  };
}

describe("admin SSE authorization guards", () => {
  it.each([
    "/api/admin/events/stream",
    "/api/admin/logs/stream",
    "/api/admin/logs/stream?taskId=fixture",
  ])("closes %s on an idle authorization failure and clears its state", async (path) => {
    const stream = fixture(path);
    const listeners = agentLogBus.listenerCount("event");
    await stream.start();
    expect(stream.write).toHaveBeenCalled();
    stream.write.mockClear();
    stream.setPermissions(null);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(stream.res.end).toHaveBeenCalledOnce();
    expect(stream.write).not.toHaveBeenCalled();
    expect(getEffectivePermissions(stream.req)).toBeUndefined();
    expect(agentLogBus.listenerCount("event")).toBe(listeners);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards a task snapshot when authorization changes while it is being loaded", async () => {
    const stream = fixture("/api/admin/events/stream");
    await stream.start();
    let finish!: (tasks: Task[]) => void;
    stream.getAllTasks.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    stream.write.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    stream.setPermissions(scoped("p2"));
    finish([task]);
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.res.end).toHaveBeenCalledOnce();
    expect(stream.write).not.toHaveBeenCalled();
  });

  it("continues sending task updates while access remains valid", async () => {
    const stream = fixture("/api/admin/events/stream");
    await stream.start();
    stream.write.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stream.write).toHaveBeenCalledWith(expect.stringContaining("event: tasks"));
    expect(stream.res.end).not.toHaveBeenCalled();
  });

  it("discards pending logs if access is revoked during replay preparation", async () => {
    const stream = fixture("/api/admin/logs/stream?taskId=fixture");
    let finish!: (cycles: AgentCycle[]) => void;
    stream.getAgentCycles.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const starting = stream.start();
    await vi.advanceTimersByTimeAsync(0);
    agentLogBus.emit("event", logEvent);
    stream.setPermissions(null);
    finish([]);
    await starting;
    expect(stream.res.end).toHaveBeenCalledOnce();
    expect(stream.write).not.toHaveBeenCalled();
  });

  it.each(["/api/admin/logs/stream", "/api/admin/logs/stream?taskId=fixture"])(
    "rechecks %s on each live event, even after authorizing the same task",
    async (path) => {
      const stream = fixture(path);
      await stream.start();
      stream.write.mockClear();
      agentLogBus.emit("event", logEvent);
      await vi.advanceTimersByTimeAsync(0);
      expect(stream.write).toHaveBeenCalledWith(expect.stringContaining("Local fixture log"));

      stream.write.mockClear();
      stream.setPermissions(scoped("p2"));
      agentLogBus.emit("event", { ...logEvent, data: { message: "Second fixture log" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(stream.res.end).toHaveBeenCalledOnce();
      expect(stream.write).not.toHaveBeenCalled();
    },
  );
});
