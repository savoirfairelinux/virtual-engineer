import { describe, it, expect, vi, afterEach } from "vitest";
import { listRepositoriesViaSsh } from "../../src/connectors/gerritConnector.js";

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
  keyPath: "/secrets/gerrit_id_ed25519",
};

describe("listRepositoriesViaSsh", () => {
  afterEach(() => {
    vi.clearAllMocks();
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
    expect(args).toContain("/secrets/gerrit_id_ed25519");
    expect(args).toContain("ve-bot@gerrit.test");
    expect(args).toContain("gerrit");
    expect(args).toContain("ls-projects");
    expect(args).toContain("--format");
    expect(args).toContain("JSON");
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
