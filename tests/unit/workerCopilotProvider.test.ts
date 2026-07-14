import { describe, expect, it } from "vitest";
import {
  buildCopilotCliArgs,
  buildCopilotNetworkEnvironment,
} from "../../agent-worker/src/copilotCliArgs.js";
import {
  buildCopilotSessionConfig,
  extractToolName,
  initializeCopilotClient,
} from "../../agent-worker/src/providers/copilot.js";

describe("Copilot worker provider", () => {
  it("leaves authentication to the external CLI", () => {
    const config = buildCopilotSessionConfig(
      {
        model: "gpt-5-mini",
        systemPrompt: "Return structured review JSON.",
        cwd: "/sandbox/review",
        timeoutMs: 1_000,
        mode: "review",
      }
    );

    expect(config).not.toHaveProperty("gitHubToken");
  });

  it("tells the local CLI which environment variable contains its auth token", () => {
    expect(buildCopilotCliArgs(3000)).toEqual([
      "--headless",
      "--no-auto-update",
      "--port",
      "3000",
      "--auth-token-env",
      "GITHUB_TOKEN",
      "--no-auto-login",
    ]);
  });

  it("forwards OpenShell proxy and CA trust into the native CLI", () => {
    expect(buildCopilotNetworkEnvironment({
      HTTPS_PROXY: "http://10.200.0.1:3128",
      NODE_EXTRA_CA_CERTS: "/etc/openshell-tls/openshell-ca.pem",
      SSL_CERT_FILE: "/etc/openshell-tls/ca-bundle.pem",
      GITHUB_TOKEN: "must-not-be-copied-by-this-helper",
    })).toEqual({
      HTTPS_PROXY: "http://10.200.0.1:3128",
      NODE_EXTRA_CA_CERTS: "/etc/openshell-tls/openshell-ca.pem",
      SSL_CERT_FILE: "/etc/openshell-tls/ca-bundle.pem",
    });
  });

  it("resolves the external CLI identity before session creation", async () => {
    let started = false;
    let authCheckedAfterStart = false;

    await initializeCopilotClient({
      start: async () => {
        started = true;
      },
      getAuthStatus: async () => {
        authCheckedAfterStart = started;
        return { isAuthenticated: true, authType: "env" };
      },
    });

    expect(started).toBe(true);
    expect(authCheckedAfterStart).toBe(true);
  });

  it("rejects an unauthenticated external CLI", async () => {
    await expect(initializeCopilotClient({
      start: async () => undefined,
      getAuthStatus: async () => ({
        isAuthenticated: false,
        authType: "env",
        statusMessage: "Authentication required",
      }),
    })).rejects.toThrow("Authentication required");
  });

  it.each([
    [{ name: "read_file" }, "read_file"],
    [{ toolName: "shell_exec" }, "shell_exec"],
    [{ tool: { name: "write_file" } }, "write_file"],
    [{ toolCall: { function: { name: "search_code" } } }, "search_code"],
    [{ functionName: "apply_patch" }, "apply_patch"],
  ])("extracts a precise tool name from SDK event shapes", (event, expected) => {
    expect(extractToolName(event)).toBe(expected);
  });

  it("does not invent an unknown tool name when the SDK omits it", () => {
    expect(extractToolName({ status: "running", message: "working" })).toBeNull();
  });
});