import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { SshChangeInfo } from "../../src/connectors/gerritSshClient.js";
import { GerritSshConnector } from "../../src/connectors/gerritConnector.js";
import { makeExternalChangeId } from "../../src/interfaces.js";

// ─── GerritSshClient mock ─────────────────────────────────────────────────────

const mockQuery = vi.fn(async (_args: string[]) => "");
const mockQueryChange = vi.fn(async (_changeId: string): Promise<SshChangeInfo> => ({
  number: 1,
  status: "NEW",
}));
const mockGetUnresolvedComments = vi.fn();
const mockResolveComments = vi.fn();

vi.mock("../../src/connectors/gerritSshClient.js", () => ({
  GerritSshClient: vi.fn().mockImplementation(function() {
    return {
      query: mockQuery,
      queryChange: mockQueryChange,
      getUnresolvedComments: mockGetUnresolvedComments,
      resolveComments: mockResolveComments,
    };
  }),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BASE_URL = "http://gerrit.test";
const SSH_CONFIG = { host: "gerrit.test", user: "ve", port: 29418, keyPath: "/key" };
const CHANGE_ID = makeExternalChangeId("myproject~master~I8473b95934b5732ac55d26311a706c9c2bde9940");

function makeChangeInfo(overrides: Partial<SshChangeInfo> = {}): SshChangeInfo {
  return {
    number: 42,
    status: "NEW",
    currentPatchSet: { number: 3, revision: "rev-3" },
    ...overrides,
  };
}

function makeConnector(): GerritSshConnector {
  return new GerritSshConnector({ ssh: SSH_CONFIG, baseUrl: BASE_URL });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GerritSshConnector", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQueryChange.mockReset();
    mockGetUnresolvedComments.mockReset();
    mockResolveComments.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("gets change details from queryChange result", async () => {
    mockQueryChange.mockResolvedValue(makeChangeInfo({ number: 42, currentPatchSet: { number: 3, revision: "rev-3" } }));

    const change = await makeConnector().getChange(CHANGE_ID);

    expect(change.changeNumber).toBe(42);
    expect(change.patchsetNumber).toBe(3);
    expect(change.url).toBe(`${BASE_URL}/c/42`);
  });

  it("maps Gerrit NEW status to OPEN", async () => {
    mockQueryChange.mockResolvedValue(makeChangeInfo({ status: "NEW" }));

    await expect(makeConnector().getChangeStatus(CHANGE_ID)).resolves.toBe("OPEN");
  });

  it("maps MERGED and ABANDONED statuses unchanged", async () => {
    mockQueryChange.mockResolvedValueOnce(makeChangeInfo({ status: "MERGED" }));
    mockQueryChange.mockResolvedValueOnce(makeChangeInfo({ status: "ABANDONED" }));

    await expect(makeConnector().getChangeStatus(CHANGE_ID)).resolves.toBe("MERGED");
    await expect(makeConnector().getChangeStatus(CHANGE_ID)).resolves.toBe("ABANDONED");
  });

  it("delegates getUnresolvedComments to the SSH client with sincePatchset", async () => {
    const fakeComments = [{ id: "c1", author: "a@b.com", message: "Fix", unresolved: true, patchset: 3, updatedAt: new Date() }];
    mockGetUnresolvedComments.mockResolvedValue(fakeComments);

    const comments = await makeConnector().getUnresolvedComments(CHANGE_ID, 3);

    expect(comments).toBe(fakeComments);
    expect(mockGetUnresolvedComments).toHaveBeenCalledWith(CHANGE_ID, 3);
  });

  it("posts change comments through gerrit review over SSH", async () => {
    mockQueryChange.mockResolvedValue(makeChangeInfo({ number: 42, currentPatchSet: { number: 2, revision: "rev-2" } }));
    mockQuery.mockResolvedValue("");

    await makeConnector().addChangeComment(CHANGE_ID, "Looks good");

    expect(mockQuery).toHaveBeenCalledWith(
      expect.arrayContaining(["review", "--message", "Looks good", "42,2"])
    );
  });

  it("delegates resolveComments to the SSH client", async () => {
    mockResolveComments.mockResolvedValue(undefined);
    const comments = [{ id: "c1", author: "r@x.com", message: "Fix", filePath: "src/main.ts", line: 9, unresolved: true, patchset: 1, updatedAt: new Date() }];

    await makeConnector().resolveComments(CHANGE_ID, comments);

    expect(mockResolveComments).toHaveBeenCalledWith(CHANGE_ID, comments);
  });

  it("builds a fallback URL when baseUrl is not set", async () => {
    mockQueryChange.mockResolvedValue(makeChangeInfo({ number: 42 }));
    const connector = new GerritSshConnector({ ssh: SSH_CONFIG });

    const change = await connector.getChange(CHANGE_ID);

    expect(change.url).toContain("42");
  });
});
