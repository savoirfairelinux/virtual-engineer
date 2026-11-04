import { describe, it, expect, vi, afterEach } from "vitest";
import { listBranchesViaSsh, listRepositoriesViaSsh } from "../../src/connectors/gerritConnector.js";

// We mock child_process.execFile so the tests never touch a real SSH host.
vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "child_process";

// Capture the promisified version that the module uses internally.
// Because we mock execFile before the module loads, the promisified wrapper
// inside gerritConnector.ts will call our mock.
const mockedExecFile = vi.mocked(execFile);

function makeExecFileResolve(stdout: string) {
  // execFile callback signature: (err, stdout, stderr) => void
  mockedExecFile.mockImplementationOnce((_cmd, _args, _opts, cb: unknown) => {
    (cb as (err: null, result: { stdout: string; stderr: string }) => void)(
      null,
      { stdout, stderr: "" }
    );
    return {} as ReturnType<typeof execFile>;
  });
}

function makeExecFileReject(message: string) {
  mockedExecFile.mockImplementationOnce((_cmd, _args, _opts, cb: unknown) => {
    (cb as (err: Error) => void)(new Error(message));
    return {} as ReturnType<typeof execFile>;
  });
}

const SSH_CONFIG = {
  host: "gerrit.test",
  user: "ve-bot",
  port: 29418,
  keyPath: "/tmp/gerrit_id_ed25519",
  knownHostsPath: "/tmp/known_hosts",
};

describe("listRepositoriesViaSsh", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockedExecFile.mockReset();
  });

  it("returns discovered repositories from JSON output", async () => {
    const payload = JSON.stringify({
      "demo-project": { state: "ACTIVE", HEAD: "refs/heads/main" },
      "lib-core": { state: "ACTIVE" },
    });
    makeExecFileResolve(payload);

    const repos = await listRepositoriesViaSsh(SSH_CONFIG);

    expect(repos).toEqual([
      {
        key: "demo-project",
        name: "demo-project",
        cloneUrlSsh: "ssh://ve-bot@gerrit.test:29418/demo-project",
        defaultBranch: "main",
      },
      {
        key: "lib-core",
        name: "lib-core",
        cloneUrlSsh: "ssh://ve-bot@gerrit.test:29418/lib-core",
      },
    ]);
  });

  it("passes correct ssh arguments", async () => {
    makeExecFileResolve(JSON.stringify({}));
    await listRepositoriesViaSsh(SSH_CONFIG);

    const call = mockedExecFile.mock.calls[0] as unknown as [string, string[]];
    const [cmd, args] = call;
    expect(cmd).toBe("ssh");
    expect(args).toContain("-p");
    expect(args).toContain("29418");
    expect(args).toContain("-i");
    expect(args).toContain("/tmp/gerrit_id_ed25519");
    expect(args.slice(-8)).toEqual([
      "-l", "ve-bot", "--", "gerrit.test",
      "gerrit", "ls-projects", "--format", "JSON",
    ]);
  });

  it.each([
    { user: "-oProxyCommand=ignored" },
    { host: "-oProxyCommand=ignored" },
    { user: "ve bot" },
    { host: "gerrit.test\n" },
    { user: "ve\u0000" },
    { host: "gerrit.test\u007f" },
  ])("rejects unsafe identities before starting a process: %j", async (identity) => {
    makeExecFileResolve("{}");

    await expect(listRepositoriesViaSsh({ ...SSH_CONFIG, ...identity })).rejects.toThrow(/SSH identity/);

    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it.each(["2001:db8::1", "[2001:db8::1]"])("discovers repositories over IPv6 host %s with a valid SSH clone URL", async (host) => {
    makeExecFileResolve(JSON.stringify({ demo: { state: "ACTIVE" } }));

    const repos = await listRepositoriesViaSsh({ ...SSH_CONFIG, host });

    expect(repos[0]?.cloneUrlSsh).toBe("ssh://ve-bot@[2001:db8::1]:29418/demo");
    expect(mockedExecFile).toHaveBeenCalledWith(
      "ssh",
      expect.arrayContaining(["-l", "ve-bot", "--", "2001:db8::1"]),
      expect.anything(),
      expect.any(Function),
    );
  });

  it("skips READ_ONLY and HIDDEN projects", async () => {
    makeExecFileResolve(
      JSON.stringify({
        active: { state: "ACTIVE" },
        ro: { state: "READ_ONLY" },
        hidden: { state: "HIDDEN" },
      })
    );

    const repos = await listRepositoriesViaSsh(SSH_CONFIG);
    expect(repos.map((r) => r.key)).toEqual(["active"]);
  });

  it("returns empty array when no projects exist", async () => {
    makeExecFileResolve(JSON.stringify({}));
    const repos = await listRepositoriesViaSsh(SSH_CONFIG);
    expect(repos).toEqual([]);
  });

  it("strips refs/heads/ prefix from HEAD", async () => {
    makeExecFileResolve(
      JSON.stringify({ x: { state: "ACTIVE", HEAD: "refs/heads/develop" } })
    );
    const repos = await listRepositoriesViaSsh(SSH_CONFIG);
    expect(repos[0]?.defaultBranch).toBe("develop");
  });

  it("keeps HEAD as-is when it doesn't start with refs/heads/", async () => {
    makeExecFileResolve(
      JSON.stringify({ x: { state: "ACTIVE", HEAD: "develop" } })
    );
    const repos = await listRepositoriesViaSsh(SSH_CONFIG);
    expect(repos[0]?.defaultBranch).toBe("develop");
  });

  it("throws a descriptive error when SSH output is not JSON", async () => {
    makeExecFileResolve("Not JSON output from gerrit");
    await expect(listRepositoriesViaSsh(SSH_CONFIG)).rejects.toThrow(
      /non-JSON output/
    );
  });

  it("propagates SSH command errors (e.g. auth failure)", async () => {
    makeExecFileReject("ssh: connect to host gerrit.test port 29418: Connection refused");
    await expect(listRepositoriesViaSsh(SSH_CONFIG)).rejects.toThrow(
      /Connection refused/
    );
  });
});

describe("listBranchesViaSsh", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockedExecFile.mockReset();
  });

  it.each([
    { user: "-oProxyCommand=ignored" },
    { host: "-oProxyCommand=ignored" },
    { user: "ve bot" },
    { host: "gerrit.test\n" },
  ])("rejects unsafe identities before starting Git: %j", async (identity) => {
    makeExecFileResolve("");

    await expect(listBranchesViaSsh({ ...SSH_CONFIG, ...identity }, "demo")).rejects.toThrow(/SSH identity/);

    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("uses shared login options and an IPv6 repository URL", async () => {
    makeExecFileResolve("abc\trefs/heads/main\ndef\trefs/heads/feature\n");

    await expect(listBranchesViaSsh({ ...SSH_CONFIG, host: "2001:db8::1" }, "demo")).resolves.toEqual(["main", "feature"]);

    expect(mockedExecFile).toHaveBeenCalledWith(
      "git",
      ["ls-remote", "--heads", "ssh://ve-bot@[2001:db8::1]:29418/demo"],
      expect.objectContaining({
        env: expect.objectContaining({ GIT_SSH_COMMAND: expect.stringContaining("'-l' 've-bot'") }),
      }),
      expect.any(Function),
    );
  });
});
