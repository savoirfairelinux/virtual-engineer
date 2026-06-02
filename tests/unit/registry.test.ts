import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getPluginDescriptor, getAllPluginDescriptors, getPluginCapabilities } from "../../src/plugins/registry.js";
import { redmineDescriptor } from "../../src/plugins/descriptors/redmine.js";
import { gerritDescriptor } from "../../src/plugins/descriptors/gerrit.js";
import { createCopilotDescriptor } from "../../src/plugins/descriptors/copilot.js";
import { gitlabIssueDescriptor } from "../../src/plugins/descriptors/gitlab-issue.js";
import { gitlabMergeRequestDescriptor } from "../../src/plugins/descriptors/gitlab-merge-request.js";
import { mockDescriptor } from "../../src/plugins/descriptors/mock.js";
import { registerBuiltinPlugins } from "../../src/plugins/init.js";

describe("Plugin Registry", () => {
  beforeEach(() => {
    // Register all builtins so tests have a populated registry
    registerBuiltinPlugins();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("registers all builtin plugin types", () => {
    const types = getAllPluginDescriptors().map(d => d.type);
    expect(types).toContain("redmine");
    expect(types).toContain("gerrit");
    expect(types).toContain("gitlab-issue");
    expect(types).toContain("gitlab-merge-request");
    expect(types).toContain("copilot");
    expect(types).toContain("mock");
  });

  it("returns all descriptors", () => {
    const all = getAllPluginDescriptors();
    expect(all.length).toBeGreaterThanOrEqual(6);
  });

  it("returns undefined for unknown type", () => {
    const result = getPluginDescriptor("unknown" as never);
    expect(result).toBeUndefined();
  });

  describe("redmine descriptor", () => {
    it("has correct metadata", () => {
      const desc = getPluginDescriptor("redmine");
      expect(desc?.name).toBe("Redmine");
      expect(desc?.category).toBe("ticketing");
      expect(desc?.requiredFields.length).toBeGreaterThan(0);
    });

    it("validates valid redmine config", () => {
      const result = redmineDescriptor.configSchema.safeParse({
        baseUrl: "http://redmine:3000",
        apiKey: "abc123",
        virtualEngineerUserLogin: "ve",
      });
      expect(result.success).toBe(true);
    });

    it("rejects invalid redmine config", () => {
      const result = redmineDescriptor.configSchema.safeParse({
        baseUrl: "not-a-url",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("gerrit descriptor", () => {
    it("has correct metadata", () => {
      const desc = getPluginDescriptor("gerrit");
      expect(desc?.name).toBe("Gerrit");
      expect(desc?.category).toBe("review");
    });

    it("validates valid gerrit config (SSH only)", () => {
      const result = gerritDescriptor.configSchema.safeParse({
        sshHost: "gerrit",
        sshPort: 29418,
        sshUser: "admin",
        sshKeyPath: "/path/key",
      });
      expect(result.success).toBe(true);
    });

    it("validates gerrit config with optional HTTP fields", () => {
      const result = gerritDescriptor.configSchema.safeParse({
        sshHost: "gerrit",
        sshPort: 29418,
        sshUser: "admin",
        sshKeyPath: "/path/key",
        baseUrl: "http://gerrit:8080",
        httpUsername: "admin",
        httpPassword: "pass",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("gitlab issue descriptor", () => {
    it("has correct metadata", () => {
      const desc = getPluginDescriptor("gitlab-issue");
      expect(desc?.name).toBe("GitLab Issues");
      expect(desc?.category).toBe("ticketing");
    });

    it("validates valid gitlab issue PAT config", () => {
      const result = gitlabIssueDescriptor.configSchema.safeParse({
        baseUrl: "https://gitlab.example.com",
        authMode: "pat",
        token: "token-123",
      });
      expect(result.success).toBe(true);
    });

    it("validates valid gitlab issue OAuth config", () => {
      const result = gitlabIssueDescriptor.configSchema.safeParse({
        baseUrl: "https://gitlab.example.com",
        authMode: "oauth",
        token: "oauth-token",
      });
      expect(result.success).toBe(true);
    });

    it("declares device OAuth metadata gated by authMode", () => {
      const desc = getPluginDescriptor("gitlab-issue");

      expect(desc?.oauth).toMatchObject({
        mode: "device",
        tokenField: "token",
        providerName: "GitLab",
        startPath: "/api/admin/plugins/gitlab-issue/oauth/device-code",
        completePath: "/api/admin/plugins/gitlab-issue/oauth/token",
        dependsOn: {
          field: "authMode",
          value: "oauth",
        },
      });
    });

    it("exposes gitlab auth fields without an OAuth client secret input", () => {
      const fieldKeys = gitlabIssueDescriptor.requiredFields.map((field) => field.key);

      expect(fieldKeys).toContain("authMode");
      expect(fieldKeys).toContain("token");
      expect(fieldKeys).toContain("gitlabMode");
      expect(fieldKeys).toContain("oauthClientId");
      expect(fieldKeys).not.toContain("projectId");
      expect(fieldKeys).not.toContain("closedStatusId");
      expect(fieldKeys).not.toContain("inProgressStatusId");
      expect(fieldKeys).not.toContain("inReviewStatusId");
      expect(fieldKeys).not.toContain("inProgressLabel");
      expect(fieldKeys).not.toContain("inReviewLabel");
      expect(fieldKeys).not.toContain("oauthClientSecret");
    });

    it("provides a device OAuth handler that starts device authorization", async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).includes("authorize_device")) {
          return new Response(JSON.stringify({
            device_code: "dc_123",
            user_code: "ABCD-1234",
            verification_uri: "https://gitlab.example.com/oauth/device",
            expires_in: 300,
            interval: 5,
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ access_token: "oauth-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const desc = getPluginDescriptor("gitlab-issue");
      const handler = desc?.createOAuthHandler?.({
        baseUrl: "https://gitlab.example.com",
        oauthClientId: "client-id",
        gitlabMode: "self-hosted",
      });

      expect(handler).toMatchObject({ kind: "device" });
      if (!handler || handler.kind !== "device") {
        throw new Error("Expected a device OAuth handler");
      }

      const startResult = await handler.start();
      expect(startResult).toEqual({
        deviceCode: "dc_123",
        userCode: "ABCD-1234",
        verificationUri: "https://gitlab.example.com/oauth/device",
        expiresIn: 300,
        interval: 5,
      });

      const startFetchCall = fetchMock.mock.calls[0];
      expect(startFetchCall).toBeDefined();
      const [startUrl, startInit] = startFetchCall as unknown as [string, RequestInit & { body?: URLSearchParams | string }];
      expect(startUrl).toBe("https://gitlab.example.com/oauth/authorize_device");
      expect(startInit.method).toBe("POST");
      const startBody = startInit.body instanceof URLSearchParams ? startInit.body.toString() : String(startInit.body);
      expect(startBody).toContain("client_id=client-id");
      expect(startBody).toContain("scope=read_user+read_api+read_repository");

      const completeResult = await handler.complete({ deviceCode: "dc_123" });
      expect(completeResult).toEqual({ token: "oauth-token" });
    });

    it("retries on authorization_pending and eventually succeeds", async () => {
      vi.useFakeTimers();
      let tokenCallCount = 0;
      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).includes("authorize_device")) {
          return new Response(JSON.stringify({
            device_code: "dc_123",
            user_code: "ABCD-1234",
            verification_uri: "https://gitlab.example.com/oauth/device",
            expires_in: 300,
            interval: 1,
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        tokenCallCount++;
        if (tokenCallCount === 1) {
          return new Response(JSON.stringify({ error: "authorization_pending" }), {
            status: 400, headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ access_token: "retried-token" }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const desc = getPluginDescriptor("gitlab-issue");
      const handler = desc?.createOAuthHandler?.({
        baseUrl: "https://gitlab.example.com",
        oauthClientId: "client-id",
        gitlabMode: "self-hosted",
      });
      if (!handler || handler.kind !== "device") throw new Error("Expected device handler");

      await handler.start();
      const completePromise = handler.complete({ deviceCode: "dc_123" });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await completePromise;
      expect(result).toEqual({ token: "retried-token" });
      vi.useRealTimers();
    });

    it("returns a guided OAuth message when testConnection is run before OAuth completion", async () => {
      await expect(gitlabIssueDescriptor.testConnection?.({
        baseUrl: "https://gitlab.example.com",
        authMode: "oauth",
      })).resolves.toEqual({
        success: false,
        error: "GitLab OAuth is not connected. Complete the OAuth flow or reconnect the integration, then run Test Connection again.",
      });
    });

    it("derives ticketing, discovery, and oauth capabilities", () => {
      expect(getPluginCapabilities(gitlabIssueDescriptor)).toEqual(
        expect.arrayContaining(["ticketing", "discovery", "oauth"])
      );
    });
  });

  describe("gitlab merge request descriptor", () => {
    it("has correct metadata", () => {
      const desc = getPluginDescriptor("gitlab-merge-request");
      expect(desc?.name).toBe("GitLab Merge Requests");
      expect(desc?.category).toBe("review");
    });

    it("validates valid gitlab merge request PAT config", () => {
      const result = gitlabMergeRequestDescriptor.configSchema.safeParse({
        baseUrl: "https://gitlab.example.com",
        authMode: "pat",
        token: "token-123",
      });
      expect(result.success).toBe(true);
    });

    it("validates valid gitlab merge request OAuth config", () => {
      const result = gitlabMergeRequestDescriptor.configSchema.safeParse({
        baseUrl: "https://gitlab.example.com",
        authMode: "oauth",
        token: "oauth-token",
      });
      expect(result.success).toBe(true);
    });

    it("declares device OAuth metadata gated by authMode", () => {
      const desc = getPluginDescriptor("gitlab-merge-request");

      expect(desc?.oauth).toMatchObject({
        mode: "device",
        tokenField: "token",
        providerName: "GitLab",
        startPath: "/api/admin/plugins/gitlab-merge-request/oauth/device-code",
        completePath: "/api/admin/plugins/gitlab-merge-request/oauth/token",
        dependsOn: {
          field: "authMode",
          value: "oauth",
        },
      });
    });

    it("reuses gitlab auth fields without an OAuth client secret input", () => {
      const fieldKeys = gitlabMergeRequestDescriptor.requiredFields.map((field) => field.key);

      expect(fieldKeys).toContain("authMode");
      expect(fieldKeys).toContain("token");
      expect(fieldKeys).toContain("gitlabMode");
      expect(fieldKeys).toContain("oauthClientId");
      expect(fieldKeys).not.toContain("projectId");
      expect(fieldKeys).not.toContain("oauthClientSecret");
    });

    it("derives review, discovery, vcs, and oauth capabilities", () => {
      expect(getPluginCapabilities(gitlabMergeRequestDescriptor)).toEqual(
        expect.arrayContaining(["review", "discovery", "vcs", "oauth"])
      );
    });

    it("returns a guided OAuth message when testConnection is run before OAuth completion", async () => {
      await expect(gitlabMergeRequestDescriptor.testConnection?.({
        baseUrl: "https://gitlab.example.com",
        authMode: "oauth",
      })).resolves.toEqual({
        success: false,
        error: "GitLab OAuth is not connected. Complete the OAuth flow or reconnect the integration, then run Test Connection again.",
      });
    });
  });

  describe("copilot descriptor", () => {
    it("has correct metadata", () => {
      const desc = getPluginDescriptor("copilot");
      expect(desc?.name).toBe("GitHub Copilot");
      expect(desc?.category).toBe("agent");
    });

    it("declares OAuth metadata for generic dashboard wiring", () => {
      const desc = getPluginDescriptor("copilot");

      expect(desc?.oauth).toMatchObject({
        mode: "device",
        tokenField: "sessionToken",
        providerName: "GitHub",
        heading: "GitHub Copilot Authentication",
        connectLabel: "Connect with GitHub",
        reconnectLabel: "Re-connect",
        pendingLabel: "Waiting…",
        startPath: "/api/admin/plugins/copilot/oauth/device-code",
        completePath: "/api/admin/plugins/copilot/oauth/token",
      });
    });

    it("provides an OAuth handler through the descriptor", () => {
      const desc = getPluginDescriptor("copilot");
      const handler = desc?.createOAuthHandler?.();

      expect(handler).toMatchObject({ kind: "device" });
      expect(typeof handler?.start).toBe("function");
      expect(typeof handler?.complete).toBe("function");
    });

    it("derives agent and oauth capabilities", () => {
      const desc = getPluginDescriptor("copilot");

      expect(desc).toBeDefined();
      expect(getPluginCapabilities(desc!)).toEqual(
        expect.arrayContaining(["agent", "oauth"])
      );
    });

    it("has a hidden sessionToken field for server-side masking (OAuth button handles auth)", () => {
      const desc = getPluginDescriptor("copilot");

      // The session token field is declared so the server can mask/preserve it,
      // but is hidden from the admin UI (the OAuth button writes it directly).
      expect(desc?.requiredFields).toEqual(expect.arrayContaining([
        expect.objectContaining({
          key: "sessionToken",
          type: "password",
          hidden: true,
        }),
      ]));
      expect(desc?.requiredFields).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "model" }),
      ]));
    });

    it("accepts empty copilot config (sessionToken is optional)", () => {
      const copilotDescriptor = createCopilotDescriptor();
      const result = copilotDescriptor.configSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("accepts a sessionToken in copilot config", () => {
      const copilotDescriptor = createCopilotDescriptor();
      expect(copilotDescriptor.configSchema.parse({ sessionToken: "encrypted_tok" })).toMatchObject({
        sessionToken: "encrypted_tok",
      });
    });

    it("ignores integration-level model in copilot config", () => {
      const copilotDescriptor = createCopilotDescriptor();
      const parsed = copilotDescriptor.configSchema.parse({
        sessionToken: "tok",
        model: "auto",
      });

      expect(parsed).toMatchObject({
        sessionToken: "tok",
      });
      // model should be transformed to undefined
      expect(parsed.model).toBeUndefined();
    });

    it("defaults authMode to oauth when not specified", () => {
      const copilotDescriptor = createCopilotDescriptor();
      const parsed = copilotDescriptor.configSchema.parse({});
      expect(parsed.authMode).toBe("oauth");
    });

    it("accepts authMode pat with a token", () => {
      const copilotDescriptor = createCopilotDescriptor();
      const parsed = copilotDescriptor.configSchema.parse({
        authMode: "pat",
        token: "ghp_my_pat_token",
      });
      expect(parsed.authMode).toBe("pat");
      expect(parsed.token).toBe("ghp_my_pat_token");
    });

    it("exposes authMode select field and token password field with dependsOn", () => {
      const copilotDescriptor = createCopilotDescriptor();
      expect(copilotDescriptor.requiredFields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "authMode", type: "select" }),
          expect.objectContaining({
            key: "token",
            type: "password",
            dependsOn: { field: "authMode", value: "pat" },
          }),
        ])
      );
    });

    it("oauth config has dependsOn authMode oauth", () => {
      const copilotDescriptor = createCopilotDescriptor();
      expect(copilotDescriptor.oauth).toEqual(
        expect.objectContaining({
          dependsOn: { field: "authMode", value: "oauth" },
        })
      );
    });
  });

  describe("mock descriptor", () => {
    it("has correct metadata", () => {
      const desc = getPluginDescriptor("mock");
      expect(desc?.name).toBe("Mock Agent");
      expect(desc?.category).toBe("agent");
    });

    it("validates minimal mock config", () => {
      const result = mockDescriptor.configSchema.safeParse({});
      expect(result.success).toBe(true);
    });
  });
});
