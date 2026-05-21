import { execFile } from "child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listRepositoriesViaSsh } from "../../src/connectors/gerritConnector.js";

vi.mock("child_process", () => ({ execFile: vi.fn() }));

type ExecFileCallback = (error: Error | null, result: { stdout: string; stderr: string }) => void;

function getExecFileMock(): ReturnType<typeof vi.fn> {
  return execFile as unknown as ReturnType<typeof vi.fn>;
}

function mockExec(stdout: string): void {
  getExecFileMock().mockImplementationOnce(
    (_file: unknown, _args: unknown, _options: unknown, callback: ExecFileCallback) => {
      callback(null, { stdout, stderr: "" });
      return undefined;
    }
  );
}

describe("listRepositoriesViaSsh", () => {
  beforeEach(() => {
    getExecFileMock().mockReset();
  });

  it("normalizes active repositories and default branches", async () => {
    mockExec(JSON.stringify({
      "demo-project": { state: "ACTIVE", HEAD: "refs/heads/main" },
      "another-repo": { state: "ACTIVE" },
    }));

    const repos = await listRepositoriesViaSsh({
      host: "gerrit.test",
      user: "ve",
      port: 29418,
      keyPath: "/key",
    });

    expect(repos).toEqual([
      {
        key: "demo-project",
        name: "demo-project",
        cloneUrlSsh: "ssh://ve@gerrit.test:29418/demo-project",
        defaultBranch: "main",
      },
      {
        key: "another-repo",
        name: "another-repo",
        cloneUrlSsh: "ssh://ve@gerrit.test:29418/another-repo",
      },
    ]);
  });

  it("skips hidden and read-only repositories", async () => {
    mockExec(JSON.stringify({
      active: { state: "ACTIVE" },
      ro: { state: "READ_ONLY" },
      hidden: { state: "HIDDEN" },
    }));

    const repos = await listRepositoriesViaSsh({
      host: "gerrit.test",
      user: "ve",
      port: 29418,
      keyPath: "/key",
    });

    expect(repos.map((repo) => repo.key)).toEqual(["active"]);
  });

  it("throws when Gerrit returns invalid JSON", async () => {
    mockExec("not-json");

    await expect(listRepositoriesViaSsh({
      host: "gerrit.test",
      user: "ve",
      port: 29418,
      keyPath: "/key",
    })).rejects.toThrow(/non-JSON output/);
  });
});
