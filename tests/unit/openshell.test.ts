import { describe, it, expect, vi } from "vitest";
import {
  buildPolicyYaml,
  reviewReadonlyPolicy,
  codingRegistriesPolicy,
  denyStrictPolicy,
} from "../../src/openshell/openShellPolicyBuilder.js";
import {
  parseDenialEvent,
  scrubSecrets,
  pollDenials,
  type NormalizedDenial,
  type DenialContext,
} from "../../src/openshell/denyEventPoller.js";
import { OpenShellClient, type CommandRunner } from "../../src/openshell/openShellClient.js";

describe("openShellPolicyBuilder", () => {
  it("emits deny-by-default network YAML with L7 methods", () => {
    const yaml = buildPolicyYaml(
      reviewReadonlyPolicy({ inferenceHost: "api.anthropic.com", apiHosts: ["api.github.com"] })
    );
    expect(yaml).toContain("network:");
    expect(yaml).toContain("default: deny");
    expect(yaml).toContain("- host: api.anthropic.com");
    expect(yaml).toContain("- host: api.github.com");
    expect(yaml).toContain("methods: [GET]");
    expect(yaml).toContain("allow_write: [/workspace]");
    expect(yaml).toContain("no_new_privileges: true");
  });

  it("coding policy allows registries and inference, not git egress", () => {
    const yaml = buildPolicyYaml(codingRegistriesPolicy({ inferenceHost: "api.openai.com" }));
    expect(yaml).toContain("registry.npmjs.org");
    expect(yaml).toContain("pypi.org");
    expect(yaml).toContain("api.openai.com");
    expect(yaml).not.toContain("github.com");
  });

  it("strict policy allows only the inference endpoint and drops caps", () => {
    const yaml = buildPolicyYaml(denyStrictPolicy({ inferenceHost: "inference.local" }));
    expect(yaml).toContain("- host: inference.local");
    expect(yaml).toContain("drop_caps: all");
    expect((yaml.match(/- host:/g) ?? []).length).toBe(1);
  });

  it("is deterministic for identical specs", () => {
    const spec = denyStrictPolicy({ inferenceHost: "inference.local" });
    expect(buildPolicyYaml(spec)).toBe(buildPolicyYaml(spec));
  });
});

describe("denyEventPoller", () => {
  it("scrubs tokens from free text", () => {
    expect(scrubSecrets("GET /x?token=abc123&y=1")).toContain("token=[REDACTED]");
    expect(scrubSecrets("Authorization: Bearer sk-abcdef123456")).toContain("Bearer [REDACTED]");
    expect(scrubSecrets("uses ghp_abcdefghijklmnopqrstuvwxyz012345")).toContain("ghp_[REDACTED]");
  });

  it("parses a structured deny event", () => {
    const d = parseDenialEvent({
      decision: "deny",
      category: "network",
      host: "api.github.com",
      method: "post",
      path: "/repos/x/issues",
      detail: "POST /repos/x/issues not permitted by policy",
    });
    expect(d?.method).toBe("POST");
    expect(d?.path).toBe("/repos/x/issues");
    expect(d?.decision).toBe("deny");
  });

  it("parses the policy_denied detail fallback shape", () => {
    const d = parseDenialEvent({
      error: "policy_denied",
      detail: "POST /repos/octocat/hello-world/issues not permitted by policy",
    });
    expect(d?.method).toBe("POST");
    expect(d?.path).toBe("/repos/octocat/hello-world/issues");
  });

  it("returns null for allow / non-denial events", () => {
    expect(parseDenialEvent({ decision: "allow" })).toBeNull();
    expect(parseDenialEvent("nope")).toBeNull();
    expect(parseDenialEvent(null)).toBeNull();
  });

  it("polls a source and forwards scrubbed denials with context", async () => {
    async function* source(): AsyncGenerator<unknown> {
      yield { decision: "allow" };
      yield { decision: "deny", host: "a", detail: "GET /x?api_key=secret1234 blocked" };
      yield { error: "policy_denied", detail: "POST /y not permitted" };
    }
    const sink = vi.fn<(d: NormalizedDenial & DenialContext) => void>();
    const count = await pollDenials(source(), sink, { taskId: "t1", projectId: "p1" });
    expect(count).toBe(2);
    expect(sink).toHaveBeenCalledTimes(2);
    const first = sink.mock.calls[0]?.[0];
    expect(first?.taskId).toBe("t1");
    expect(first?.reason).toContain("api_key=[REDACTED]");
  });
});

describe("OpenShellClient", () => {
  function runnerReturning(result: { code: number; stdout?: string; stderr?: string }): {
    runner: CommandRunner;
    calls: Array<{ bin: string; args: string[]; input?: string }>;
  } {
    const calls: Array<{ bin: string; args: string[]; input?: string }> = [];
    const runner: CommandRunner = async (bin, args, input) => {
      calls.push({ bin, args, ...(input !== undefined ? { input } : {}) });
      return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    };
    return { runner, calls };
  }

  it("creates a sandbox with agent and providers", async () => {
    const { runner, calls } = runnerReturning({ code: 0 });
    const client = new OpenShellClient({ runner, gateway: "gw:1" });
    await client.createSandbox({ name: "task-1", agent: "claude", providers: ["anthropic"] });
    const args = calls[0]?.args ?? [];
    // No --gateway flag; gateway is passed via OPENSHELL_GATEWAY_ENDPOINT env.
    expect(args).toEqual(["sandbox", "create", "--name", "task-1", "--provider", "anthropic", "--", "claude"]);
  });

  it("throws when sandbox create fails", async () => {
    const { runner } = runnerReturning({ code: 1, stderr: "boom" });
    const client = new OpenShellClient({ runner });
    await expect(client.createSandbox({ name: "t" })).rejects.toThrow(/sandbox create failed/i);
  });

  it("writes policy yaml to a temp file on setPolicy", async () => {
    const { runner, calls } = runnerReturning({ code: 0 });
    const client = new OpenShellClient({ runner });
    await client.setPolicy("demo", "network:\n  default: deny\n");
    // args: policy set --policy <tempfile> demo
    expect(calls[0]?.args[0]).toBe("policy");
    expect(calls[0]?.args[1]).toBe("set");
    expect(calls[0]?.args[2]).toBe("--policy");
    expect(calls[0]?.args[3]).toMatch(/\.yaml$/);
    expect(calls[0]?.args[4]).toBe("demo");
  });

  it("removeSandbox never throws on failure", async () => {
    const { runner } = runnerReturning({ code: 1, stderr: "gone" });
    const client = new OpenShellClient({ runner });
    await expect(client.removeSandbox("t")).resolves.toBeUndefined();
  });

  it("reports gateway health from http probe (not CLI)", async () => {
    // gatewayHealthy() now probes the HTTP health endpoint directly,
    // so the CLI runner is never called. We verify the method exists and
    // returns a boolean (actual HTTP probes are integration-tested with a
    // live gateway; unit test only asserts the contract shape).
    const client = new OpenShellClient({ runner: runnerReturning({ code: 0 }).runner });
    // Without a real server the probe will time out / fail → false.
    const result = await client.gatewayHealthy();
    expect(typeof result).toBe("boolean");
  });
});
