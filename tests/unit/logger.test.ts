import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { childLogger, rootLogger, pinoMock } = vi.hoisted(() => {
  const childLogger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
  const rootLogger = {
    child: vi.fn(() => childLogger),
  };
  const pinoMock = vi.fn(() => rootLogger);

  return { childLogger, rootLogger, pinoMock };
});

vi.mock("pino", () => ({
  default: pinoMock,
}));

describe("getLogger", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv["NODE_ENV"] = process.env["NODE_ENV"];
    savedEnv["LOG_LEVEL"] = process.env["LOG_LEVEL"];

    delete process.env["NODE_ENV"];
    delete process.env["LOG_LEVEL"];

    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    vi.resetModules();
  });

  it("defaults to a silent logger in test when LOG_LEVEL is not set", async () => {
    process.env["NODE_ENV"] = "test";

    const { getLogger } = await import("../../src/logger.js");
    const logger = getLogger("polling-loop");

    expect(logger).toBe(childLogger);
    expect(pinoMock).toHaveBeenCalledWith(expect.objectContaining({
      level: "silent",
      base: { pid: process.pid },
    }));
    expect(rootLogger.child).toHaveBeenCalledWith({ component: "polling-loop" });
  });

  it("honors an explicit LOG_LEVEL override in test", async () => {
    process.env["NODE_ENV"] = "test";
    process.env["LOG_LEVEL"] = "debug";

    const { getLogger } = await import("../../src/logger.js");
    getLogger("orchestrator");

    expect(pinoMock).toHaveBeenCalledWith(expect.objectContaining({
      level: "debug",
    }));
  });
});