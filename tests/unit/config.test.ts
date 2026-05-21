import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getConfig, resetConfig } from "../../src/config.js";

describe("getConfig", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    const allKeys = [
      "NODE_ENV",
      "LOG_LEVEL",
      "DATABASE_PATH",
      "AGENT_MODE",
      "ADMIN_API_ENABLED",
      "ADMIN_API_HOST",
      "ADMIN_API_PORT",
      "ADMIN_AUTH_SECRET",
      "POLLING_INTERVAL_MS",
      "MAX_AGENT_CYCLES",
      "MAX_RETRY_ATTEMPTS",
      "MAX_COMMITS_PER_CYCLE",
      "AGENT_TIMEOUT_MS",
      "AGENT_CONTAINER_IMAGE",
      "WORKSPACE_BASE_DIR",
      "AGENT_DOCKER_NETWORK",
    ];
    for (const key of allKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    resetConfig();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    resetConfig();
  });

  // ─── Happy path ────────────────────────────────────────────────────────────

  it("returns a valid config with no env vars set", () => {
    const config = getConfig();
    expect(config.nodeEnv).toBe("development");
  });

  it("is cached — second call returns the same object", () => {
    const a = getConfig();
    const b = getConfig();
    expect(a).toBe(b);
  });

  it("cache is cleared by resetConfig", () => {
    getConfig();
    resetConfig();
    const fresh = getConfig();
    expect(fresh).toBeDefined();
  });

  // ─── Defaults ──────────────────────────────────────────────────────────────

  describe("default values", () => {
    it("nodeEnv defaults to development", () => {
      expect(getConfig().nodeEnv).toBe("development");
    });

    it("logLevel defaults to info", () => {
      expect(getConfig().logLevel).toBe("info");
    });

    it("adminApiEnabled defaults to true", () => {
      expect(getConfig().adminApiEnabled).toBe(true);
    });

    it("adminApiHost defaults to 127.0.0.1", () => {
      expect(getConfig().adminApiHost).toBe("127.0.0.1");
    });

    it("adminApiPort defaults to 3100", () => {
      expect(getConfig().adminApiPort).toBe(3100);
    });

    it("maxAgentCycles defaults to 3", () => {
      expect(getConfig().maxAgentCycles).toBe(3);
    });

    it("maxRetryAttempts defaults to 5", () => {
      expect(getConfig().maxRetryAttempts).toBe(5);
    });

    it("maxCommitsPerCycle defaults to 10", () => {
      expect(getConfig().maxCommitsPerCycle).toBe(10);
    });

    it("pollingIntervalMs defaults to 30000", () => {
      expect(getConfig().pollingIntervalMs).toBe(30_000);
    });

    it("agentTimeoutMs defaults to 3600000", () => {
      expect(getConfig().agentTimeoutMs).toBe(3_600_000);
    });

    it("databasePath defaults to ./data/virtual-engineer.db", () => {
      expect(getConfig().databasePath).toBe("./data/virtual-engineer.db");
    });

    it("agentContainerImage defaults to virtual-engineer-workspace:latest", () => {
      expect(getConfig().agentContainerImage).toBe("virtual-engineer-workspace:latest");
    });

    it("workspaceBaseDir defaults to /tmp/virtual-engineer/workspaces", () => {
      expect(getConfig().workspaceBaseDir).toBe("/tmp/virtual-engineer/workspaces");
    });

    it("agentDockerNetwork defaults to virtual-engineer_ve-agent-net", () => {
      expect(getConfig().agentDockerNetwork).toBe("virtual-engineer_ve-agent-net");
    });
  });

  // ─── Overrides ─────────────────────────────────────────────────────────────

  describe("env var overrides", () => {
    it("reads NODE_ENV", () => {
      process.env["NODE_ENV"] = "test";
      resetConfig();
      expect(getConfig().nodeEnv).toBe("test");
    });

    it("parses ADMIN_API_ENABLED=false", () => {
      process.env["ADMIN_API_ENABLED"] = "false";
      resetConfig();
      expect(getConfig().adminApiEnabled).toBe(false);
    });

    it("coerces MAX_AGENT_CYCLES to number", () => {
      process.env["MAX_AGENT_CYCLES"] = "7";
      resetConfig();
      expect(getConfig().maxAgentCycles).toBe(7);
    });

    it("reads POLLING_INTERVAL_MS", () => {
      process.env["POLLING_INTERVAL_MS"] = "60000";
      resetConfig();
      expect(getConfig().pollingIntervalMs).toBe(60_000);
    });

    it("reads AGENT_DOCKER_NETWORK", () => {
      process.env["AGENT_DOCKER_NETWORK"] = "bridge";
      resetConfig();
      expect(getConfig().agentDockerNetwork).toBe("bridge");
    });
  });

  // ─── Validation errors ─────────────────────────────────────────────────────

  describe("validation errors", () => {
    it("throws when NODE_ENV has invalid value", () => {
      process.env["NODE_ENV"] = "staging";
      resetConfig();
      expect(() => getConfig()).toThrow(/Invalid configuration/);
    });

    it("throws when ADMIN_API_PORT is not a positive integer", () => {
      process.env["ADMIN_API_PORT"] = "0";
      resetConfig();
      expect(() => getConfig()).toThrow(/Invalid configuration/);
    });
  });
});

