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
import { OpenShellClient, redactCommandArgs, redactOpenShellText, type CommandRunner } from "../../src/openshell/openShellClient.js";

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
    expect(yaml).toContain("allow_write: [/sandbox]");
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
    expect(scrubSecrets("Authorization: Bearer sk-abcdef123456")).toBe("Authorization: [REDACTED]");
    expect(scrubSecrets("uses ghp_abcdefghijklmnopqrstuvwxyz012345")).toContain("ghp_[REDACTED]");
    expect(scrubSecrets("ANTHROPIC_API_KEY=sk-ant-secret GITHUB_TOKEN=github-secret")).toBe(
      "ANTHROPIC_API_KEY=[REDACTED] GITHUB_TOKEN=[REDACTED]"
    );
    expect(scrubSecrets("Authorization: Basic dXNlcjpwYXNz Cookie: session=secret")).toBe(
      "Authorization: [REDACTED] Cookie: [REDACTED]"
    );
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

  it("parses OpenShell OCSF shorthand denial lines", () => {
    const d = parseDenialEvent(
      "[1775014132.690] [sandbox] [OCSF ] [ocsf] HTTP:POST [MED] DENIED POST http://api.github.com:443/repos/x/issues [policy:readonly engine:l7]"
    );
    expect(d).toMatchObject({
      category: "network",
      host: "api.github.com",
      method: "POST",
      path: "/repos/x/issues",
      decision: "deny",
    });
  });

  it("parses OpenShell key-value denial lines", () => {
    const d = parseDenialEvent(
      'l7_decision=deny dst_host=api.github.com l7_action=PUT l7_target=/repos/x?token=secret l7_deny_reason="PUT denied by policy"'
    );
    expect(d).toMatchObject({ host: "api.github.com", method: "PUT", decision: "deny" });
    expect(d?.path).toBe("/repos/x?token=[REDACTED]");
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

  it("redacts environment values from command arguments used in logs", () => {
    expect(redactCommandArgs([
      "sandbox", "create", "--env", "GITHUB_TOKEN=secret-token", "--env=API_KEY=other-secret", "--", "true",
    ])).toEqual([
      "sandbox", "create", "--env", "GITHUB_TOKEN=[REDACTED]", "--env=API_KEY=[REDACTED]", "--", "true",
    ]);
  });
  it("terminates a command that exceeds the client deadline", async () => {
    const runner: CommandRunner = async (_bin, _args, _input, _callbacks, control) =>
      new Promise((resolve) => {
        control?.signal?.addEventListener("abort", () => {
          resolve({ code: 1, stdout: "", stderr: "openshell command timed out" });
        }, { once: true });
      });
    const client = new OpenShellClient({ runner, commandTimeoutMs: 20 });

    await expect(client.createSandbox({ name: "t" }))
      .rejects.toThrow(/timed out/i);
  });

  it("redacts credentials echoed in OpenShell stderr", () => {
    const text = "GITHUB_TOKEN=secret-token Authorization: Bearer abc123 https://user:pass@example.com/repo";
    const redacted = redactOpenShellText(text);
    expect(redacted).not.toContain("secret-token");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("user:pass");
  });

  it("creates a sandbox with image, env, providers, and resource limits", async () => {
    const { runner, calls } = runnerReturning({ code: 0 });
    const client = new OpenShellClient({ runner, gateway: "gw:1" });
    await client.createSandbox({
      name: "task-1",
      from: "img:latest",
      env: { A: "1" },
      providers: ["anthropic"],
      cpu: "1",
      memory: "2Gi",
    });
    const args = calls[0]?.args ?? [];
    expect(args).toEqual([
      "sandbox", "create", "--name", "task-1",
      "--from", "img:latest", "--cpu", "1", "--memory", "2Gi",
      "--provider", "anthropic", "--env", "A=1",
      "--no-tty", "--", "true",
    ]);
  });

  it("passes the initial policy when creating a sandbox", async () => {
    const { runner, calls } = runnerReturning({ code: 0 });
    const client = new OpenShellClient({ runner });
    await client.createSandbox({
      name: "task-1",
      policyYaml: "filesystem:\n  allow_write: [/sandbox]\n",
    });

    const args = calls[0]?.args ?? [];
    const policyIndex = args.indexOf("--policy");
    expect(policyIndex).toBeGreaterThan(0);
    expect(args[policyIndex + 1]).toMatch(/ve-policy-.*\.yaml$/);
  });

  it("uploads with --no-git-ignore before positional NAME/LOCAL/DEST", async () => {
    const { runner, calls } = runnerReturning({ code: 0 });
    const client = new OpenShellClient({ runner });
    await client.uploadToSandbox({ name: "t", localPath: "/local", dest: "/workspace", noGitIgnore: true });
    expect(calls[0]?.args).toEqual(["sandbox", "upload", "--no-git-ignore", "t", "/local", "/workspace"]);
  });

  it("downloads a sandbox path to a local destination", async () => {
    const { runner, calls } = runnerReturning({ code: 0 });
    const client = new OpenShellClient({ runner });
    await client.downloadFromSandbox({ name: "t", sandboxPath: "/workspace", localDest: "/local" });
    expect(calls[0]?.args).toEqual(["sandbox", "download", "t", "/workspace", "/local"]);
  });

  it("retrieves a bounded sandbox log snapshot for denial collection", async () => {
    const { runner, calls } = runnerReturning({ code: 0, stdout: "DENIED" });
    const client = new OpenShellClient({ runner });
    const logs = await client.getSandboxLogs({ name: "t", lines: 200, since: "2h" });
    expect(calls[0]?.args).toEqual([
      "logs", "t", "-n", "200", "--since", "2h", "--source", "sandbox", "--level", "warn",
    ]);
    expect(logs).toBe("DENIED");
  });

  it("exec forwards workdir, timeout, and env before the -- command", async () => {
    const { runner, calls } = runnerReturning({ code: 0, stdout: "ok" });
    const client = new OpenShellClient({ runner });
    await client.execInSandbox({ name: "t", command: ["node", "x.js"], env: { K: "V" }, workdir: "/workspace", timeout: 60 });
    expect(calls[0]?.args).toEqual([
      "sandbox", "exec", "--no-tty", "--name", "t", "--workdir", "/workspace", "--timeout", "60", "--env", "K=V", "--", "node", "x.js",
    ]);
  });

  it("exec streams stdout and stderr chunks while preserving the final result", async () => {
    const observed: string[] = [];
    const runner: CommandRunner = async (_bin, _args, _input, callbacks) => {
      callbacks?.onStdoutChunk?.("out-1");
      callbacks?.onStderrChunk?.("err-1");
      callbacks?.onStdoutChunk?.("out-2");
      return { code: 0, stdout: "out-1out-2", stderr: "err-1" };
    };
    const client = new OpenShellClient({ runner });

    const result = await client.execInSandbox({
      name: "t",
      command: ["node", "x.js"],
      onStdoutChunk: (chunk) => observed.push(`stdout:${chunk}`),
      onStderrChunk: (chunk) => observed.push(`stderr:${chunk}`),
    });

    expect(observed).toEqual(["stdout:out-1", "stderr:err-1", "stdout:out-2"]);
    expect(result).toEqual({ code: 0, stdout: "out-1out-2", stderr: "err-1" });
  });

  it("upload throws when the CLI reports failure", async () => {
    const { runner } = runnerReturning({ code: 1, stderr: "boom" });
    const client = new OpenShellClient({ runner });
    await expect(client.uploadToSandbox({ name: "t", localPath: "a", dest: "b" })).rejects.toThrow(/upload failed/i);
  });

  it("allowEgress adds endpoints and binaries via incremental policy update", async () => {
    const { runner, calls } = runnerReturning({ code: 0 });
    const client = new OpenShellClient({ runner });
    await client.allowEgress({
      name: "ve-t",
      hosts: ["api.githubcopilot.com", "api.github.com"],
      binaries: ["/usr/local/bin/node", "/agent-worker/node_modules/@github/copilot-linux-x64/copilot"],
    });
    expect(calls[0]?.args).toEqual([
      "policy", "update",
      "--add-endpoint", "api.githubcopilot.com:443:full:rest",
      "--add-endpoint", "api.github.com:443:full:rest",
      "--binary", "/usr/local/bin/node",
      "--binary", "/agent-worker/node_modules/@github/copilot-linux-x64/copilot",
      "--wait", "ve-t",
    ]);
  });

  it("allowEgress honours a non-default access level", async () => {
    const { runner, calls } = runnerReturning({ code: 0 });
    const client = new OpenShellClient({ runner });
    await client.allowEgress({ name: "ve-t", hosts: ["api.github.com"], access: "read-only" });
    expect(calls[0]?.args).toEqual([
      "policy", "update", "--add-endpoint", "api.github.com:443:read-only:rest", "--wait", "ve-t",
    ]);
  });

  it("allowEgress is a no-op when no hosts are given", async () => {
    const { runner, calls } = runnerReturning({ code: 0 });
    const client = new OpenShellClient({ runner });
    await client.allowEgress({ name: "ve-t", hosts: [] });
    expect(calls).toHaveLength(0);
  });

  it("allowEgress throws when the CLI reports failure", async () => {
    const { runner } = runnerReturning({ code: 1, stderr: "boom" });
    const client = new OpenShellClient({ runner });
    await expect(client.allowEgress({ name: "ve-t", hosts: ["api.github.com"] })).rejects.toThrow(/egress/i);
  });

  it("throws when sandbox create fails", async () => {
    const { runner } = runnerReturning({ code: 1, stderr: "boom" });
    const client = new OpenShellClient({ runner });
    await expect(client.createSandbox({ name: "t" })).rejects.toThrow(/sandbox create failed/i);
  });

  it("retries sandbox create on a transient supervisor error, then succeeds", async () => {
    const calls: Array<{ args: string[] }> = [];
    let attempt = 0;
    const runner: CommandRunner = async (_bin, args) => {
      calls.push({ args });
      // First create attempt fails transiently; the cleanup delete succeeds;
      // the second create attempt succeeds.
      if (args[0] === "sandbox" && args[1] === "create") {
        attempt += 1;
        return attempt === 1
          ? { code: 1, stdout: "", stderr: "supervisor session not connected" }
          : { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const client = new OpenShellClient({ runner, retryBaseDelayMs: 0 });
    const beforeRetryCleanup = vi.fn().mockResolvedValue(undefined);
    await client.createSandbox({ name: "t", from: "img", beforeRetryCleanup });
    const createCalls = calls.filter((c) => c.args[1] === "create").length;
    const deleteCalls = calls.filter((c) => c.args[1] === "delete").length;
    expect(createCalls).toBe(2);
    expect(deleteCalls).toBe(1);
    expect(beforeRetryCleanup).toHaveBeenCalledOnce();
    const cleanupHookOrder = beforeRetryCleanup.mock.invocationCallOrder[0];
    expect(cleanupHookOrder).toBeDefined();
  });

  it.each([
    "supervisor session not connected",
    "supervisor relay failed",
    "service is currently unavailable",
    'message: "sandbox is not ready"',
    "kex_exchange_identification: Connection closed by remote host",
    "client_loop: send disconnect: Broken pipe",
    "ssh exited with status exit status: 255",
  ])("retries sandbox create on transient cold-start error: %s", async (stderr) => {
    let attempt = 0;
    const runner: CommandRunner = async (_bin, args) => {
      if (args[0] === "sandbox" && args[1] === "create") {
        attempt += 1;
        return attempt === 1 ? { code: 1, stdout: "", stderr } : { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const client = new OpenShellClient({ runner, retryBaseDelayMs: 0 });
    await client.createSandbox({ name: "t", from: "img" });
    expect(attempt).toBe(2);
  });

  it("does not retry sandbox create on a non-transient error", async () => {
    let creates = 0;
    const runner: CommandRunner = async (_bin, args) => {
      if (args[1] === "create") creates += 1;
      return { code: 1, stdout: "", stderr: "invalid image reference" };
    };
    const client = new OpenShellClient({ runner, retryBaseDelayMs: 0 });
    await expect(client.createSandbox({ name: "t", from: "img" })).rejects.toThrow(/sandbox create failed/i);
    expect(creates).toBe(1);
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

  it("removeSandbox retries and throws when deletion cannot be confirmed", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = async (_bin, args) => {
      calls.push(args);
      return { code: 1, stdout: "", stderr: "gateway unavailable" };
    };
    const client = new OpenShellClient({ runner, retryBaseDelayMs: 0 });

    await expect(client.removeSandbox("t")).rejects.toThrow(/delete.*gateway unavailable/i);
    expect(calls.filter((args) => args[1] === "delete")).toHaveLength(3);
  });

  it("checks gateway health through the authenticated OpenShell CLI profile", async () => {
    const { runner, calls } = runnerReturning({ code: 0, stdout: "Gateway connected" });
    const client = new OpenShellClient({ runner });
    await expect(client.gatewayHealthy()).resolves.toBe(true);
    expect(calls[0]?.args).toEqual(["status"]);
  });

  it("reports the gateway unhealthy when authenticated CLI status fails", async () => {
    const client = new OpenShellClient({ runner: runnerReturning({ code: 1 }).runner });
    await expect(client.gatewayHealthy()).resolves.toBe(false);
  });
});
